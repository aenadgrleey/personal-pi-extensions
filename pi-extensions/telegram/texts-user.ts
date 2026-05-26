import type { TelegramCommandPublicationState, TelegramPublishedCommand } from "./types.js";

export const TELEGRAM_IDLE_FALLBACK =
	"✅ Done! Pi is idling in the local session, ready for your next move.";
export const TELEGRAM_API_ERROR_FALLBACK =
	"💥 Pi hit an API error and called it quits. Swing by the local session for the full story.";
export const TELEGRAM_WORK_GIF_URL = "https://media.giphy.com/media/13HgwGsXF0aiGY/giphy.gif";
export const TELEGRAM_WORK_REACTION = "👨‍💻";
export const TELEGRAM_QUEUE_REACTION = "👀";

export const TELEGRAM_UI_TEXT = {
	scopeOptions: ["Project scope", "Global scope", "Cancel"],
	tokenActions: {
		keep: "Keep current token",
		skip: "Skip token for now",
		enter: "Enter new token",
		clear: "Clear token",
		cancel: "Cancel setup",
		title: "Telegram bot token",
		placeholder: "123456:ABC...",
	},
	chatActions: {
		skip: "Skip chat ID for now",
		enter: "Enter new chat ID",
		clear: "Clear chat ID",
		cancel: "Cancel setup",
		title: "Telegram chat ID",
		placeholder: "123456789",
	},
	apiActions: {
		default: "Use default API URL",
		enter: "Enter custom API URL",
		clear: "Clear custom API URL",
		cancel: "Cancel setup",
		title: "Telegram API base URL",
		placeholder: "https://api.telegram.org",
	},
	notificationOptions: ["Enabled", "Disabled"],
	configMenuOptions: [
		"Run setup wizard",
		"Toggle notifications",
		"Clear project Telegram config",
		"Clear global Telegram config",
		"Cancel",
	],
	localCommandDescriptions: {
		status: "Show Telegram integration status and config location",
		toggle: "Toggle Telegram delivery on/off for project or global scope",
		test: "Run a dual-channel ask/plan/review interaction test in Pi and Telegram",
		attach: "Attach Telegram delivery to this session",
		detach: "Detach Telegram delivery from the active owner session",
		config: "Configure Telegram token/chat id/api URL for project or global scope",
	},
	interactionButtons: {
		accept: "✅ Accept",
		save: "💾 Save",
		refine: "✏️ Refine",
		discard: "🗑️ Discard",
		keepAsIs: "✅ Keep as is",
		revise: "✏️ Revise",
	},
} as const;

export function getTelegramTokenActionOptions(hasToken: boolean): string[] {
	return [
		hasToken ? TELEGRAM_UI_TEXT.tokenActions.keep : TELEGRAM_UI_TEXT.tokenActions.skip,
		TELEGRAM_UI_TEXT.tokenActions.enter,
		hasToken ? TELEGRAM_UI_TEXT.tokenActions.clear : TELEGRAM_UI_TEXT.tokenActions.cancel,
	];
}

export function getTelegramChatActionOptions(currentChatId?: number | string): string[] {
	return [
		currentChatId !== undefined
			? `Keep current chat ID (${currentChatId})`
			: TELEGRAM_UI_TEXT.chatActions.skip,
		TELEGRAM_UI_TEXT.chatActions.enter,
		currentChatId !== undefined ? TELEGRAM_UI_TEXT.chatActions.clear : TELEGRAM_UI_TEXT.chatActions.cancel,
	];
}

export function getTelegramApiActionOptions(currentApiBaseUrl?: string): string[] {
	return [
		currentApiBaseUrl
			? `Keep current API URL (${currentApiBaseUrl})`
			: TELEGRAM_UI_TEXT.apiActions.default,
		TELEGRAM_UI_TEXT.apiActions.enter,
		currentApiBaseUrl ? TELEGRAM_UI_TEXT.apiActions.clear : TELEGRAM_UI_TEXT.apiActions.cancel,
	];
}

export function getTelegramTokenInputPlaceholder(currentToken?: string): string {
	return currentToken ? TELEGRAM_UI_TEXT.tokenActions.enter : TELEGRAM_UI_TEXT.tokenActions.placeholder;
}

export function getTelegramChatInputPlaceholder(currentChatId?: number | string): string {
	return currentChatId !== undefined ? String(currentChatId) : TELEGRAM_UI_TEXT.chatActions.placeholder;
}

export function getTelegramApiInputPlaceholder(currentApiBaseUrl?: string): string {
	return currentApiBaseUrl || TELEGRAM_UI_TEXT.apiActions.placeholder;
}

export type TelegramParseMode = "HTML" | "MarkdownV2";
export type TelegramTextLiteral = {
	text: string;
	parseMode?: TelegramParseMode;
};

type TelegramMessageContent = string | Array<{ type: string; text?: string }>;
type TelegramCompletionMessage = {
	role: string;
	content?: TelegramMessageContent;
	stopReason?: string;
	errorMessage?: string;
};

function trimTrailingWhitespace(text: string): string {
	return text.replace(/[ \t]+$/gm, "").trim();
}

function escapeTelegramHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function normalizeInlineText(text: string | undefined, fallback: string): string {
	const normalized = (text || fallback).trim().replace(/\s+/g, " ");
	return normalized;
}

function buildMultilineMessage(lines: Array<string | undefined>): string {
	return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function buildTelegramLiteral(text: string, parseMode: TelegramParseMode = "HTML"): TelegramTextLiteral {
	return { text, parseMode };
}

export function normalizeTelegramTextLiteral(
	literal: string | TelegramTextLiteral,
): TelegramTextLiteral {
	return typeof literal === "string" ? { text: literal } : literal;
}

export function previewText(text: string, limit = 280): string {
	const normalized = trimTrailingWhitespace(text).replace(/\s+/g, " ");
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function previewTelegramText(text: string, limit = 280): string {
	const cleaned = trimTrailingWhitespace(text);
	if (cleaned.length <= limit) return cleaned;
	return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function splitTelegramMessage(text: string, limit = 4000): string[] {
	const cleaned = trimTrailingWhitespace(text);
	if (!cleaned) return [""];
	if (cleaned.length <= limit) return [cleaned];

	const chunks: string[] = [];
	let rest = cleaned;

	while (rest.length > limit) {
		let index = rest.lastIndexOf("\n\n", limit);
		if (index < 0 || index < limit / 2) index = rest.lastIndexOf("\n", limit);
		if (index < 0 || index < limit / 2) index = rest.lastIndexOf(" ", limit);
		if (index < 0 || index < limit / 2) index = limit;

		chunks.push(rest.slice(0, index).trim());
		rest = rest.slice(index).trim();
	}

	if (rest) chunks.push(rest);
	return chunks.filter((chunk) => chunk.length > 0);
}

export function extractTextContent(content: TelegramMessageContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text?: string } => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

export function formatTelegramAgentMessage(
	text: string,
	speaker = "🤖 Pi",
): TelegramTextLiteral {
	const label = trimTrailingWhitespace(speaker).replace(/[:\s]+$/g, "") || "🤖 Pi";
	const body = trimTrailingWhitespace(text);
	if (!body) {
		return buildTelegramLiteral(label === "🤖 Pi" ? "" : escapeTelegramHtml(label));
	}
	if (label === "🤖 Pi") return buildTelegramLiteral(escapeTelegramHtml(body));
	return buildTelegramLiteral(`${escapeTelegramHtml(label)}:\n${escapeTelegramHtml(body)}`);
}

export function formatTelegramTitledMessage(title: string, body: string): TelegramTextLiteral {
	const label = trimTrailingWhitespace(title).replace(/[:\s]+$/g, "");
	const text = trimTrailingWhitespace(body);
	if (!label) return buildTelegramLiteral(escapeTelegramHtml(text));
	if (!text) return buildTelegramLiteral(escapeTelegramHtml(label));
	return buildTelegramLiteral(`${escapeTelegramHtml(label)}:\n${escapeTelegramHtml(text)}`);
}

export function buildTelegramCompletionNotification(
	messages: TelegramCompletionMessage[],
	apiErrorNotified: boolean,
): { title: string; body: string } {
	const assistant = [...messages].reverse().find((message) => message.role === "assistant");
	const text = assistant?.content ? extractTextContent(assistant.content) : "";
	const endedWithError = assistant?.stopReason === "error" || Boolean(assistant?.errorMessage?.trim());
	return {
		title: "",
		body: text || (endedWithError || apiErrorNotified ? TELEGRAM_API_ERROR_FALLBACK : TELEGRAM_IDLE_FALLBACK),
	};
}

export function summarizeTelegramToolCall(toolName: string, args: unknown): string {
	if (toolName === "bash" && args && typeof args === "object" && "command" in args) {
		const command = args.command;
		if (typeof command === "string" && command.trim()) {
			return `bash · ${command.trim()}`;
		}
	}
	if (
		(toolName === "read" || toolName === "write") &&
		args &&
		typeof args === "object" &&
		"path" in args
	) {
		const path = args.path;
		if (typeof path === "string" && path.trim()) {
			return `${toolName} · ${path.trim()}`;
		}
	}
	if (toolName === "edit" && args && typeof args === "object" && "path" in args) {
		const path = args.path;
		if (typeof path === "string" && path.trim()) {
			return `edit · ${path.trim()}`;
		}
	}
	return toolName;
}

export function buildTelegramWorkStatusMessage(
	turnIndex: number,
	latestToolCall?: string,
	initiator?: string,
	initiatorSource?: "Pi" | "Telegram",
): string {
	const escapedInitiator = initiator
		? escapeTelegramHtml(previewText(initiator, 120))
		: undefined;
	const statusLines = [
		`turn ${turnIndex}`,
		latestToolCall ? previewText(latestToolCall, 500) : undefined,
	].filter((line): line is string => Boolean(line));
	const statusBlock = statusLines.length
		? `<pre>${escapeTelegramHtml(statusLines.join("\n"))}</pre>`
		: undefined;
	return buildMultilineMessage([
		escapedInitiator
			? `↩️ ${escapeTelegramHtml(initiatorSource ?? "Pi")}: "${escapedInitiator}"`
			: undefined,
		"<b>⚙️ Working</b>",
		statusBlock,
	]);
}

export function formatTelegramQuestionPrompt(params: {
	question: {
		id: string;
		question: string;
		context?: string;
		options: Array<{ label: string; description?: string }>;
		allowOther?: boolean;
	};
	index: number;
	total: number;
}): string {
	const { question, index, total } = params;
	const lines = [
		total > 1 ? `❓ Ask · Question ${index + 1} of ${total}` : "❓ Ask",
		`${question.id}: ${question.question}`,
	];
	if (question.context?.trim()) lines.push("", `📝 ${question.context.trim()}`);
	lines.push("", "✨ Options:");
	for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
		const option = question.options[optionIndex];
		if (!option) continue;
		const suffix = option.description ? ` — ${option.description}` : "";
		lines.push(`👉 ${optionIndex + 1}. ${option.label}${suffix}`);
	}
	if (question.allowOther !== false) {
		lines.push(`✍️ ${question.options.length + 1}. Other — reply with your own text`);
	}
	lines.push("", "💬 Pick a number, type the label, or just write your own.");
	return lines.join("\n");
}

export function formatTelegramQuestionOptionButton(index: number, label: string): string {
	return `👉 ${index + 1}. ${label}`;
}

export function formatTelegramQuestionOtherButton(optionCount: number): string {
	return `✍️ ${optionCount + 1}. Other`;
}

export function formatTelegramPlanPrompt(
	title: string,
	phases: Array<{ name: string; steps: string[] }>,
	context?: string,
): string {
	const lines = [`🗂️ Plan: ${title}`];
	if (context?.trim()) lines.push("", `📝 ${context.trim()}`);
	let globalStep = 1;
	for (const phase of phases) {
		lines.push("", phases.length > 1 ? `📍 ${phase.name}:` : "📍 Steps:");
		for (const step of phase.steps) {
			lines.push(`${globalStep}. ${step}`);
			globalStep++;
		}
	}
	lines.push("", "💬 Accept, save, refine, or discard — your call.");
	return lines.join("\n");
}

export function formatTelegramReviewPrompt(decision: string, summary: string, context?: string): string {
	const lines = [`🔎 Review: ${decision}`, "", summary.trim()];
	if (context?.trim()) lines.push("", "📝 Context:", context.trim());
	lines.push("", "💬 Like it? Keep. Got notes? Revise.");
	return lines.join("\n");
}

export function getTelegramFixedCommands(): TelegramPublishedCommand[] {
	return [
		{ command: "new_session", description: "Start a fresh Pi session" },
		{ command: "clear", description: "Clear chat and start a fresh Pi session" },
		{ command: "skills", description: "List Telegram skill commands" },
		{ command: "status", description: "Show Telegram session status" },
		{ command: "refresh", description: "Refresh Telegram slash commands" },
		{ command: "context", description: "Show current Pi context leftovers" },
		{ command: "detach", description: "Detach Telegram from this session" },
		{ command: "help", description: "Show Telegram command help" },
	];
}

export function truncateTelegramCommandDescription(
	text: string | undefined,
	fallback: string,
	maxLength = 256,
): string {
	const normalized = normalizeInlineText(text, fallback);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getTelegramSkillAliasUnsupportedReason(): string {
	return "unsupported alias after Telegram-safe sanitization";
}

export function getTelegramSkillAliasTooLongReason(): string {
	return "too long for Telegram's 32-character command limit";
}

export function getTelegramSkillAliasFixedCommandCollisionReason(): string {
	return "collides with a fixed Telegram command";
}

export function getTelegramSkillAliasCollisionReason(): string {
	return "collides with another skill alias";
}

export function formatTelegramSkillsMessage(state: TelegramCommandPublicationState): string {
	const lines = ["🧰 Telegram skills"];
	if (state.publishedSkills.length > 0) {
		lines.push("", "✅ Published slash commands:");
		for (const skill of state.publishedSkills) {
			lines.push(`- /${skill.command} — ${skill.skillName}`);
		}
	} else {
		lines.push("", "✅ Published slash commands:", "- none");
	}
	if (state.unpublishedSkills.length > 0) {
		lines.push("", "⚠️ Available in Pi but not published to Telegram:");
		for (const skill of state.unpublishedSkills) {
			lines.push(`- ${skill.skillName} (${skill.reason}; tried /${skill.attemptedCommand})`);
		}
		lines.push("", "Use Pi's local UI to run those.");
	}
	return lines.join("\n");
}

export function formatTelegramHelpMessage(state: TelegramCommandPublicationState): string {
	const lines = [
		"📚 Pi Telegram — what you can do:",
		"",
		"Session control:",
		"- /new_session — kick off a fresh Pi session",
		"- /clear — wipe the chat and start fresh",
		"- /skills — see which Pi skills made it to Telegram (and which didn't)",
		"- /status — check attachment and command status",
		"- /refresh — resync slash commands from the active Pi runtime",
		"- /context — peek at Pi's current context usage",
		"- /detach — unplug Telegram from this Pi session",
		"- /help — you're looking at it",
		"",
		"Skill commands:",
		"- /skill_<name> <task> — run a Pi skill immediately",
		"- /skill_<name> — arm a skill; send the task in your next message",
	];
	if (state.unpublishedSkills.length > 0) {
		lines.push(
			"",
			`Some Pi skills are too long or colliding for Telegram slash commands. See /skills (${state.unpublishedSkills.length} skipped).`,
		);
	}
	return lines.join("\n");
}

export function formatTelegramAttachWarning(state: TelegramCommandPublicationState): string | undefined {
	if (state.unpublishedSkills.length === 0) return undefined;
	const preview = state.unpublishedSkills
		.slice(0, 3)
		.map((skill) => `${skill.skillName} (${skill.reason})`)
		.join(", ");
	const suffix =
		state.unpublishedSkills.length > 3
			? `, +${state.unpublishedSkills.length - 3} more`
			: "";
	return `🔌 Attached! But ${state.unpublishedSkills.length} skill(s) couldn't land as slash commands: ${preview}${suffix}. See /skills.`;
}

export function formatTelegramRefreshResult(state: TelegramCommandPublicationState): string {
	const lines = [
		"✅ Commands refreshed!",
		`published slash commands: ${state.publishedCommands.length}`,
		`published skills: ${state.publishedSkills.length}`,
		`unpublished skills: ${state.unpublishedSkills.length}`,
	];
	if (state.publishError) lines.push(`publish error: ${state.publishError}`);
	return lines.join("\n");
}

export function formatTelegramSkillLoadFailure(skillName: string, error?: string): string {
	return error
		? `🚫 Couldn't load skill ${skillName}: ${error}`
		: `🚫 Couldn't load skill ${skillName}.`;
}

export function formatTelegramDetachMessage(): string {
	return "👋 Telegram has been unplugged from this session.";
}

export function formatTelegramArmedSkillMessage(command: string): string {
	return `🎯 /${command} is locked and loaded. What's the task?`;
}

export function formatTelegramUnpublishedSkillMessage(skillName: string, reason: string): string {
	return `📦 ${skillName} lives in Pi but didn't make it to Telegram as a slash command (${reason}). See /skills.`;
}

export function formatTelegramUnknownCommandMessage(): string {
	return "🤷 No idea what that is. Try /help or /skills.";
}

export function formatTelegramArmedSkillUnavailableMessage(command: string): string {
	return `💨 /${command} has gone AWOL — the skill is no longer available. Check /skills.`;
}

export function formatTelegramOtherAnswerPrompt(question: string): string {
	return `💬 Go ahead — what's your answer for "${question}"?`;
}

export function formatTelegramPlanFeedbackPrompt(title: string): string {
	return `💬 What needs tweaking in the "${title}" plan?`;
}

export function formatTelegramReviewFeedbackPrompt(decision: string): string {
	return `💬 What would you change about "${decision}"?`;
}

export function formatTelegramResolutionNote(kind: string, resolvedViaTelegram: boolean): string {
	const kindLabel = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
	return resolvedViaTelegram
		? `${kindLabel} resolved via Telegram ✅`
		: `${kindLabel} resolved in Pi 🖥️`;
}

export function formatTelegramRemoteStatus(params: {
	attached: boolean;
	ownerSessionId?: string;
	thisSessionOwnsTelegram: boolean;
	sessionResetAvailable: boolean;
	publishedSlashCommands?: number;
	publishedSkills?: number;
	unpublishedSkills?: number;
	commandRefresh?: string;
	commandPublishError?: string;
}): string {
	const lines = [
		"📡 Telegram status",
		`attached: ${params.attached ? "yes" : "no"}`,
		`owner session: ${params.ownerSessionId ?? "(none)"}`,
		`this session owns telegram: ${params.thisSessionOwnsTelegram ? "yes" : "no"}`,
		`session reset: ${params.sessionResetAvailable ? "available" : "temporarily unavailable"}`,
	];
	if (params.publishedSlashCommands !== undefined) {
		lines.push(`published slash commands: ${params.publishedSlashCommands}`);
	}
	if (params.publishedSkills !== undefined) {
		lines.push(`published skills: ${params.publishedSkills}`);
	}
	if (params.unpublishedSkills !== undefined) {
		lines.push(`unpublished skills: ${params.unpublishedSkills}`);
	}
	if (params.commandRefresh) {
		lines.push(`command refresh: ${params.commandRefresh}`);
	}
	if (params.commandPublishError) {
		lines.push(`command publish error: ${params.commandPublishError}`);
	}
	return lines.join("\n");
}

export function formatTelegramContextSummary(params: {
	sessionId: string;
	branchEntries: number;
	branchMessages: number;
	customStateEntries: number;
	customInContextMessages: number;
	compactionEntries: number;
	branchSummaries: number;
	totalStoredSessionEntries: number;
	contextWindow?: number;
	usedTokens?: number | null;
	usedPercent?: number | null;
	lastPreview?: string;
}): string {
	const lines = [
		"🧠 Context leftovers",
		`session: ${params.sessionId}`,
		`branch entries: ${params.branchEntries}`,
		`branch messages: ${params.branchMessages}`,
		`custom state entries on branch: ${params.customStateEntries}`,
		`custom in-context messages on branch: ${params.customInContextMessages}`,
		`compaction entries on branch: ${params.compactionEntries}`,
		`branch summaries on branch: ${params.branchSummaries}`,
		`total stored session entries: ${params.totalStoredSessionEntries}`,
	];
	if (params.contextWindow === undefined) {
		lines.push("estimated context usage: unavailable");
	} else if (params.usedTokens == null || params.usedPercent == null) {
		lines.push(
			`estimated context usage: unknown / ${params.contextWindow} tokens`,
			"Pi usually recomputes this after the next model response.",
		);
	} else {
		const remainingTokens = Math.max(0, params.contextWindow - params.usedTokens);
		const percentLeft = Math.max(0, 100 - params.usedPercent);
		lines.push(
			`estimated context used: ${params.usedTokens} / ${params.contextWindow} tokens (${params.usedPercent.toFixed(1)}%)`,
			`estimated context left: ${remainingTokens} tokens (${percentLeft.toFixed(1)}%)`,
		);
	}
	if (params.lastPreview) lines.push(`last branch message: ${params.lastPreview}`);
	lines.push("📊 Active Pi branch estimate — not the full transcript.");
	return lines.join("\n");
}

export function formatTelegramProviderErrorNotification(status: number, retryAfter?: string): string {
	const suffix = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
	return `💥 HTTP ${status} — the model/API request failed.${suffix}\n\nCheck the local Pi session for the full story.`;
}

export function getTelegramResetStartupBehavior(intent: "new_session" | "clear"): {
	startupMessage?: string;
	includeAttachWarning: boolean;
	historyResetMode?: "tracked" | "whole-chat";
} {
	if (intent === "clear") {
		return {
			startupMessage: undefined,
			includeAttachWarning: false,
			historyResetMode: "whole-chat",
		};
	}
	return {
		startupMessage: "✨ Fresh start! New Pi session is live.",
		includeAttachWarning: true,
		historyResetMode: undefined,
	};
}

export function formatSessionResetUnavailableMessage(): string {
	return "⏳ Pi isn't ready for a reset just yet. Try again in a moment.";
}

export function formatSessionResetCancelledMessage(): string {
	return "🛑 Reset cancelled. Pi lives to fight another day.";
}

export function formatSessionResetStartedMessage(): string {
	return "🔄 Session reset is underway!";
}

export function formatTelegramStatusCommandMessage(params: {
	active: boolean;
	configured: boolean;
	notificationsEnabled: boolean;
	chatId?: number | string;
	token: string;
	source: string;
	configPath: string;
	ownerFile: string;
	ownerSessionId?: string;
	ownerBusy?: boolean;
	thisSessionOwnsTelegram: boolean;
	projectConfigPath: string;
	projectTokenSet: boolean;
	projectChatId?: number | string;
	projectNotifications?: boolean;
	globalConfigPath: string;
	globalTokenSet: boolean;
	globalChatId?: number | string;
	globalNotifications?: boolean;
	apiBaseUrl: string;
	remoteStatus: string;
}): string {
	return [
		`active: ${params.active ? "yes" : "no"}`,
		`configured: ${params.configured ? "yes" : "no"}`,
		`notifications: ${params.notificationsEnabled ? "enabled" : "disabled"}`,
		`chat id: ${params.chatId ?? "(unset)"}`,
		`token: ${params.token}`,
		`source: ${params.source}`,
		`effective config: ${params.configPath}`,
		`owner file: ${params.ownerFile}`,
		`owner session: ${params.ownerSessionId ?? "(none)"}`,
		`owner busy: ${params.ownerBusy === undefined ? "(none)" : params.ownerBusy ? "yes" : "no"}`,
		`this session owns telegram: ${params.thisSessionOwnsTelegram ? "yes" : "no"}`,
		`project config: ${params.projectConfigPath}`,
		`project token: ${params.projectTokenSet ? "set" : "unset"}`,
		`project chat id: ${params.projectChatId ?? "(unset)"}`,
		`project notifications: ${params.projectNotifications ?? "(inherit)"}`,
		`global config: ${params.globalConfigPath}`,
		`global token: ${params.globalTokenSet ? "set" : "unset"}`,
		`global chat id: ${params.globalChatId ?? "(unset)"}`,
		`global notifications: ${params.globalNotifications ?? "(inherit)"}`,
		`api: ${params.apiBaseUrl}`,
		"",
		params.remoteStatus,
	].join("\n");
}

export function formatTelegramNotificationsToggled(
	scopeLabel: string,
	enabled: boolean,
	configPath: string,
): string {
	return `${scopeLabel} Telegram notifications are now ${enabled ? "on 🔔" : "off 🔕"}\n${configPath}`;
}

export function formatTelegramInteractionTestUnavailableMessage(): string {
	return "🔒 This session doesn't own Telegram, so the test can't run here. Check /telegram-status.";
}

export function formatTelegramInteractionTestStartedMessage(): string {
	return "🧪 Test is live! Prompts will appear in both Pi and Telegram — first reply wins.";
}

export function buildTelegramInteractionTestAskQuestion(): {
	id: string;
	question: string;
	context: string;
	options: Array<{ label: string }>;
	allowOther: false;
} {
	return {
		id: "delivery",
		question: "Telegram interaction test: did this Ask prompt appear in both Pi and Telegram?",
		context:
			"Answer from either side to verify the shared interaction bridge delivers the same prompt to both channels.",
		options: [{ label: "Yes, both are visible" }, { label: "No, one side is missing" }],
		allowOther: false,
	};
}

export function formatTelegramInteractionTestCancelledMessage(step: "ask" | "plan" | "review"): string {
	return `🛑 Test bailed out at the ${step} step.`;
}

export function formatTelegramInteractionTestProgressMessage(step: "ask" | "plan"): string {
	return step === "ask"
		? "✅ Ask done! Moving to Plan…"
		: "✅ Plan done! Moving to Review…";
}

export function buildTelegramInteractionTestPlan(): {
	title: string;
	context: string;
	phases: Array<{ name: string; steps: string[] }>;
} {
	return {
		title: "Telegram interaction test plan",
		context:
			"This plan preview checks that both Pi and Telegram can show the same reviewable plan.",
		phases: [
			{
				name: "Dual delivery",
				steps: [
					"Confirm the Ask prompt is visible in Pi and Telegram.",
					"Confirm the plan preview itself is visible in both channels.",
				],
			},
		],
	};
}

export function formatTelegramInteractionTestDiscardedMessage(): string {
	return "🗑️ Plan binned. Test stopped there.";
}

export function buildTelegramInteractionTestReview(): {
	decision: string;
	summary: string;
	context: string;
} {
	return {
		decision: "Telegram interaction test",
		summary: "Keep this dual-channel interaction test flow as the baseline check, or ask for revisions.",
		context: "This final review verifies decision prompts reach both Pi and Telegram.",
	};
}

export function formatTelegramInteractionTestSummary(params: {
	answers: string;
	planAction: string;
	reviewDecision: string;
	reviewFeedback?: string;
}): string {
	return [
		"🧪 All three steps done!",
		`ask: ${params.answers || "(none)"}`,
		`plan: ${params.planAction}`,
		`review: ${params.reviewDecision}${params.reviewFeedback ? ` (${params.reviewFeedback})` : ""}`,
	].join("\n");
}

export function formatTelegramAttachUnavailableMessage(): string {
	return "🚫 Can't attach — Pi session metadata is missing.";
}

export function formatTelegramForceAttachTitle(): string {
	return "Take over Telegram?";
}

export function formatTelegramForceAttachPrompt(ownerSessionId: string, ownerBusy: boolean): string {
	return ownerBusy
		? `Session ${ownerSessionId} is actively using Telegram. Steal it anyway?`
		: `Session ${ownerSessionId} is sitting idle with Telegram. Move it here?`;
}

export function formatTelegramAttachFailedMessage(): string {
	return "💔 Attach failed. Check /telegram-status for clues.";
}

export function formatTelegramAttachSuccessMessage(previousOwnerSessionId?: string): string {
	return previousOwnerSessionId
		? `🔌 Swiped from session ${previousOwnerSessionId} — Telegram is yours now.`
		: "🔌 Locked in! Telegram is now attached to this session.";
}

export function formatTelegramAlreadyDetachedMessage(): string {
	return "👻 Nothing to detach — Telegram isn't connected.";
}

export function formatTelegramDetachConfirmTitle(): string {
	return "Detach Telegram";
}

export function formatTelegramDetachConfirmMessage(isCurrentOwner: boolean, ownerSessionId: string): string {
	return isCurrentOwner
		? "Detach Telegram from this session?"
		: `Detach Telegram from session ${ownerSessionId}?`;
}

export function formatTelegramDetachSuccessMessage(isCurrentOwner: boolean, ownerSessionId: string): string {
	return isCurrentOwner
		? "👋 Telegram detached from this session."
		: `👋 Telegram detached from session ${ownerSessionId}.`;
}

export function formatTelegramConfigSavedMessage(scopeLabel: string, configPath: string): string {
	return `✅ ${scopeLabel} Telegram config saved.\n${configPath}`;
}

export function formatTelegramConfigClearedMessage(scopeLabel: string, configPath: string): string {
	return `🗑️ ${scopeLabel} Telegram config cleared.\n${configPath}`;
}

export function formatTelegramConfigClearConfirmMessage(configPath: string): string {
	return `Remove ${configPath}?`;
}

export function formatTelegramSetupScopePrompt(): string {
	return "Configure Telegram for which scope?";
}

export function formatTelegramConfigClearTitle(): string {
	return "Clear Telegram config";
}

export function formatTelegramToggleScopePrompt(): string {
	return "Toggle Telegram notifications for which scope?";
}

export function formatTelegramConfigMenuTitle(): string {
	return "Telegram config";
}

export function formatTelegramTestWarningMessage(message: string): string {
	return message;
}
