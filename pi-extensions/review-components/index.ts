import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getInteractionBridge } from "../interaction-components/bridge.js";
import { Container, Spacer, Text } from "../deps.js";

export interface ChainReviewResult {
	decision: "continue" | "redefine";
	feedback?: string;
}

export interface ReviewPromptParams {
	decision: string;
	summary: string;
	context?: string;
}

export interface ReviewPromptResult extends ChainReviewResult {
	review: ReviewPromptParams;
}

export interface ReviewToolDetails {
	review: ReviewPromptParams;
	result?: ReviewPromptResult;
	cancelled: boolean;
}

const REVIEW_CHOICES = ["Keep as is", "Revise"] as const;

function makeResult(review: ReviewPromptParams, result: ChainReviewResult): ReviewPromptResult {
	return { ...result, review };
}

function cancelledResult(review: ReviewPromptParams): { content: { type: "text"; text: string }[]; details: ReviewToolDetails } {
	return {
		content: [{ type: "text", text: "Decision review cancelled by user." }],
		details: { review, cancelled: true },
	};
}

export async function showLocalReviewPrompt(
	ctx: ExtensionContext,
	params: ReviewPromptParams,
	signal?: AbortSignal,
): Promise<ReviewPromptResult | undefined> {
	if (!ctx.hasUI) return makeResult(params, { decision: "continue" });

	ctx.ui.setWorkingMessage("User input...");
	try {
		const selected = await ctx.ui.select(
			"How should this decision be handled?",
			[...REVIEW_CHOICES],
			signal ? { signal } : undefined,
		);
		if (selected === undefined) return undefined;

		if (selected === "Keep as is") {
			return makeResult(params, { decision: "continue" });
		}

		const feedback = await ctx.ui.input(
			`What should change for "${params.decision}"?`,
			"",
			signal ? { signal } : undefined,
		);
		if (!feedback?.trim()) return undefined;
		return makeResult(params, { decision: "redefine", feedback: feedback.trim() });
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

export async function showReviewPrompt(
	ctx: ExtensionContext,
	params: ReviewPromptParams,
): Promise<ReviewPromptResult | undefined> {
	const bridge = getInteractionBridge();
	if (bridge) {
		const result = await bridge.presentReview(ctx, params);
		return result ? makeResult(params, result) : undefined;
	}
	return showLocalReviewPrompt(ctx, params);
}

export async function showChainReview(
	ctx: ExtensionContext,
	targetId: string,
	summary: string,
): Promise<ChainReviewResult | undefined> {
	const result = await showReviewPrompt(ctx, { decision: targetId, summary });
	return result ? { decision: result.decision, feedback: result.feedback } : undefined;
}

const ReviewPromptSchema = {
	type: "object",
	properties: {
		decision: { type: "string", description: "Short label for the decision to review" },
		summary: { type: "string", description: "What the user should review" },
		context: { type: "string", description: "Optional background context shown above the summary" },
	},
	required: ["decision", "summary"],
	additionalProperties: false,
} as const;

export const reviewTool = {
	name: "decision_review",
	label: "Decision Review",
	description:
		"Present a decision to the user for review. " +
		"Use when you're unsure about a choice and want the user to keep it as is or revise it. " +
		"Show the decision label plus a concise summary and optional context.",
	promptSnippet: "Present a decision for keep-as-is-or-revise review",
	promptGuidelines: [
		"Use decision_review when you're not sure about a decision and want the user to review it.",
		"Keep the decision label short and the summary focused on what needs review.",
		"Include context when the user needs background to make the call.",
		"Use the feedback to refine the decision if the user chooses revise.",
	],
	parameters: ReviewPromptSchema,

	async execute(
		_id: string,
		params: ReviewPromptParams,
		_signal: AbortSignal,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	) {
		const result = await showReviewPrompt(ctx, params);

		if (!result) {
			return cancelledResult(params);
		}

		const contentText = (() => {
			switch (result.decision) {
				case "continue":
					return `Decision accepted: ${params.decision}`;
				case "redefine":
					return result.feedback
						? `User requested refinements:\n\n${result.feedback}\n\nPlease revise the decision and call decision_review again.`
						: "User requested refinements but provided no feedback. Please ask what should change.";
			}
		})();

		return {
			content: [{ type: "text" as const, text: contentText }],
			details: { review: params, result, cancelled: false } satisfies ReviewToolDetails,
		};
	},

	renderCall(args: ReviewPromptParams, theme: Theme) {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", `⚠️  ${args.decision}`), 0, 0));
		container.addChild(new Spacer(1));
		for (const line of args.summary.trim().split("\n")) {
			container.addChild(new Text(theme.fg("text", line), 0, 0));
		}
		if (args.context?.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Context:"), 0, 0));
			for (const line of args.context.trim().split("\n")) {
				container.addChild(new Text(theme.fg("muted", line), 0, 0));
			}
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Keep as is or revise this decision."), 0, 0));
		return container;
	},

	renderResult(
		result: { details?: ReviewToolDetails; content: Array<{ type: string; text?: string }> },
		_opts: { expanded: boolean; isPartial: boolean },
		theme: Theme,
	) {
		const details = result.details;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
		}

		if (details.cancelled) {
			return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
		}

		if (!details.result) {
			return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
		}

		if (details.result.decision === "continue") {
			return new Text(
				`${theme.fg("success", "✓")} ${theme.fg("accent", details.review.decision)} kept as is`,
				0,
				0,
			);
		}

		const lines = [
			`${theme.fg("success", "✓")} ${theme.fg("accent", details.review.decision)} needs revision`,
		];
		if (details.result.feedback?.trim()) {
			lines.push(theme.fg("muted", details.result.feedback.trim()));
		}
		return new Text(lines.join("\n"), 0, 0);
	},
};
