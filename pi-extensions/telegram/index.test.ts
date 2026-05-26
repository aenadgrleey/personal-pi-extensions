import assert from "node:assert/strict";

import {
	buildTelegramCompletionNotification,
	extractTextContent,
	formatTelegramAgentMessage,
	formatTelegramTitledMessage,
	injectReplyContext,
	previewText,
	quoteReplyText,
	splitTelegramMessage,
	TELEGRAM_API_ERROR_FALLBACK,
} from "./formatting.ts";
import {
	getTelegramPendingCleanupState,
	getTelegramResetStartupBehavior,
	getTelegramSessionStartActivationMode,
} from "./index.ts";
import {
	buildTelegramCommandPublicationState,
	buildTelegramSkillAlias,
} from "./session-control.ts";
import {
	evaluateTelegramOwnershipClaim,
	isTelegramOwnerStateStale,
} from "./ownership.ts";
import { mergeTelegramStates } from "./state.ts";
import {
	buildTelegramWorkStatusMessage,
	getTelegramHistoryResetMessageIds,
	getTelegramPollingOffset,
	isStaleExtensionContextError,
	prepareTelegramRemoteHistoryReset,
	summarizeTelegramToolCall,
	takeSteeringReactionsForBotOutput,
	TelegramInteractionProvider,
} from "./telegram-provider.ts";

class FakeTelegramTransport {
	deletedMessageIds: number[] = [];
	publishedCommands: Array<Array<{ command: string; description: string }>> = [];
	consumedOffsets: Array<number | undefined> = [];
	startedOffsets: Array<number | undefined> = [];
	pendingUpdates: Array<{
		update_id: number;
		message?: { message_id: number; date: number; chat: { id: number; type: string } };
	}> = [];
	stopped = false;

	async sendMessage() {
		throw new Error("unexpected sendMessage in test");
	}

	async sendAnimation() {
		throw new Error("unexpected sendAnimation in test");
	}

	async editMessageText() {}
	async editMessageCaption() {}

	async deleteMessage(messageId: number) {
		this.deletedMessageIds.push(messageId);
	}

	async answerCallbackQuery() {}
	async setMessageReaction() {}
	async getFile() {
		throw new Error("unexpected getFile in test");
	}

	async setMyCommands(commands: Array<{ command: string; description: string }>) {
		this.publishedCommands.push(commands);
	}

	async downloadFile() {
		throw new Error("unexpected downloadFile in test");
	}

	async consumePendingUpdates(initialOffset?: number) {
		this.consumedOffsets.push(initialOffset);
		return this.pendingUpdates as never;
	}

	async start(_onUpdate: unknown, initialOffset?: number) {
		this.startedOffsets.push(initialOffset);
	}

	stop() {
		this.stopped = true;
	}
}

async function buildTelegramProviderForTest(params: {
	historyResetMode?: "tracked" | "whole-chat";
	pendingUpdates?: Array<{
		update_id: number;
		message?: { message_id: number; date: number; chat: { id: number; type: string } };
	}>;
	currentState?: {
		version: 2;
		lastUpdateId?: number;
		outboundMessageIds: number[];
		inboundMessageIds: number[];
		pending: [];
		attachments: [];
		steering: [];
	};
	cleanupState?: {
		version: 2;
		lastUpdateId?: number;
		outboundMessageIds: number[];
		inboundMessageIds: number[];
		pending: [];
		attachments: [];
		steering: [];
	};
}) {
	const transport = new FakeTelegramTransport();
	transport.pendingUpdates = params.pendingUpdates ?? [];
	const provider = new TelegramInteractionProvider({
		pi: {
			appendEntry() {},
			sendUserMessage: async () => {},
		} as never,
		config: {
			enabled: true,
			configured: true,
			notificationsEnabled: true,
			token: "token",
			chatId: 1,
			apiBaseUrl: "https://api.telegram.org",
			configPath: "/tmp/telegram.local.json",
			source: "project",
		},
		getIsIdle: () => true,
		getSessionId: () => "session-b",
		getSignal: () => undefined,
		getCommandEntries: () => [],
		getStatusMessage: () => "status",
		getContextMessage: () => "context",
		handleSessionReset: async () => ({ started: true, message: "ok" }),
		handleDetach: async () => {},
		reason: "new",
		currentState: params.currentState ?? {
			version: 2,
			lastUpdateId: undefined,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		cleanupState: params.cleanupState ?? {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3],
			pending: [],
			attachments: [],
			steering: [],
		},
		startupMessages: [],
		includeAttachWarning: false,
		historyResetMode: params.historyResetMode,
		transport: transport as never,
	});
	await provider.onAgentEnd();
	return { transport, provider };
}

assert.equal(quoteReplyText("one\ntwo"), "> one\n> two");
assert.equal(
	injectReplyContext("answer", "question"),
	"Reply context:\nquestion\n\nanswer",
);
assert.deepEqual(splitTelegramMessage(`a\n\n${"b".repeat(4100)}`, 1000).length > 1, true);
assert.equal(splitTelegramMessage("x".repeat(5000), 3600).join(""), "x".repeat(5000));
assert.deepEqual(formatTelegramAgentMessage("hello\nworld"), {
	text: "hello\nworld",
	parseMode: "HTML",
});
assert.deepEqual(formatTelegramTitledMessage("", "hello\nworld"), {
	text: "hello\nworld",
	parseMode: "HTML",
});
assert.equal(summarizeTelegramToolCall("bash", { command: "bun run check" }), "bash · bun run check");
assert.equal(
	summarizeTelegramToolCall("read", { path: "/tmp/example.txt" }),
	"read · /tmp/example.txt",
);
assert.equal(
	buildTelegramWorkStatusMessage(3, "bash · bun run check"),
	"<b>⚙️ Working</b>\n<pre>turn 3\nbash · bun run check</pre>",
);
assert.equal(
	isStaleExtensionContextError(
		new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().",
		),
	),
	true,
);
assert.equal(isStaleExtensionContextError(new Error("something else")), false);
assert.equal(previewText("hello world", 20), "hello world");
assert.equal(previewText("x".repeat(50), 10), "xxxxxxxxx…");
assert.equal(
	extractTextContent([
		{ type: "text", text: "one" },
		{ type: "image" },
		{ type: "text", text: "two" },
	]),
	"one\ntwo",
);
assert.deepEqual(buildTelegramCompletionNotification([], false), {
	title: "",
	body: "✅ Done! Pi is idling in the local session, ready for your next move.",
});
assert.deepEqual(buildTelegramCompletionNotification([], true), {
	title: "",
	body: TELEGRAM_API_ERROR_FALLBACK,
});
assert.deepEqual(
	buildTelegramCompletionNotification(
		[{ role: "assistant", stopReason: "error", errorMessage: "usage limit" }],
		false,
	),
	{
		title: "",
		body: TELEGRAM_API_ERROR_FALLBACK,
	},
);
assert.deepEqual(getTelegramResetStartupBehavior("new_session"), {
	startupMessage: "✨ Fresh start! New Pi session is live.",
	includeAttachWarning: true,
	historyResetMode: undefined,
});
assert.deepEqual(getTelegramResetStartupBehavior("clear"), {
	startupMessage: undefined,
	includeAttachWarning: false,
	historyResetMode: "whole-chat",
});
assert.equal(getTelegramPollingOffset(undefined), undefined);
assert.equal(getTelegramPollingOffset(0), 1);
assert.equal(getTelegramPollingOffset(9), 10);
assert.deepEqual(
	getTelegramHistoryResetMessageIds({
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3, 5, 3],
			pending: [],
			attachments: [],
			steering: [],
		},
		mode: "tracked",
	}),
	[5, 3, 2, 1],
);
assert.deepEqual(
	getTelegramHistoryResetMessageIds({
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3, 5],
			pending: [],
			attachments: [],
			steering: [],
		},
		mode: "whole-chat",
	}),
	[5, 4, 3, 2, 1],
);
assert.deepEqual(
	prepareTelegramRemoteHistoryReset({
		state: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3],
			pending: [],
			attachments: [],
			steering: [],
		},
		pendingUpdates: [],
		chatId: 1,
		mode: "tracked",
	}),
	{
		nextState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3],
			pending: [],
			attachments: [],
			steering: [],
		},
		messageIdsToDelete: [3, 2, 1],
		pollingOffset: 10,
	},
);
assert.deepEqual(
	prepareTelegramRemoteHistoryReset({
		state: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3],
			pending: [],
			attachments: [],
			steering: [],
		},
		pendingUpdates: [
			{ update_id: 11 },
			{ update_id: 12, message: { message_id: 4, date: 1, chat: { id: 2, type: "private" } } },
			{ update_id: 13, message: { message_id: 5, date: 1, chat: { id: 1, type: "private" } } },
			{ update_id: 14, message: { message_id: 3, date: 1, chat: { id: 1, type: "private" } } },
		],
		chatId: 1,
		mode: "whole-chat",
	}),
	{
		nextState: {
			version: 2,
			lastUpdateId: 14,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		cleanupState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [3, 5],
			pending: [],
			attachments: [],
			steering: [],
		},
		messageIdsToDelete: [5, 4, 3, 2, 1],
		pollingOffset: 15,
	},
);
const { transport: newSessionTransport } = await buildTelegramProviderForTest({});
assert.deepEqual(newSessionTransport.consumedOffsets, []);
assert.deepEqual(newSessionTransport.deletedMessageIds, []);
assert.deepEqual(newSessionTransport.startedOffsets, [10]);
const { transport: clearTransport } = await buildTelegramProviderForTest({
	historyResetMode: "whole-chat",
	pendingUpdates: [
		{ update_id: 12, message: { message_id: 4, date: 1, chat: { id: 1, type: "private" } } },
		{ update_id: 13, message: { message_id: 5, date: 1, chat: { id: 1, type: "private" } } },
	],
});
assert.deepEqual(clearTransport.consumedOffsets, [10]);
assert.deepEqual(clearTransport.deletedMessageIds, [5, 4, 3, 2, 1]);
assert.deepEqual(clearTransport.startedOffsets, [14]);
const { transport: emptyAttachTransport, provider: emptyAttachProvider } =
	await buildTelegramProviderForTest({
		historyResetMode: "tracked",
		pendingUpdates: [
			{ update_id: 101, message: { message_id: 7, date: 1, chat: { id: 1, type: "private" } } },
		],
		cleanupState: {
			version: 2,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
	});
assert.deepEqual(emptyAttachTransport.consumedOffsets, [undefined]);
assert.deepEqual(emptyAttachTransport.deletedMessageIds, [7]);
assert.deepEqual(emptyAttachTransport.startedOffsets, [102]);
assert.equal(emptyAttachProvider.getStateSnapshot().lastUpdateId, 101);
assert.equal(
	isTelegramOwnerStateStale(
		{
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 123,
			busy: false,
			updatedAt: 10_000,
		},
		{ now: 10_500, staleMs: 90_000, isPidAlive: () => false },
	),
	true,
);
assert.deepEqual(
	evaluateTelegramOwnershipClaim(
		{
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 111,
			busy: false,
			updatedAt: 10_000,
		},
		{
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			busy: false,
		},
		{ currentPid: 222, now: 10_500, staleMs: 90_000, isPidAlive: () => true },
	),
	{
		acquired: false,
		previous: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 111,
			busy: false,
			updatedAt: 10_000,
		},
		reason: "busy-owner",
	},
);
assert.deepEqual(
	evaluateTelegramOwnershipClaim(
		{
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 111,
			busy: false,
			updatedAt: 10_000,
		},
		{
			sessionId: "session-b",
			sessionFile: "/tmp/session-b.jsonl",
			cwd: "/tmp",
			busy: false,
		},
		{ currentPid: 222, now: 10_500, staleMs: 90_000, isPidAlive: () => false },
	),
	{
		acquired: true,
		previous: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 111,
			busy: false,
			updatedAt: 10_000,
		},
		reason: "stale",
	},
);
assert.deepEqual(
	mergeTelegramStates(
		{
			version: 2,
			lastUpdateId: 5,
			outboundMessageIds: [1, 2],
			inboundMessageIds: [10],
			pending: [],
			attachments: [],
			steering: [],
		},
		{
			version: 2,
			lastUpdateId: 8,
			outboundMessageIds: [2, 3],
			inboundMessageIds: [11, 10],
			pending: [],
			attachments: [],
			steering: [],
		},
	),
	{
		version: 2,
		lastUpdateId: 8,
		outboundMessageIds: [1, 2, 3],
		inboundMessageIds: [10, 11],
		pending: [],
		attachments: [],
		steering: [],
	},
);
assert.deepEqual(
	takeSteeringReactionsForBotOutput({
		version: 2,
		lastUpdateId: 9,
		outboundMessageIds: [],
		inboundMessageIds: [],
		pending: [],
		attachments: [],
		steering: [
			{ messageId: 7, text: "hello", deliverAs: "immediate", receivedAt: "now" },
			{ messageId: 8, text: "world", deliverAs: "steer", receivedAt: "later" },
		],
	}),
	{
		nextState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		messageIds: [7, 8],
	},
);
assert.equal(
	getTelegramSessionStartActivationMode({
		owner: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: process.pid,
			busy: false,
			updatedAt: Date.now(),
		},
		nextSessionId: "session-a",
		nextSessionFile: "/tmp/session-a.jsonl",
	}),
	"current-owner",
);
assert.equal(
	getTelegramSessionStartActivationMode({
		owner: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: process.pid,
			busy: false,
			updatedAt: Date.now(),
		},
		previousSessionFile: "/tmp/session-a.jsonl",
		nextSessionId: "session-b",
		nextSessionFile: "/tmp/session-b.jsonl",
	}),
	"transfer",
);
assert.equal(
	getTelegramSessionStartActivationMode({
		owner: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: 999999,
			busy: false,
			updatedAt: Date.now(),
		},
		previousSessionFile: "/tmp/session-a.jsonl",
		nextSessionId: "session-b",
		nextSessionFile: "/tmp/session-b.jsonl",
	}),
	"transfer",
);
assert.equal(
	getTelegramSessionStartActivationMode({
		owner: {
			version: 1,
			sessionId: "session-a",
			sessionFile: "/tmp/session-a.jsonl",
			cwd: "/tmp",
			pid: process.pid,
			busy: false,
			updatedAt: Date.now(),
		},
		nextSessionId: "session-b",
		nextSessionFile: "/tmp/session-b.jsonl",
	}),
	undefined,
);
assert.deepEqual(
	getTelegramPendingCleanupState({
		currentState: {
			version: 2,
			outboundMessageIds: [],
			inboundMessageIds: [],
			pending: [],
			attachments: [],
			steering: [],
		},
		persistedPreviousState: {
			version: 2,
			lastUpdateId: 9,
			outboundMessageIds: [1],
			inboundMessageIds: [2],
			pending: [],
			attachments: [],
			steering: [],
		},
		livePreviousState: {
			version: 2,
			lastUpdateId: 12,
			outboundMessageIds: [1, 3],
			inboundMessageIds: [2, 4],
			pending: [],
			attachments: [],
			steering: [],
		},
	}),
	{
		version: 2,
		lastUpdateId: 12,
		outboundMessageIds: [1, 3],
		inboundMessageIds: [2, 4],
		pending: [],
		attachments: [],
		steering: [],
	},
);
assert.deepEqual(buildTelegramSkillAlias("spec-driven-development"), {
	command: "skill_spec_driven_development",
	attemptedCommand: "skill_spec_driven_development",
});
assert.equal(
	buildTelegramSkillAlias("this-skill-name-is-far-too-long-for-telegram").reason,
	"too long for Telegram's 32-character command limit",
);
const commandState = buildTelegramCommandPublicationState([
	{
		name: "skill:tdd",
		description: "Run TDD",
		source: "skill",
		sourceInfo: {
			path: "/tmp/tdd/SKILL.md",
			source: "test",
			scope: "project",
			origin: "top-level",
			baseDir: "/tmp/tdd",
		},
	},
	{
		name: "skill:write-a-skill",
		description: "Write a skill",
		source: "skill",
		sourceInfo: {
			path: "/tmp/write-a-skill/SKILL.md",
			source: "test",
			scope: "project",
			origin: "top-level",
			baseDir: "/tmp/write-a-skill",
		},
	},
	{
		name: "skill:foo-bar",
		description: "Foo bar",
		source: "skill",
		sourceInfo: {
			path: "/tmp/foo-bar/SKILL.md",
			source: "test",
			scope: "project",
			origin: "top-level",
			baseDir: "/tmp/foo-bar",
		},
	},
	{
		name: "skill:foo_bar",
		description: "Foo bar underscore",
		source: "skill",
		sourceInfo: {
			path: "/tmp/foo_bar/SKILL.md",
			source: "test",
			scope: "project",
			origin: "top-level",
			baseDir: "/tmp/foo_bar",
		},
	},
]);
assert.equal(
	commandState.publishedCommands.some((command) => command.command === "context"),
	true,
);
assert.equal(
	commandState.publishedCommands.some((command) => command.command === "refresh"),
	true,
);
assert.equal(commandState.publishedSkills.some((skill) => skill.command === "skill_tdd"), true);
assert.equal(
	commandState.publishedSkills.some(
		(skill) => skill.command === "skill_write_a_skill",
	),
	true,
);
assert.equal(
	commandState.unpublishedSkills.some(
		(skill) => skill.skillName === "foo-bar" && skill.reason === "collides with another skill alias",
	),
	true,
);
assert.equal(
	commandState.unpublishedSkills.some(
		(skill) =>
			skill.skillName === "foo_bar" && skill.reason === "collides with another skill alias",
	),
	true,
);

console.log("telegram tests passed");
