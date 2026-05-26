import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { Text } from "../deps.js";
import type { ChainNode, ChainOutputKind, ChainStepNode, LoadedChain, LoadedSkill } from "./types.js";
import { buildStepPrompt, interpolateText, previewResult } from "./render.js";
import { showChainReview, type ChainReviewResult } from "../review/index.js";

const STATE_TYPE = "chains-state";
const CONTROL_TYPE = "chains-control";
const ADVANCE_TYPE = "chains-advance";
const PIECE_START_TYPE = "chains-piece-start";
const EVENT_TYPE = "chains-event";

type ChainMode = "awaiting-input" | "running" | "waiting-review" | "interrupted" | "completed" | "inactive";

type FrameKind = "root" | "loop";

interface FrameSnapshot {
	kind: FrameKind;
	nodeId: string;
	index: number;
	iteration: number;
}

interface ReviewSnapshot {
	targetId: string;
	targetKind: "step" | "block";
	summary: string;
	feedback?: string;
}

interface ChainSnapshot {
	chainName: string;
	mode: ChainMode;
	rootInput?: string;
	results: Record<string, unknown>;
	stack: FrameSnapshot[];
	currentNodeId?: string;
	pendingReview?: ReviewSnapshot;
	activePieceStepId?: string;
}

interface ToolResultLike {
	toolName: string;
	details?: unknown;
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: Array<{ type: string; text?: string }> } {
	return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

function getAssistantText(message: unknown): string {
	if (!isAssistantMessage(message)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function normalizeArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function normalizeResult(kind: ChainOutputKind, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (kind === "text") {
		if (!trimmed) return { ok: true, value: { text: "" } };
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed) as Record<string, unknown>;
				if (typeof parsed.text === "string") return { ok: true, value: { text: parsed.text } };
			} catch {
				// fallback below
			}
		}
		return { ok: true, value: { text: raw } };
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return { ok: false, error: `expected JSON for ${kind}` };
	}

	if (kind === "findings") {
		const files = normalizeArray(parsed.files);
		const insights = normalizeArray(parsed.insights);
		if (typeof parsed.summary !== "string" || !files || !insights) {
			return { ok: false, error: "findings requires summary, files[] and insights[]" };
		}
		return { ok: true, value: { summary: parsed.summary, files, insights } };
	}

	if (kind === "plan") {
		if (typeof parsed.title !== "string" || !Array.isArray(parsed.phases)) {
			return { ok: false, error: "plan requires title and phases[]" };
		}
		for (const phase of parsed.phases) {
			if (!phase || typeof phase !== "object") return { ok: false, error: "plan phases must be objects" };
			const value = phase as Record<string, unknown>;
			if (typeof value.name !== "string" || !Array.isArray(value.steps) || !value.steps.every((step) => typeof step === "string")) {
				return { ok: false, error: "plan phases must have name and string steps[]" };
			}
		}
		if (parsed.context !== undefined && typeof parsed.context !== "string") {
			return { ok: false, error: "plan context must be a string" };
		}
		return {
			ok: true,
			value: {
				title: parsed.title,
				phases: parsed.phases,
				...(typeof parsed.context === "string" ? { context: parsed.context } : {}),
			},
		};
	}

	if (kind === "review") {
		if (parsed.decision !== "continue" && parsed.decision !== "redefine") {
			return { ok: false, error: "review requires decision=continue|redefine" };
		}
		if (typeof parsed.summary !== "string") return { ok: false, error: "review requires summary" };
		if (parsed.feedback !== undefined && typeof parsed.feedback !== "string") {
			return { ok: false, error: "review feedback must be a string" };
		}
		return {
			ok: true,
			value: {
				decision: parsed.decision,
				summary: parsed.summary,
				...(typeof parsed.feedback === "string" ? { feedback: parsed.feedback } : {}),
			},
		};
	}

	if (kind === "report") {
		const artifacts = normalizeArray(parsed.artifacts);
		const notes = normalizeArray(parsed.notes);
		if (typeof parsed.summary !== "string" || !artifacts || !notes) {
			return { ok: false, error: "report requires summary, artifacts[] and notes[]" };
		}
		return { ok: true, value: { summary: parsed.summary, artifacts, notes } };
	}

	return { ok: false, error: `unsupported output kind ${kind}` };
}

function fallbackResult(kind: ChainOutputKind, text: string): unknown {
	const trimmed = text.trim();
	if (kind === "text") return { text: trimmed };
	if (kind === "findings") return { summary: trimmed, files: [], insights: [] };
	if (kind === "plan") return { title: "Plan", phases: trimmed ? [{ name: "Plan", steps: [trimmed] }] : [], context: undefined };
	if (kind === "review") {
		const decision = trimmed.includes("redefine") ? "redefine" : "continue";
		return { decision, summary: trimmed || "No summary", ...(decision === "redefine" ? { feedback: trimmed } : {}) };
	}
	return { summary: trimmed, artifacts: [], notes: [] };
}

function cloneState(state: ChainSnapshot): ChainSnapshot {
	return JSON.parse(JSON.stringify(state)) as ChainSnapshot;
}

export class ChainRuntime {
	private chains = new Map<string, LoadedChain>();
	private skills = new Map<string, LoadedSkill>();
	private state: ChainSnapshot | undefined;
	private reviewResumeInFlight = false;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	setResources(chains: LoadedChain[], skills: Map<string, LoadedSkill>, ctx: ExtensionContext): void {
		this.chains = new Map(chains.map((chain) => [chain.name, chain]));
		this.skills = skills;
		this.restoreStateFromSession(ctx);
		this.renderHud(ctx);
		void this.resumeWaitingReview(ctx);
	}

	registerTools(): void {
		const chainReturnParameters = {
			type: "object",
			properties: {
				payload: { type: "string" },
			},
			required: ["payload"],
			additionalProperties: false,
		} as const;

		this.pi.registerTool({
			name: "chain_return",
			label: "Chain return",
			description: "Submit the current chain step result as JSON.",
			parameters: chainReturnParameters as never,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const payload = params as { payload: string };
				const activeLeaf = this.getCurrentLeaf();
				if (!this.state || !activeLeaf) {
					return {
						content: [{ type: "text", text: "chain_return is only available while a chain is active" }],
						details: undefined,
						isError: true,
					};
				}

				const normalized = normalizeResult(activeLeaf.output.kind, payload.payload);
				if (!normalized.ok) {
					return {
						content: [{ type: "text", text: normalized.error }],
						details: undefined,
						isError: true,
					};
				}

				this.state.results[activeLeaf.id] = normalized.value;
				this.state.currentNodeId = activeLeaf.id;
				this.persistState();
				this.renderHud(ctx);
				return {
					content: [{ type: "text", text: "Stored chain result." }],
					details: normalized.value,
					isError: false,
				};
			},
		});
	}

	getAvailableChains(): LoadedChain[] {
		return [...this.chains.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	getState(): ChainSnapshot | undefined {
		return this.state;
	}

	buildContextMessages(messages: unknown[]): unknown[] {
		if (!this.state || this.state.mode === "inactive" || this.state.mode === "completed") {
			return messages.filter((message) => {
				const customType = (message as { customType?: string }).customType;
				return customType !== CONTROL_TYPE && customType !== ADVANCE_TYPE && customType !== PIECE_START_TYPE && customType !== EVENT_TYPE;
			});
		}

		let pieceStartIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; customType?: string; details?: { chainName?: string } } | undefined;
			if (message?.role !== "custom") continue;
			if (message.customType !== PIECE_START_TYPE) continue;
			if (message.details?.chainName !== this.state.chainName) continue;
			pieceStartIndex = i;
			break;
		}

		if (pieceStartIndex < 0) return [];

		return messages.slice(pieceStartIndex + 1).filter((message) => {
			const customType = (message as { customType?: string }).customType;
			return customType !== CONTROL_TYPE && customType !== ADVANCE_TYPE && customType !== PIECE_START_TYPE && customType !== EVENT_TYPE;
		});
	}

	private emitEvent(content: string, details?: Record<string, unknown>): void {
		if (!this.state) return;
		this.pi.sendMessage(
			{
				customType: EVENT_TYPE,
				content,
				display: true,
				details: { chainName: this.state.chainName, ...details },
			},
			{ triggerTurn: false },
		);
	}

	private summarizeResult(value: unknown): string {
		const preview = previewResult(value).replace(/\s+/g, " ").trim();
		return preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
	}

	private announceStepStart(step: ChainStepNode): void {
		const tools = step.tools?.allow.length ? ` | tools: ${step.tools.allow.join(", ")}` : "";
		this.emitEvent(`▶ step start: ${step.id} (${step.agent}) → ${step.output.kind}${tools}`, {
			event: "step-start",
			stepId: step.id,
			agent: step.agent,
			outputKind: step.output.kind,
			tools: step.tools?.allow,
		});
	}

	private announceStepComplete(step: ChainStepNode, result: unknown): void {
		this.emitEvent(`✓ step complete: ${step.id} → ${this.summarizeResult(result)}`, {
			event: "step-complete",
			stepId: step.id,
			result,
		});
	}

	private appendPieceMarker(stepId: string | undefined): void {
		if (!this.state) return;
		this.pi.sendMessage(
			{
				customType: PIECE_START_TYPE,
				content: stepId ? `↺ piece:${stepId}` : "↺ piece:start",
				display: false,
				details: { chainName: this.state.chainName, stepId },
			},
			{ triggerTurn: false },
		);
		this.state.activePieceStepId = stepId;
		this.persistState();
	}

	private async continueAfterLeaf(ctx: ExtensionContext): Promise<void> {
		if (!this.state) return;
		const top = this.state.stack[this.state.stack.length - 1];
		if (top) top.index += 1;
		await this.resolveCompletedFrames(ctx);
		if (!this.state || this.state.mode === "completed") return;
		const nextLeaf = this.getCurrentLeaf();
		if (nextLeaf) {
			this.appendPieceMarker(nextLeaf.id);
			this.announceStepStart(nextLeaf);
		}
		this.scheduleControlTurn(ADVANCE_TYPE);
	}

	private async resumeWaitingReview(ctx: ExtensionContext): Promise<void> {
		if (!this.state || this.state.mode !== "waiting-review" || !this.state.pendingReview || this.reviewResumeInFlight) {
			return;
		}

		this.reviewResumeInFlight = true;
		try {
			const pending = this.state.pendingReview;
			this.emitEvent(`↺ review resume: ${pending.targetId}`, {
				event: "review-resume",
				targetId: pending.targetId,
				targetKind: pending.targetKind,
				summary: pending.summary,
			});
			const review = await this.promptReview(ctx, pending.targetId, pending.summary);
			if (!review || !this.state?.pendingReview || this.state.mode !== "waiting-review") return;
			this.emitEvent(
				review.decision === "redefine" ? `↻ review redefine: ${pending.targetId}` : `✓ review continue: ${pending.targetId}`,
				{
					event: "review-decision",
					targetId: pending.targetId,
					targetKind: pending.targetKind,
					decision: review.decision,
					feedback: review.feedback,
				},
			);

			if (pending.targetKind === "step") {
				if (review.decision === "redefine") {
					this.state.pendingReview.feedback = review.feedback;
					this.state.mode = "running";
					this.persistState();
					this.renderHud(ctx);
					this.scheduleControlTurn(CONTROL_TYPE);
					return;
				}

				this.state.pendingReview = undefined;
				this.state.mode = "running";
				this.persistState();
				this.renderHud(ctx);
				await this.continueAfterLeaf(ctx);
				return;
			}

			const chain = this.getChain();
			const frame = this.state.stack[this.state.stack.length - 1];
			if (!chain || !frame || frame.nodeId !== pending.targetId) return;
			const blockNode = chain.allNodes.get(frame.nodeId);
			if (!blockNode || !("loop" in blockNode)) return;

			const canRedefine = !(frame.kind === "loop" && frame.iteration + 1 >= blockNode.loop.max_iterations);
			if (review.decision === "redefine" && canRedefine) {
				frame.index = 0;
				if (frame.kind === "loop") frame.iteration += 1;
				this.state.pendingReview.feedback = review.feedback;
				this.state.mode = "running";
				this.persistState();
				this.emitEvent(`↺ loop retry: ${blockNode.id} (${frame.iteration + 1}/${blockNode.loop.max_iterations})`, {
					event: "loop-retry",
					targetId: blockNode.id,
					iteration: frame.iteration + 1,
					maxIterations: blockNode.loop.max_iterations,
					feedback: review.feedback,
				});
				this.renderHud(ctx);
				this.scheduleControlTurn(CONTROL_TYPE);
				return;
			}

			if (review.decision === "redefine" && !canRedefine) {
				ctx.ui.notify(`Loop "${pending.targetId}" reached max_iterations; continuing.`, "info");
			}

			this.state.pendingReview = undefined;
			this.state.mode = "running";
			this.persistState();
			this.renderHud(ctx);
			this.state.stack.pop();
			const parent = this.state.stack[this.state.stack.length - 1];
			if (parent) parent.index += 1;
			await this.resolveCompletedFrames(ctx);
			const currentMode = (this.state as { mode?: string } | undefined)?.mode;
			const isCompleted = currentMode === "completed";
			if (!this.state || isCompleted) return;
			const nextLeaf = this.getCurrentLeaf();
			if (nextLeaf) {
				this.appendPieceMarker(nextLeaf.id);
				this.announceStepStart(nextLeaf);
			}
			this.scheduleControlTurn(ADVANCE_TYPE);
		} finally {
			this.reviewResumeInFlight = false;
		}
	}

	activate(chainName: string, ctx: ExtensionCommandContext): boolean {
		const chain = this.chains.get(chainName);
		if (!chain || chain.validationErrors.length > 0) return false;

		this.state = {
			chainName,
			mode: "awaiting-input",
			results: {},
			stack: [{ kind: "root", nodeId: "root", index: 0, iteration: 0 }],
			activePieceStepId: undefined,
		};
		this.persistState();
		this.appendPieceMarker(undefined);
		this.emitEvent(`⛓ chain armed: ${chainName}`, { event: "chain-armed" });
		this.renderHud(ctx);
		return true;
	}

	deactivate(ctx: ExtensionCommandContext): void {
		if (!this.state) return;
		this.emitEvent(`⏹ chain off: ${this.state.chainName}`, { event: "chain-off" });
		this.state.mode = "inactive";
		this.state.pendingReview = undefined;
		this.state.currentNodeId = undefined;
		this.state.activePieceStepId = undefined;
		this.persistState();
		this.renderHud(ctx);
	}

	async handleSessionStart(_ctx: ExtensionContext): Promise<void> {
		// Session refresh is handled by setResources().
	}

	async handleSessionShutdown(ctx: ExtensionContext): Promise<void> {
		if (this.state && this.state.mode === "running") {
			this.emitEvent(`⚠ chain interrupted: ${this.state.chainName}`, { event: "chain-interrupted" });
			this.state.mode = "interrupted";
			this.persistState();
		}
		this.renderHud(ctx);
	}

	getCurrentLeaf(): ChainStepNode | undefined {
		return this.ensureCurrentLeaf();
	}

	async handleBeforeAgentStart(event: { prompt: string; systemPrompt: string }, ctx: ExtensionContext): Promise<{ systemPrompt?: string } | undefined> {
		if (!this.state || this.state.mode === "inactive" || this.state.mode === "completed") return undefined;
		const chain = this.getChain();
		if (!chain) return undefined;

		const leaf = this.getCurrentLeaf();
		if (!leaf) return undefined;

		if (this.state.mode === "awaiting-input") {
			this.state.rootInput = event.prompt;
			this.emitEvent(`▶ chain start: ${this.state.chainName}`, {
				event: "chain-start",
				input: this.state.rootInput,
			});
			if (this.state.activePieceStepId === undefined) {
				this.appendPieceMarker(leaf.id);
				this.announceStepStart(leaf);
			}
		} else if (this.state.activePieceStepId !== leaf.id) {
			this.appendPieceMarker(leaf.id);
			this.announceStepStart(leaf);
		}
		this.state.mode = "running";
		this.state.currentNodeId = leaf.id;
		this.persistState();
		this.renderHud(ctx);

		const interpolatedTask = interpolateText(leaf.task, {
			input: this.state.rootInput ?? event.prompt,
			prev: this.getPrevResult(),
			steps: this.state.results,
		});
		const prompt = buildStepPrompt({
			chain,
			step: leaf,
			task: interpolatedTask,
			input: this.state.rootInput ?? event.prompt,
			prev: this.getPrevResult(),
			results: this.state.results,
			skillMap: this.skills,
			feedback: this.state.pendingReview?.feedback,
		});
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	}

	async handleToolCall(event: ToolCallEvent): Promise<{ block?: boolean; reason?: string } | undefined> {
		if (event.toolName === "chain_return") {
			if (!this.state || !this.getCurrentLeaf()) {
				return { block: true, reason: "chain_return is only available while a chain is active" };
			}
			return;
		}

		const leaf = this.getCurrentLeaf();
		if (!this.state || !leaf?.tools) return;
		if (!leaf.tools.allow.includes(event.toolName)) {
			return { block: true, reason: `tool "${event.toolName}" is not allowed in chain step "${leaf.id}"` };
		}
	}

	async handleToolResult(_event: ToolResultEvent): Promise<void> {
		// chain_return stores its details directly from the tool execute result
	}

	async handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
		if (!this.state || this.state.mode === "inactive" || this.state.mode === "completed") return;
		const leaf = this.getCurrentLeaf();
		if (!leaf) return;

		const result = this.extractResultFromTurn(event, leaf);
		if (result === undefined) return;
		this.state.results[leaf.id] = result;
		this.state.currentNodeId = leaf.id;
		this.persistState();
		this.announceStepComplete(leaf, result);
		this.renderHud(ctx);

		if (ctx.hasPendingMessages()) {
			return;
		}

		await this.advanceAfterLeaf(ctx, leaf);
	}

	private restoreStateFromSession(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		const snapshot = [...entries]
			.reverse()
			.find((entry: { type: string; customType?: string; data?: unknown }) => entry.type === "custom" && entry.customType === STATE_TYPE) as
			| { data?: ChainSnapshot }
			| undefined;

		if (!snapshot?.data || typeof snapshot.data !== "object") {
			this.state = undefined;
			return;
		}

		const restored = cloneState(snapshot.data);
		if (!this.chains.has(restored.chainName)) {
			this.state = undefined;
			return;
		}
		if (restored.mode === "running") restored.mode = "interrupted";
		this.state = restored;
	}

	private persistState(): void {
		if (!this.state) return;
		this.pi.appendEntry(STATE_TYPE, cloneState(this.state));
	}

	private renderHud(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!this.state || this.state.mode === "inactive") {
			ctx.ui.setWidget("chains-hud", undefined, { placement: "aboveEditor" });
			ctx.ui.setStatus("chains", undefined);
			return;
		}

		const chain = this.chains.get(this.state.chainName);
		if (!chain) {
			ctx.ui.setWidget("chains-hud", undefined, { placement: "aboveEditor" });
			ctx.ui.setStatus("chains", undefined);
			return;
		}
		ctx.ui.setWidget(
			"chains-hud",
			(_tui, theme) => {
				const items: string[] = [];
				const activeId = this.state?.currentNodeId;
				const flatNodes: Array<{ node: ChainNode; kind: "step" | "loop" }> = [];

				const collect = (node: ChainNode): void => {
					if ("agent" in node) {
						flatNodes.push({ node, kind: "step" });
						return;
					}
					flatNodes.push({ node, kind: "loop" });
					for (const child of node.loop.steps) collect(child);
				};

				for (const node of chain.steps) collect(node);

				for (const item of flatNodes) {
					if (item.kind === "step") {
						const label = `${activeId === item.node.id ? "›" : "•"} ${item.node.id}`;
						items.push(activeId === item.node.id ? theme.fg("accent", label) : theme.fg("dim", label));
						continue;
					}
					items.push(theme.fg("muted", `• ${item.node.id} [loop x${(item.node as Extract<ChainNode, { loop: unknown }>).loop.max_iterations}]`));
				}

				return new Text(items.join("  "), 0, 0);
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setStatus("chains", `${this.state.chainName}:${this.state.mode}`);
	}

	private getChain(): LoadedChain | undefined {
		if (!this.state) return undefined;
		return this.chains.get(this.state.chainName);
	}

	private frameChildren(frame: FrameSnapshot, chain: LoadedChain): ChainNode[] {
		if (frame.kind === "root") return chain.steps;
		const node = chain.allNodes.get(frame.nodeId);
		if (!node) return [];
		if (frame.kind === "loop" && "loop" in node) return node.loop.steps;
		return [];
	}

	private getPrevResult(): unknown {
		if (!this.state) return undefined;
		const keys = Object.keys(this.state.results);
		const lastKey = keys[keys.length - 1];
		return lastKey ? this.state.results[lastKey] : undefined;
	}

	private ensureCurrentLeaf(): ChainStepNode | undefined {
		const chain = this.getChain();
		if (!chain || !this.state) return undefined;

		while (true) {
			const frame = this.state.stack[this.state.stack.length - 1];
			if (!frame) return undefined;
			const child = this.frameChildren(frame, chain)[frame.index];
			if (!child) return undefined;
			if ("agent" in child) {
				this.state.currentNodeId = child.id;
				return child;
			}
			if ("loop" in child) {
				this.state.stack.push({ kind: "loop", nodeId: child.id, index: 0, iteration: 0 });
				continue;
			}
			return undefined;
		}
	}

	private extractResultFromTurn(event: TurnEndEvent, leaf: ChainStepNode): unknown | undefined {
		const chainReturn = event.toolResults.find((result) => result.toolName === "chain_return") as
			| ToolResultLike
			| undefined;
		if (chainReturn?.details !== undefined) return chainReturn.details;

		const text = getAssistantText(event.message);
		if (!text) return undefined;
		const normalized = normalizeResult(leaf.output.kind, text);
		return normalized.ok ? normalized.value : fallbackResult(leaf.output.kind, text);
	}

	private async promptReview(
		ctx: ExtensionContext,
		targetId: string,
		summary: string,
	): Promise<ChainReviewResult | undefined> {
		return showChainReview(ctx, targetId, summary);
	}

	private scheduleControlTurn(kind: typeof CONTROL_TYPE | typeof ADVANCE_TYPE): void {
		this.pi.sendMessage(
			{
				customType: kind,
				content: kind === CONTROL_TYPE ? "↻ chain feedback" : "↻ chain continues",
				display: true,
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
	}

	private async advanceAfterLeaf(
		ctx: ExtensionContext,
		leaf: ChainStepNode,
	): Promise<void> {
		if (!this.state) return;
		const chain = this.getChain();
		if (!chain) return;

		if (leaf.review) {
			this.state.mode = "waiting-review";
			this.state.pendingReview = {
				targetId: leaf.id,
				targetKind: "step",
				summary: previewResult(this.state.results[leaf.id]),
			};
			this.persistState();
			this.emitEvent(`⏸ review wait: ${leaf.id}`, {
				event: "review-wait",
				targetId: leaf.id,
				targetKind: "step",
				summary: this.state.pendingReview.summary,
			});
			this.renderHud(ctx);

			const review = await this.promptReview(ctx, leaf.id, this.state.pendingReview.summary);
			if (!review) return;
			this.emitEvent(
				review.decision === "redefine" ? `↻ review redefine: ${leaf.id}` : `✓ review continue: ${leaf.id}`,
				{
					event: "review-decision",
					targetId: leaf.id,
					targetKind: "step",
					decision: review.decision,
					feedback: review.feedback,
				},
			);
			if (review.decision === "redefine") {
				this.state.pendingReview.feedback = review.feedback;
				this.state.mode = "running";
				this.persistState();
				this.renderHud(ctx);
				this.scheduleControlTurn(CONTROL_TYPE);
				return;
			}
			this.state.pendingReview = undefined;
			this.state.mode = "running";
			this.persistState();
			this.renderHud(ctx);
		}

		await this.continueAfterLeaf(ctx);
	}

	private async resolveCompletedFrames(ctx: ExtensionContext): Promise<void> {
		if (!this.state) return;
		const chain = this.getChain();
		if (!chain) return;

		while (this.state.stack.length > 0) {
			const frame = this.state.stack[this.state.stack.length - 1];
			if (!frame) return;
			const children = this.frameChildren(frame, chain);
			if (frame.index < children.length) {
				const child = children[frame.index];
				if (child && "loop" in child) {
					this.state.stack.push({ kind: "loop", nodeId: child.id, index: 0, iteration: 0 });
					continue;
				}
				return;
			}

			if (frame.kind === "root") {
				this.state.mode = "completed";
				this.state.currentNodeId = undefined;
				this.state.pendingReview = undefined;
				this.persistState();
				this.emitEvent(`✓ chain complete: ${this.state.chainName}`, { event: "chain-complete" });
				this.renderHud(ctx);
				return;
			}

			const blockNode = chain.allNodes.get(frame.nodeId);
			const lastChild = children[children.length - 1];
			const lastSummary = lastChild && "agent" in lastChild && this.state.results[lastChild.id] !== undefined
				? previewResult(this.state.results[lastChild.id])
				: "";

			if (blockNode && "loop" in blockNode && blockNode.review) {
				this.state.mode = "waiting-review";
				this.state.pendingReview = {
					targetId: blockNode.id,
					targetKind: "block",
					summary: lastSummary,
				};
				this.persistState();
				this.emitEvent(`⏸ review wait: ${blockNode.id}`, {
					event: "review-wait",
					targetId: blockNode.id,
					targetKind: "block",
					summary: lastSummary,
				});
				this.renderHud(ctx);

				const review = await this.promptReview(ctx, blockNode.id, lastSummary);
				if (!review) return;
				this.emitEvent(
					review.decision === "redefine" ? `↻ review redefine: ${blockNode.id}` : `✓ review continue: ${blockNode.id}`,
					{
						event: "review-decision",
						targetId: blockNode.id,
						targetKind: "block",
						decision: review.decision,
						feedback: review.feedback,
					},
				);
				if (review.decision === "redefine") {
					const canRedefine = !(frame.kind === "loop" && frame.iteration + 1 >= blockNode.loop.max_iterations);
					if (canRedefine) {
						frame.index = 0;
						if (frame.kind === "loop") frame.iteration += 1;
						this.state.pendingReview.feedback = review.feedback;
						this.state.mode = "running";
						this.persistState();
						this.emitEvent(
							`↺ loop retry: ${blockNode.id} (${frame.iteration + 1}/${blockNode.loop.max_iterations})`,
							{
								event: "loop-retry",
								targetId: blockNode.id,
								iteration: frame.iteration + 1,
								maxIterations: blockNode.loop.max_iterations,
								feedback: review.feedback,
							},
						);
						this.renderHud(ctx);
						this.scheduleControlTurn(CONTROL_TYPE);
						return;
					}
					ctx.ui.notify(`Loop "${blockNode.id}" reached max_iterations; continuing.`, "info");
				}
				this.state.pendingReview = undefined;
				this.state.mode = "running";
			}

			this.state.stack.pop();
			const parent = this.state.stack[this.state.stack.length - 1];
			if (parent) parent.index += 1;
		}
	}
}
