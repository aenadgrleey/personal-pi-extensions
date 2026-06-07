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

const SUBAGENT_USAGE_SECTION = /Subagent usage preference:\n(?:- [^\n]*(?:\n|$))+/;

const ORCHESTRATION_GUIDANCE = `Subagent orchestration protocol:
- You are the main Pi agent and primary orchestrator for this session. Stay responsible for decomposition, delegation, synthesis, and final user-facing judgment.
- Pi subagents are installed and available through the subagent tool. Inspect available agents with subagent({ action: "list" }) before launching them unless you already did so for the current task.
- Prefer researcher/scout/context-builder for reconnaissance, planner for implementation plans, worker/SWE-style agents for bounded edits, and fresh-context reviewer agents for adversarial validation.
- For non-trivial work, use a RUG-style loop: decompose the request, delegate focused tasks with explicit scope and acceptance criteria, review/validate the results with a separate subagent where risk warrants it, then iterate until the evidence says the task is done.
- The parent Pi agent is not a pure worker. Do not offload responsibility for decisions, prioritization, or final synthesis. Subagents provide evidence and implementations; you orchestrate and decide.
- Keep subagent prompts compact but contract-based: include the original user goal, scope, constraints, acceptance criteria, verification commands, and expected output.
- Use fresh-context reviewers for meaningful implementation risk, broad changes, or cases where specification adherence matters. Never rely only on a worker's self-report for risky work.
- Do not delegate tiny one-file edits, sensitive config/secret edits, or tasks where subagent overhead is larger than the work. Direct parent edits remain acceptable when they are safer and cheaper, but the parent still owns orchestration.`;

function applyOrchestrationGuidance(systemPrompt: string): string {
	if (SUBAGENT_USAGE_SECTION.test(systemPrompt)) {
		return systemPrompt.replace(SUBAGENT_USAGE_SECTION, ORCHESTRATION_GUIDANCE);
	}

	return appendToSystemPrompt(systemPrompt, ORCHESTRATION_GUIDANCE);
}

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

	pi.on("session_start", async (_event, ctx) => {
		const current = snapshotModel(ctx.model);
		if (current) latestModel = current;
	});

	pi.on("model_select", async (event) => {
		const current = snapshotModel(event.model);
		if (current) latestModel = current;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = snapshotModel(ctx.model);
		if (current) latestModel = current;

		const note = buildNote(current ?? latestModel, current !== undefined);
		const systemPrompt = applyOrchestrationGuidance(event.systemPrompt);

		return {
			systemPrompt: note ? appendToSystemPrompt(systemPrompt, note) : systemPrompt,
		};
	});
}
