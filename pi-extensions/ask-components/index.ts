/**
 * Ask Components — Types, schema, and tool definition
 *
 * Provides the askTool definition for registration by the ask extension.
 * Other extensions can import types directly.
 *
 * The UI uses two native pi surfaces:
 *   - renderCall  → full question(s) with context and options as an inline chat item
 *   - execute     → ctx.ui.select() per question, ctx.ui.input() for free-text ("Other")
 *
 * Multi-question calls are handled sequentially — one select() per question.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getInteractionBridge } from "../interaction-components/bridge.js";
import { Container, Spacer, Text } from "../deps.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface AskOption {
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	question: string;
	context?: string;
	options: AskOption[];
	defaultIndex?: number;
	allowOther?: boolean; // default true
}

export interface Answer {
	id: string;
	answer: string;
	wasCustom: boolean;
	index?: number; // 1-based option index (undefined when wasCustom)
}

export interface AskResult {
	answers: Answer[];
	cancelled: boolean;
}

// ── Schema ───────────────────────────────────────────────────────────────

export const AskParams = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			description: "One or more questions to ask the user",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Unique identifier for this question" },
					question: { type: "string", description: "The question text to display" },
					context: {
						type: "string",
						description:
							"Markdown body displayed inside the selector UI above the options. " +
							"Use this for longer background information the user needs to make a decision. " +
							"Automatically scrolls when it exceeds available space.",
					},
					options: {
						type: "array",
						description: "Choices. A free-text option is appended automatically unless allowOther is false.",
						items: {
							type: "object",
							properties: {
								label: { type: "string", description: "Display label for the option" },
								description: { type: "string", description: "One-line hint shown below the label" },
							},
							required: ["label"],
							additionalProperties: false,
						},
					},
					defaultIndex: { type: "number", description: "0-based index of the pre-selected option" },
					allowOther: { type: "boolean", description: "Show free-text option (default: true)" },
				},
				required: ["id", "question", "options"],
				additionalProperties: false,
			},
		},
	},
	required: ["questions"],
	additionalProperties: false,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────

function cancelledResult(
	answers: Answer[],
	total: number,
): { content: { type: "text"; text: string }[]; details: AskResult } {
	const msg =
		answers.length > 0
			? `User cancelled after answering ${answers.length} of ${total} question(s)`
			: "User cancelled (pressed Escape)";
	return {
		content: [{ type: "text", text: msg }],
		details: { answers, cancelled: true },
	};
}

function errorResult(
	message: string,
): { content: { type: "text"; text: string }[]; details: AskResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { answers: [], cancelled: true },
	};
}

export async function showLocalAskPrompt(
	ctx: ExtensionContext,
	questions: Question[],
	signal?: AbortSignal,
): Promise<AskResult> {
	ctx.ui.setWorkingMessage("User input...");
	const answers: Answer[] = [];

	try {
		for (const q of questions) {
			const selectLabels = q.options.map((o) =>
				o.description ? `${o.label} — ${o.description}` : o.label,
			);
			const hasOther = q.allowOther !== false;
			if (hasOther) selectLabels.push("✏️  Other (type your own)…");

			const selected = await ctx.ui.select(
				q.question,
				selectLabels,
				signal ? { signal } : undefined,
			);
			if (selected === undefined) {
				return { answers, cancelled: true };
			}

			const idx = selectLabels.indexOf(selected);
			const isOther = hasOther && idx === selectLabels.length - 1;
			if (isOther) {
				const custom = await ctx.ui.input(
					q.question,
					"",
					signal ? { signal } : undefined,
				);
				if (!custom?.trim()) {
					return { answers, cancelled: true };
				}
				answers.push({ id: q.id, answer: custom.trim(), wasCustom: true });
				continue;
			}

			const optionLabel = q.options[idx]?.label ?? selected;
			answers.push({ id: q.id, answer: optionLabel, wasCustom: false, index: idx + 1 });
		}
		return { answers, cancelled: false };
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

export async function showAskPrompt(
	ctx: ExtensionContext,
	questions: Question[],
	signal?: AbortSignal,
): Promise<AskResult> {
	const bridge = getInteractionBridge();
	if (bridge) return bridge.presentAsk(ctx, questions);
	return showLocalAskPrompt(ctx, questions, signal);
}

// ── Tool definition ───────────────────────────────────────────────────────

/** Tool definition consumers pass to pi.registerTool(). */
export const askTool = {
	name: "ask",
	label: "Ask",
	description:
		"Ask the user one or more questions with arrow-selectable options. " +
		"Use when you need clarification, a decision, or user preference to proceed. " +
		"Each question gets a free-text option by default (set allowOther: false to disable). " +
		"Batch related questions into one call for efficiency. " +
		"Use `context` to provide longer background text the user can read before choosing. " +
		"Prefer this over guessing — it keeps the user in the loop.",
	promptSnippet: "Ask the user one or more questions with selectable options",
	promptGuidelines: [
		"Use `ask` when you need clarification or a decision from the user.",
		"Batch related questions into one call instead of calling multiple times.",
		"Keep options concise — the user scans them with arrow keys.",
		"Provide descriptions for options when the label alone might be ambiguous.",
		"Use `context` (markdown) when the user needs background information to decide.",
	],
	parameters: AskParams,

	async execute(
		_toolCallId: string,
		params: { questions: Question[] },
		_signal: AbortSignal,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	) {
		const bridge = getInteractionBridge();
		if (!ctx.hasUI && !bridge) {
			return errorResult("Error: UI not available (non-interactive mode)");
		}
		if (params.questions.length === 0) {
			return errorResult("Error: at least one question is required");
		}
		for (const q of params.questions) {
			if (q.options.length === 0) {
				return errorResult(`Error: question "${q.id}" has no options`);
			}
		}

		const result = await showAskPrompt(ctx, params.questions, _signal);
		if (result.cancelled) {
			return cancelledResult(result.answers, params.questions.length);
		}

		const answerLines = result.answers.map((a) =>
			a.wasCustom
				? `${a.id}: user wrote: "${a.answer}"`
				: `${a.id}: user selected: ${a.index}. ${a.answer}`,
		);

		return {
			content: [{ type: "text" as const, text: answerLines.join("\n") }],
			details: result,
		};
	},

	/**
	 * Renders all questions with their context and options as an inline chat item.
	 * Scrolls naturally with the conversation.
	 */
	renderCall(args: { questions: Question[] }, theme: Theme) {
		const qs = (args.questions ?? []) as Question[];
		const container = new Container();
		const isMulti = qs.length > 1;

		for (let i = 0; i < qs.length; i++) {
			const q = qs[i];
			if (!q) continue;

			// Spacer between questions
			if (i > 0) container.addChild(new Spacer(1));

			// Question heading
			const prefix = isMulti ? `${q.id}: ` : "";
			container.addChild(
				new Text(theme.fg("accent", `❓ ${prefix}${q.question}`), 0, 0),
			);

			// Optional context
			if (q.context?.trim()) {
				container.addChild(new Spacer(1));
				for (const line of q.context.trim().split("\n")) {
					container.addChild(new Text(theme.fg("muted", `  ${line}`), 0, 0));
				}
			}

			// Options
			container.addChild(new Spacer(1));
			for (let j = 0; j < (q.options ?? []).length; j++) {
				const opt = q.options[j];
				if (!opt) continue;
				const descSuffix = opt.description
					? theme.fg("dim", ` — ${opt.description}`)
					: "";
				container.addChild(
					new Text(
						theme.fg("text", `  ${j + 1}. ${opt.label}`) + descSuffix,
						0,
						0,
					),
				);
			}
			if (q.allowOther !== false) {
				container.addChild(
					new Text(theme.fg("dim", "  ✏️  Other (type your own)…"), 0, 0),
				);
			}
		}

		return container;
	},

	renderResult(
		result: { details?: AskResult; content: Array<{ type: string; text?: string }> },
		_opts: { expanded: boolean; isPartial: boolean },
		theme: Theme,
	) {
		const details = result.details;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
		}

		if (details.cancelled) {
			const answered = details.answers.length;
			if (answered > 0) {
				return new Text(theme.fg("warning", `✗ Cancelled (${answered} answered)`), 0, 0);
			}
			return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
		}

		const lines = details.answers.map((a) => {
			if (a.wasCustom) {
				return `${theme.fg("success", "✓")} ${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote)")} ${a.answer}`;
			}
			return `${theme.fg("success", "✓")} ${theme.fg("accent", a.id)}: ${a.index}. ${a.answer}`;
		});
		return new Text(lines.join("\n"), 0, 0);
	},
};
