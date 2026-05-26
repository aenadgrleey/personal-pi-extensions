import type { ChainNode, ChainStepNode, LoadedChain, LoadedSkill } from "./types.js";

function indent(value: string, depth: number): string {
	return `${"  ".repeat(depth)}${value.replace(/\n/g, `\n${"  ".repeat(depth)}`)}`;
}

function renderNodeLine(node: ChainNode, activeId: string | undefined, depth: number, out: string[]): void {
	const prefix = "  ".repeat(depth);
	if ("agent" in node) {
		out.push(`${prefix}${activeId === node.id ? ">" : "-"} ${node.id} (${node.agent})`);
		return;
	}

	out.push(`${prefix}${activeId === node.id ? ">" : "-"} ${node.id} [loop x${node.loop.max_iterations}]`);
	for (const child of node.loop.steps) {
		renderNodeLine(child, activeId, depth + 1, out);
	}
}

export function renderChainHudLines(params: {
	chain: LoadedChain;
	mode: string;
	activeNodeId?: string;
	queuedCount: number;
	stackDepth: number;
	pendingReview?: string;
}): string[] {
	const lines = [
		`Chain: ${params.chain.name}`,
		`State: ${params.mode}${params.queuedCount > 0 ? ` | queued:${params.queuedCount}` : ""}`,
	];

	if (params.pendingReview) {
		lines.push(`Review: ${params.pendingReview}`);
	}

	lines.push("Steps:");
	for (const node of params.chain.steps) {
		renderNodeLine(node, params.activeNodeId, 0, lines);
	}

	if (params.stackDepth > 1) {
		lines.push(`Depth: ${params.stackDepth}`);
	}

	return lines;
}

function formatObject(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function resolvePath(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (current === undefined || current === null) return undefined;
		if (Array.isArray(current)) {
			const index = Number.parseInt(segment, 10);
			if (Number.isNaN(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export function interpolateText(text: string, values: {
	input: string;
	prev: unknown;
	steps: Record<string, unknown>;
}): string {
	return text.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, rawExpr: string) => {
		const expr = rawExpr.trim();
		if (expr === "input") return values.input;
		if (expr === "prev") return formatObject(values.prev);
		if (expr.startsWith("prev.")) {
			return formatObject(resolvePath(values.prev, expr.slice(5).split(".")));
		}
		if (!expr.startsWith("steps.")) return `{{${expr}}}`;
		const parts = expr.split(".");
		const stepId = parts[1];
		if (!stepId) return `{{${expr}}}`;
		const stepValue = values.steps[stepId];
		if (stepValue === undefined) return `{{${expr}}}`;
		if (parts.length === 2) return formatObject(stepValue);
		return formatObject(resolvePath(stepValue, parts.slice(2)));
	});
}

export function buildStepPrompt(params: {
	chain: LoadedChain;
	step: ChainStepNode;
	task: string;
	input: string;
	prev: unknown;
	results: Record<string, unknown>;
	skillMap: Map<string, LoadedSkill>;
	feedback?: string;
}): string {
	const lines = [
		`[CHAIN ${params.chain.name}]`,
		`Active step: ${params.step.id} (${params.step.agent})`,
		`Output kind: ${params.step.output.kind}`,
		`Input:`,
		params.input.trim() || "(empty)",
		``,
		`Previous result:`,
		formatObject(params.prev),
		``,
		`Task:`,
		params.task.trim(),
	];

	if (params.step.tools) {
		lines.push("", `Allowed tools: ${params.step.tools.allow.join(", ")}`);
	}

	if (params.step.skills?.length) {
		lines.push("", "Injected skills:");
		const seen = new Set<string>();
		for (const skill of params.step.skills) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			const loaded = params.skillMap.get(skill.name);
			lines.push(indent(`- ${skill.name}${loaded?.description ? ` — ${loaded.description}` : ""}`, 1));
			if (loaded?.body) {
				lines.push(indent(loaded.body, 2));
			}
			if (skill.instruction?.trim()) {
				lines.push(indent(skill.instruction.trim(), 2));
			}
		}
	}

	if (Object.keys(params.results).length > 0) {
		lines.push("", "Completed steps:");
		for (const [id, value] of Object.entries(params.results)) {
			lines.push(indent(`${id}: ${formatObject(value)}`, 1));
		}
	}

	if (params.feedback?.trim()) {
		lines.push("", "User feedback:", params.feedback.trim());
	}

	lines.push(
		"",
		"When finished, call chain_return with JSON matching the declared output kind.",
		"Do not invent extra fields.",
	);

	return lines.join("\n");
}

export function previewResult(value: unknown): string {
	return formatObject(value);
}
