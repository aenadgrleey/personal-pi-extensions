import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ModelSnapshot = {
	provider: string;
	id: string;
};

function snapshotModel(model: ExtensionContext["model"]): ModelSnapshot | undefined {
	const provider = model?.provider?.trim();
	const id = model?.id?.trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

function formatModel(snapshot: ModelSnapshot): string {
	return `${snapshot.provider}/${snapshot.id}`;
}

function appendToSystemPrompt(systemPrompt: string, note: string): string {
	return systemPrompt.length > 0 ? `${systemPrompt}\n\n${note}` : note;
}

const ORCHESTRATION_GUIDANCE = `RUG is the canonical delegation workflow.
- The RUG skill (/skill:rug) contains the detailed policy; use it as the source of truth for orchestration.
- Default to delegation and assume meaningful work should be split and handed to subagents unless it is truly trivial.
- Before doing any substantive work, launch an appropriate subagent for the task.
- Launch subagents early and aggressively; do not start doing the work yourself first.
- Choose the narrowest capable agent for the specific task at hand.
- Do not do direct code changes, broad exploration, or ad hoc testing when a subagent can do it.
- Do not rely on a single agent for everything; break work apart when it is meaningfully separable.
- If a task is non-trivial, delegate first, then synthesize here.`;

function buildNote(snapshot: ModelSnapshot | undefined, hasCurrentModel: boolean): string | undefined {
	if (!snapshot) return undefined;

	const modelLabel = formatModel(snapshot);
	if (hasCurrentModel) {
		return `Active model: ${modelLabel}. If the model changes later in this session, use the newest observed model. If the current model becomes unavailable, reuse the latest known model.`;
	}

	return `Active model (latest known): ${modelLabel}. If the current model is unavailable, reuse this latest known model for the session.`;
}

export default function (pi: ExtensionAPI): void {
	let latestModel: ModelSnapshot | undefined;
	let subagentGuidanceEnabled = true;

	function buildSystemPrompt(systemPrompt: string, ctx: ExtensionContext): string {
		const current = snapshotModel(ctx.model);
		if (current) latestModel = current;

		const note = buildNote(current ?? latestModel, current !== undefined);
		let nextPrompt = systemPrompt;
		if (subagentGuidanceEnabled) {
			nextPrompt = appendToSystemPrompt(nextPrompt, ORCHESTRATION_GUIDANCE);
		}
		return note ? appendToSystemPrompt(nextPrompt, note) : nextPrompt;
	}

	pi.on("session_start", async (_event, ctx) => {
		const current = snapshotModel(ctx.model);
		if (current) latestModel = current;
	});

	pi.on("model_select", async (event) => {
		const current = snapshotModel(event.model);
		if (current) latestModel = current;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		return { systemPrompt: buildSystemPrompt(event.systemPrompt, ctx) };
	});

	pi.registerCommand("subagents", {
		description: "Toggle subagent orchestration guidance",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "enable") {
				subagentGuidanceEnabled = true;
				ctx.ui.notify("Subagent guidance: ON", "info");
				return;
			}
			if (action === "off" || action === "disable") {
				subagentGuidanceEnabled = false;
				ctx.ui.notify("Subagent guidance: OFF", "info");
				return;
			}
			subagentGuidanceEnabled = !subagentGuidanceEnabled;
			ctx.ui.notify(`Subagent guidance: ${subagentGuidanceEnabled ? "ON" : "OFF"}`, "info");
		},
	});
}
