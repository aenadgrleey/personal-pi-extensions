import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildAttachmentForwardText, getTelegramInboundFile, saveTelegramFile } from "./files.js";
import {
	formatTelegramAgentMessage,
	formatTelegramTitledMessage,
	injectReplyContext,
	normalizeTelegramTextLiteral,
	previewText,
	splitTelegramMessage,
	type TelegramTextLiteral,
} from "./formatting.js";
import {
	TELEGRAM_UI_TEXT,
	TELEGRAM_QUEUE_REACTION,
	TELEGRAM_WORK_GIF_URL,
	TELEGRAM_WORK_REACTION,
	buildTelegramWorkStatusMessage,
	formatTelegramArmedSkillMessage,
	formatTelegramArmedSkillUnavailableMessage,
	formatTelegramDetachMessage,
	formatTelegramOtherAnswerPrompt,
	formatTelegramPlanFeedbackPrompt,
	formatTelegramPlanPrompt,
	formatTelegramQuestionOptionButton,
	formatTelegramQuestionOtherButton,
	formatTelegramQuestionPrompt,
	formatTelegramRefreshResult,
	formatTelegramResolutionNote,
	formatTelegramReviewFeedbackPrompt,
	formatTelegramReviewPrompt,
	formatTelegramSkillLoadFailure,
	formatTelegramUnknownCommandMessage,
	formatTelegramUnpublishedSkillMessage,
	summarizeTelegramToolCall,
} from "./texts-user.js";
import type { InteractionProvider, PresentedInteraction } from "./hub.js";
import {
	buildTelegramCommandPublicationState,
	buildTelegramSkillPrompt,
	formatTelegramAttachWarning,
	formatTelegramHelpMessage,
	formatTelegramSkillsMessage,
} from "./session-control.js";
import { createEmptyTelegramState, trimTrackedState, TELEGRAM_STATE_TYPE } from "./state.js";
import { TelegramTransport, type TelegramSendMessageOptions } from "./transport.js";
import type {
	AttachmentRecord,
	PendingInteractionRecord,
	PersistedPendingInteraction,
	SteeringRecord,
	TelegramCommandPublicationState,
	TelegramConfig,
	TelegramMessage,
	TelegramPublishedSkillCommand,
	TelegramStateSnapshot,
	TelegramUpdate,
} from "./types.js";

export type TelegramHistoryResetMode = "tracked" | "whole-chat";

interface TelegramProviderOptions {
	pi: ExtensionAPI;
	config: TelegramConfig;
	getIsIdle: () => boolean;
	getSessionId: () => string;
	getSignal: () => AbortSignal | undefined;
	getCommandEntries: () => ReturnType<ExtensionAPI["getCommands"]>;
	getStatusMessage: (state: TelegramCommandPublicationState) => string;
	getContextMessage: () => string;
	handleSessionReset: (
		intent: "new_session" | "clear",
	) => Promise<{ started: boolean; message: string }>;
	handleDetach: () => Promise<void>;
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	currentState: TelegramStateSnapshot;
	cleanupState: TelegramStateSnapshot;
	startupMessages?: string[];
	includeAttachWarning?: boolean;
	historyResetMode?: TelegramHistoryResetMode;
	transport?: TelegramTransport;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const MIN_REACTION_VISIBLE_MS = 1500;
const STALE_EXTENSION_CONTEXT_ERROR =
	"This extension ctx is stale after session replacement or reload.";

export { buildTelegramWorkStatusMessage, summarizeTelegramToolCall };

export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_ERROR);
}

function getMessageText(message: TelegramMessage | undefined): string | undefined {
	return message?.text?.trim() || message?.caption?.trim();
}

function parseTelegramCommand(text: string): { command: string; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const firstSpace = trimmed.indexOf(" ");
	const rawCommand = firstSpace < 0 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
	const command = rawCommand.split("@")[0]?.trim().toLowerCase();
	if (!command) return undefined;
	return {
		command,
		args: firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim(),
	};
}

function matchesPendingMessage(
	pending: PersistedPendingInteraction,
	messageId: number | undefined,
): boolean {
	if (!messageId) return false;
	return (
		pending.activeMessageId === messageId ||
		pending.promptMessageIds.includes(messageId) ||
		pending.helperMessageIds.includes(messageId)
	);
}

export function takeSteeringReactionsForBotOutput(state: TelegramStateSnapshot): {
	nextState: TelegramStateSnapshot;
	messageIds: number[];
} {
	return {
		nextState: {
			...state,
			steering: [],
		},
		messageIds: state.steering.map((item) => item.messageId),
	};
}

export function getTelegramPollingOffset(lastUpdateId: number | undefined): number | undefined {
	return lastUpdateId === undefined ? undefined : lastUpdateId + 1;
}

export function getTelegramHistoryResetMessageIds(params: {
	cleanupState: TelegramStateSnapshot;
	mode: TelegramHistoryResetMode;
}): number[] {
	const trackedMessageIds = [
		...new Set([...params.cleanupState.outboundMessageIds, ...params.cleanupState.inboundMessageIds]),
	].sort((left, right) => left - right);
	if (trackedMessageIds.length === 0) return [];
	if (params.mode === "tracked") {
		return [...trackedMessageIds].reverse();
	}
	const maxTrackedMessageId = trackedMessageIds[trackedMessageIds.length - 1];
	if (maxTrackedMessageId === undefined) return [];
	return Array.from({ length: maxTrackedMessageId }, (_, index) => maxTrackedMessageId - index);
}

export function prepareTelegramRemoteHistoryReset(params: {
	state: TelegramStateSnapshot;
	cleanupState: TelegramStateSnapshot;
	pendingUpdates: TelegramUpdate[];
	chatId?: number;
	mode: TelegramHistoryResetMode;
}): {
	nextState: TelegramStateSnapshot;
	cleanupState: TelegramStateSnapshot;
	messageIdsToDelete: number[];
	pollingOffset: number | undefined;
} {
	const pendingInboundMessageIds = params.pendingUpdates
		.map((update) => {
			const message = update.message;
			if (!message) return undefined;
			if (params.chatId !== undefined && message.chat.id !== params.chatId) return undefined;
			return message.message_id;
		})
		.filter((messageId): messageId is number => typeof messageId === "number");
	const lastPendingUpdateId = params.pendingUpdates[params.pendingUpdates.length - 1]?.update_id;
	const nextLastUpdateId =
		lastPendingUpdateId === undefined
			? params.state.lastUpdateId
			: Math.max(params.state.lastUpdateId ?? 0, lastPendingUpdateId);
	const cleanupState =
		pendingInboundMessageIds.length === 0
			? params.cleanupState
			: {
				...params.cleanupState,
				inboundMessageIds: [
					...new Set([...params.cleanupState.inboundMessageIds, ...pendingInboundMessageIds]),
				],
			};
	return {
		nextState:
			nextLastUpdateId === params.state.lastUpdateId
				? params.state
				: {
					...params.state,
					lastUpdateId: nextLastUpdateId,
				},
		cleanupState,
		messageIdsToDelete: getTelegramHistoryResetMessageIds({
			cleanupState,
			mode: params.mode,
		}),
		pollingOffset: getTelegramPollingOffset(nextLastUpdateId),
	};
}

export class TelegramInteractionProvider implements InteractionProvider {
	readonly id = "telegram";
	private readonly transport: TelegramTransport;
	private readonly options: TelegramProviderOptions;
	private readonly records = new Map<string, PendingInteractionRecord>();
	private readonly resolvers = new Map<string, PresentedInteraction<unknown>["resolve"]>();
	private readonly reactionStartedAt = new Map<number, number>();
	private commandState: TelegramCommandPublicationState;
	private state: TelegramStateSnapshot;
	private readonly startPromise: Promise<void>;
	private pollingStarted = false;
	private workMessage:
		| {
				messageId: number;
				kind: "text" | "animation";
			}
		| undefined;
	private currentWorkTurn = 1;
	private latestToolCall: string | undefined;
	private lastWorkStatusText: string | undefined;
	private initiator: string | undefined;
	private initiatorSource: "Pi" | "Telegram" | undefined;
	private readonly queuedMessageIds = new Set<number>();
	private readonly recentTelegramInitiatorCounts = new Map<string, number>();
	private workMessageOperation: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(options: TelegramProviderOptions) {
		this.options = options;
		this.transport = options.transport ?? new TelegramTransport(options.config);
		this.commandState = buildTelegramCommandPublicationState(this.options.getCommandEntries());
		const lastUpdateId =
			Math.max(options.currentState.lastUpdateId ?? 0, options.cleanupState.lastUpdateId ?? 0) ||
			undefined;
		this.state = {
			...clone(options.currentState),
			lastUpdateId,
			pending: [],
		};
		this.startPromise = this.initialize();
	}

	getSessionControlState(): TelegramCommandPublicationState {
		return clone(this.commandState);
	}

	getStateSnapshot(): TelegramStateSnapshot {
		return clone(this.state);
	}

	consumeTelegramInitiator(text: string): boolean {
		const key = text.trim();
		if (!key) return false;
		const count = this.recentTelegramInitiatorCounts.get(key) ?? 0;
		if (count <= 0) return false;
		if (count === 1) {
			this.recentTelegramInitiatorCounts.delete(key);
		} else {
			this.recentTelegramInitiatorCounts.set(key, count - 1);
		}
		return true;
	}

	private markDisposed(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.transport.stop();
	}

	private handleStaleContextError(error: unknown): boolean {
		if (!isStaleExtensionContextError(error)) return false;
		this.markDisposed();
		return true;
	}

	private async sendUserMessageToPi(
		text: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<boolean> {
		if (this.disposed) return false;
		try {
			await this.options.pi.sendUserMessage(text, options);
			return !this.disposed;
		} catch (error) {
			if (this.handleStaleContextError(error)) return false;
			throw error;
		}
	}

	private persistState(): void {
		if (this.disposed) return;
		try {
			this.options.pi.appendEntry(TELEGRAM_STATE_TYPE, clone(this.state));
		} catch (error) {
			if (this.handleStaleContextError(error)) return;
			throw error;
		}
	}

	private async initialize(): Promise<void> {
		if (this.disposed) return;
		if (this.options.historyResetMode) {
			const pendingUpdates = await this.transport.consumePendingUpdates(
				getTelegramPollingOffset(this.state.lastUpdateId),
			);
			const resetPlan = prepareTelegramRemoteHistoryReset({
				state: this.state,
				cleanupState: this.options.cleanupState,
				pendingUpdates,
				chatId: this.options.config.chatId,
				mode: this.options.historyResetMode,
			});
			this.state = resetPlan.nextState;
			await this.resetRemoteHistory(resetPlan.messageIdsToDelete);
		}
		if (this.disposed) return;
		await this.refreshPublishedCommands();
		if (this.disposed) return;
		await this.startPolling();
		if (this.disposed) return;
		const startupMessages = [...(this.options.startupMessages ?? [])];
		const attachWarning =
			this.options.includeAttachWarning === false
				? undefined
				: formatTelegramAttachWarning(this.commandState);
		if (attachWarning) startupMessages.push(attachWarning);
		for (const message of startupMessages) {
			if (this.disposed) return;
			await this.sendSystemMessage(message);
		}
	}

	private async startPolling(): Promise<void> {
		if (this.pollingStarted || this.disposed) return;
		this.pollingStarted = true;
		void this.transport.start(
			async (update) => {
				if (this.disposed) return;
				this.state.lastUpdateId = update.update_id;
				this.persistState();
				if (this.disposed) return;
				await this.handleUpdate(update);
			},
			getTelegramPollingOffset(this.state.lastUpdateId),
		);
	}

	private async refreshPublishedCommands(): Promise<TelegramCommandPublicationState> {
		if (this.disposed) return clone(this.commandState);
		const nextState = buildTelegramCommandPublicationState(this.options.getCommandEntries());
		try {
			await this.transport.setMyCommands(nextState.publishedCommands);
			if (this.disposed) return clone(this.commandState);
			this.commandState = nextState;
		} catch (error) {
			this.commandState = {
				...nextState,
				publishError: error instanceof Error ? error.message : String(error),
			};
		}
		return clone(this.commandState);
	}

	private async clearSteeringReactionsOnBotOutput(): Promise<void> {
		const { nextState, messageIds } = takeSteeringReactionsForBotOutput(this.state);
		if (messageIds.length === 0) return;
		this.state = nextState;
		this.persistState();
		for (const messageId of messageIds) {
			await this.setQueuedReaction(messageId, false);
		}
	}

	private async promoteQueuedMessages(messageIds: Iterable<number>): Promise<void> {
		const ids = [...new Set([...messageIds].filter((messageId) => Number.isFinite(messageId)))];
		if (ids.length === 0) return;
		const idSet = new Set(ids);
		const nextSteering = this.state.steering.filter((item) => !idSet.has(item.messageId));
		if (nextSteering.length !== this.state.steering.length) {
			this.state.steering = nextSteering;
			this.persistState();
		}
		for (const messageId of ids) {
			await this.setQueuedReaction(messageId, true);
		}
	}

	private findSteeringMessageId(text: string): number | undefined {
		const preview = previewText(text, 500);
		return this.state.steering.find((item) => item.text === preview)?.messageId;
	}

	private async sendBotMessage(
		text: string | TelegramTextLiteral,
		options: TelegramSendMessageOptions = {},
	): Promise<TelegramMessage | undefined> {
		if (this.disposed) return undefined;
		await this.clearSteeringReactionsOnBotOutput();
		if (this.disposed) return undefined;
		const literal = normalizeTelegramTextLiteral(text);
		const message = await this.transport.sendMessage(literal.text, {
			...options,
			parseMode: literal.parseMode ?? options.parseMode,
		});
		if (this.disposed) return undefined;
		this.trackOutbound(message.message_id);
		return message;
	}

	private async sendBotMessageChunks(
		text: string,
		options: TelegramSendMessageOptions & {
			formatter?: (chunk: string) => string | TelegramTextLiteral;
		} = {},
	): Promise<TelegramMessage[]> {
		if (this.disposed) return [];
		const chunks = splitTelegramMessage(text, 3600);
		const formatChunk = options.formatter ?? ((chunk: string) => chunk);
		const messages: TelegramMessage[] = [];
		for (let index = 0; index < chunks.length; index++) {
			if (this.disposed) return messages;
			const chunk = chunks[index];
			if (!chunk) continue;
			const message = await this.sendBotMessage(formatChunk(chunk), {
				parseMode: options.parseMode,
				replyToMessageId: index === 0 ? options.replyToMessageId : undefined,
				replyMarkup: index === chunks.length - 1 ? options.replyMarkup : undefined,
			});
			if (!message) return messages;
			messages.push(message);
		}
		return messages;
	}

	private async sendSystemMessage(text: string, title?: string): Promise<void> {
		await this.sendBotMessageChunks(text, {
			formatter: (chunk) =>
				title ? formatTelegramTitledMessage(title, chunk) : formatTelegramAgentMessage(chunk),
		});
	}

	private async setEyesReaction(messageId: number): Promise<void> {
		try {
			await this.transport.setMessageReaction(messageId, TELEGRAM_QUEUE_REACTION);
		} catch {
			// ignore best-effort reaction errors
		}
	}

	private async runWorkMessageOperation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.workMessageOperation;
		let release: (() => void) | undefined;
		this.workMessageOperation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}

	private async upsertWorkMessage(): Promise<void> {
		if (this.disposed) return;
		await this.runWorkMessageOperation(async () => {
			if (this.disposed) return;
			const text = buildTelegramWorkStatusMessage(
				this.currentWorkTurn,
				this.latestToolCall,
				this.initiator,
				this.initiatorSource,
			);
			if (this.lastWorkStatusText === text && this.workMessage) return;
			this.lastWorkStatusText = text;
			if (this.workMessage) {
				try {
					if (this.workMessage.kind === "animation") {
						await this.transport.editMessageCaption(this.workMessage.messageId, text);
					} else {
						await this.transport.editMessageText(this.workMessage.messageId, text);
					}
					return;
				} catch {
					this.workMessage = undefined;
				}
			}
			await this.clearSteeringReactionsOnBotOutput();
			if (this.disposed) return;
			try {
				const message = await this.transport.sendAnimation(TELEGRAM_WORK_GIF_URL, text);
				if (this.disposed) return;
				this.trackOutbound(message.message_id);
				this.workMessage = { messageId: message.message_id, kind: "animation" };
				return;
			} catch {
				const message = await this.transport.sendMessage(text);
				if (this.disposed) return;
				this.trackOutbound(message.message_id);
				this.workMessage = { messageId: message.message_id, kind: "text" };
			}
		});
	}

	private async clearWorkMessage(): Promise<void> {
		await this.runWorkMessageOperation(async () => {
			const current = this.workMessage;
			this.workMessage = undefined;
			this.lastWorkStatusText = undefined;
			this.latestToolCall = undefined;
			this.currentWorkTurn = 1;
			this.initiator = undefined;
			this.initiatorSource = undefined;
			this.queuedMessageIds.clear();
			if (!current) return;
			try {
				await this.transport.deleteMessage(current.messageId);
			} catch {
				// ignore best-effort cleanup errors
			}
		});
	}

	private async deleteTrackedMessages(messageIds: number[]): Promise<void> {
		for (const messageId of [...new Set(messageIds)]) {
			if (this.disposed) return;
			try {
				await this.transport.deleteMessage(messageId);
			} catch {
				// ignore best-effort cleanup errors
			}
		}
	}

	private async resetRemoteHistory(messageIds: number[]): Promise<void> {
		if (this.disposed) return;
		await this.deleteTrackedMessages(messageIds);
		if (this.disposed) return;
		this.workMessage = undefined;
		this.lastWorkStatusText = undefined;
		this.latestToolCall = undefined;
		this.currentWorkTurn = 1;
		this.initiator = undefined;
		this.queuedMessageIds.clear();
		this.state = {
			...createEmptyTelegramState(),
			lastUpdateId: this.state.lastUpdateId,
		};
		this.persistState();
	}

	private trackOutbound(messageId: number): void {
		this.state.outboundMessageIds = trimTrackedState(
			[...this.state.outboundMessageIds, messageId],
			200,
		);
		this.persistState();
	}

	private trackInbound(messageId: number): void {
		this.state.inboundMessageIds = trimTrackedState(
			[...this.state.inboundMessageIds, messageId],
			200,
		);
		this.persistState();
	}

	private async setQueuedReaction(messageId: number, active: boolean): Promise<void> {
		try {
			if (active) {
				this.reactionStartedAt.set(messageId, Date.now());
				await this.transport.setMessageReaction(messageId, TELEGRAM_WORK_REACTION);
				return;
			}

			const startedAt = this.reactionStartedAt.get(messageId);
			if (startedAt) {
				const elapsed = Date.now() - startedAt;
				if (elapsed < MIN_REACTION_VISIBLE_MS) {
					await new Promise((resolve) => setTimeout(resolve, MIN_REACTION_VISIBLE_MS - elapsed));
				}
			}
			this.reactionStartedAt.delete(messageId);
			await this.transport.setMessageReaction(messageId, undefined);
		} catch {
			// ignore best-effort reaction errors
		}
	}

	async clearTrackedMessages(): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		await this.deleteTrackedMessages([
			...this.state.outboundMessageIds,
			...this.state.inboundMessageIds,
		]);
		if (this.disposed) return;
		this.workMessage = undefined;
		this.lastWorkStatusText = undefined;
		this.latestToolCall = undefined;
		this.currentWorkTurn = 1;
		this.initiator = undefined;
		this.queuedMessageIds.clear();
		this.state.outboundMessageIds = [];
		this.state.inboundMessageIds = [];
		this.state.pending = [];
		this.state.armedSkill = undefined;
		this.persistState();
	}

	private savePending(pending: PersistedPendingInteraction): void {
		this.state.pending = [
			...this.state.pending.filter((item) => item.interactionId !== pending.interactionId),
			clone(pending),
		];
		this.persistState();
	}

	private clearPending(interactionId: string): PersistedPendingInteraction | undefined {
		const found = this.state.pending.find((item) => item.interactionId === interactionId);
		this.state.pending = this.state.pending.filter((item) => item.interactionId !== interactionId);
		this.persistState();
		return found;
	}

	private resolveRecord(interactionId: string): PendingInteractionRecord | undefined {
		return this.records.get(interactionId);
	}

	private async markResolvingMessage(
		pending: PersistedPendingInteraction,
		messageId: number,
	): Promise<void> {
		pending.resolvingMessageId = messageId;
		this.savePending(pending);
		await this.setQueuedReaction(messageId, true);
	}

	private resolveInteraction(interactionId: string, value: unknown): void {
		this.resolvers.get(interactionId)?.({ providerId: this.id, value });
	}

	private buildQuestionKeyboard(
		record: PendingInteractionRecord,
		currentQuestionIndex: number,
	): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
		if (record.interaction.kind !== "ask") return { inline_keyboard: [] };
		const current = record.interaction.questions[currentQuestionIndex];
		if (!current) return { inline_keyboard: [] };
		const buttons = current.options.map((option, optionIndex) => ({
			text: formatTelegramQuestionOptionButton(optionIndex, option.label),
			callback_data: `ask:${currentQuestionIndex}:${optionIndex}`,
		}));
		if (current.allowOther !== false) {
			buttons.push({
				text: formatTelegramQuestionOtherButton(current.options.length),
				callback_data: `ask:${currentQuestionIndex}:other`,
			});
		}
		return { inline_keyboard: buttons.map((button) => [button]) };
	}

	private async sendQuestion(
		record: PendingInteractionRecord,
		pending: PersistedPendingInteraction,
	): Promise<void> {
		if (record.interaction.kind !== "ask") return;
		const questionIndex = pending.currentQuestionIndex ?? 0;
		const question = record.interaction.questions[questionIndex];
		if (!question) return;
		const messages = await this.sendBotMessageChunks(
			formatTelegramQuestionPrompt({
				question,
				index: questionIndex,
				total: record.interaction.questions.length,
			}),
			{
				replyMarkup: this.buildQuestionKeyboard(record, questionIndex),
				formatter: (chunk) => formatTelegramAgentMessage(chunk),
			},
		);
		const activeMessage = messages.at(-1);
		if (!activeMessage) return;
		pending.activeMessageId = activeMessage.message_id;
		pending.promptMessageIds.push(...messages.map((message) => message.message_id));
		this.savePending(pending);
	}

	private async deliverAsk(record: PendingInteractionRecord): Promise<void> {
		await this.sendQuestion(record, {
			interactionId: record.id,
			kind: "ask",
			promptMessageIds: [],
			helperMessageIds: [],
			currentQuestionIndex: 0,
			answers: [],
			createdAt: record.createdAt,
		});
	}

	private async deliverPlan(record: PendingInteractionRecord): Promise<void> {
		if (record.interaction.kind !== "plan") return;
		const messages = await this.sendBotMessageChunks(
			formatTelegramPlanPrompt(
				record.interaction.params.title,
				record.interaction.params.phases,
				record.interaction.params.context,
			),
			{
				formatter: (chunk) => formatTelegramAgentMessage(chunk),
				replyMarkup: {
					inline_keyboard: [
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.accept, callback_data: "plan:accepted" }],
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.save, callback_data: "plan:saved" }],
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.refine, callback_data: "plan:refined" }],
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.discard, callback_data: "plan:discarded" }],
					],
				},
			},
		);
		const activeMessage = messages.at(-1);
		if (!activeMessage) return;
		this.savePending({
			interactionId: record.id,
			kind: "plan",
			activeMessageId: activeMessage.message_id,
			promptMessageIds: messages.map((message) => message.message_id),
			helperMessageIds: [],
			createdAt: record.createdAt,
		});
	}

	private async deliverReview(record: PendingInteractionRecord): Promise<void> {
		if (record.interaction.kind !== "review") return;
		const messages = await this.sendBotMessageChunks(
			formatTelegramReviewPrompt(
				record.interaction.params.decision,
				record.interaction.params.summary,
				record.interaction.params.context,
			),
			{
				formatter: (chunk) => formatTelegramAgentMessage(chunk),
				replyMarkup: {
					inline_keyboard: [
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.keepAsIs, callback_data: "review:continue" }],
						[{ text: TELEGRAM_UI_TEXT.interactionButtons.revise, callback_data: "review:redefine" }],
					],
				},
			},
		);
		const activeMessage = messages.at(-1);
		if (!activeMessage) return;
		this.savePending({
			interactionId: record.id,
			kind: "review",
			activeMessageId: activeMessage.message_id,
			promptMessageIds: messages.map((message) => message.message_id),
			helperMessageIds: [],
			createdAt: record.createdAt,
		});
	}

	private findPendingForMessage(message: TelegramMessage): PersistedPendingInteraction | undefined {
		const replyToMessageId = message.reply_to_message?.message_id;
		const matched = this.state.pending.find((pending) =>
			matchesPendingMessage(pending, replyToMessageId),
		);
		if (matched) return matched;
		if (this.state.pending.length === 1) return this.state.pending[0];
		return undefined;
	}

	private parseAskAnswer(
		record: PendingInteractionRecord,
		pending: PersistedPendingInteraction,
		text: string,
	): { answer: string; wasCustom: boolean; index?: number } | undefined {
		if (record.interaction.kind !== "ask") return undefined;
		const question = record.interaction.questions[pending.currentQuestionIndex ?? 0];
		if (!question) return undefined;
		const normalized = text.trim();
		if (!normalized) return undefined;
		const optionNumber = Number.parseInt(normalized, 10);
		if (
			Number.isFinite(optionNumber) &&
			optionNumber >= 1 &&
			optionNumber <= question.options.length
		) {
			const option = question.options[optionNumber - 1];
			if (!option) return undefined;
			return { answer: option.label, wasCustom: false, index: optionNumber };
		}
		const optionIndex = question.options.findIndex(
			(option) => option.label.toLowerCase() === normalized.toLowerCase(),
		);
		if (optionIndex >= 0) {
			const option = question.options[optionIndex];
			if (!option) return undefined;
			return {
				answer: option.label,
				wasCustom: false,
				index: optionIndex + 1,
			};
		}
		if (question.allowOther === false) return undefined;
		return { answer: normalized, wasCustom: true };
	}

	private async resolveAskFromText(
		pending: PersistedPendingInteraction,
		record: PendingInteractionRecord,
		text: string,
		messageId: number,
	): Promise<boolean> {
		const parsed = this.parseAskAnswer(record, pending, text);
		if (!parsed || record.interaction.kind !== "ask") return false;
		const question = record.interaction.questions[pending.currentQuestionIndex ?? 0];
		if (!question) return false;
		const answers = [...(pending.answers ?? []), { id: question.id, ...parsed }];
		const nextIndex = (pending.currentQuestionIndex ?? 0) + 1;
		if (nextIndex < record.interaction.questions.length) {
			pending.answers = answers;
			pending.currentQuestionIndex = nextIndex;
			this.savePending(pending);
			await this.sendQuestion(record, pending);
			return true;
		}
		await this.markResolvingMessage(pending, messageId);
		this.resolveInteraction(record.id, { answers, cancelled: false });
		return true;
	}

	private findPublishedSkill(command: string): TelegramPublishedSkillCommand | undefined {
		return this.commandState.publishedSkills.find((skill) => skill.command === command);
	}

	private rememberTelegramInitiator(text: string): void {
		const key = text.trim();
		if (!key) return;
		this.recentTelegramInitiatorCounts.set(key, (this.recentTelegramInitiatorCounts.get(key) ?? 0) + 1);
	}

	private async deliverPrompt(text: string, messageId: number): Promise<void> {
		if (this.disposed) return;
		const isIdle = this.options.getIsIdle();
		const deliverAs = isIdle ? "immediate" : "steer";
		const steeringRecord: SteeringRecord = {
			messageId,
			text: previewText(text, 500),
			deliverAs,
			receivedAt: new Date().toISOString(),
		};
		this.state.steering = trimTrackedState([...this.state.steering, steeringRecord]);
		this.persistState();
		if (this.disposed) return;
		this.rememberTelegramInitiator(text);
		if (isIdle) {
			await this.setQueuedReaction(messageId, true); // 👨‍💻 — agent picks it up immediately
			const delivered = await this.sendUserMessageToPi(text);
			if (!delivered) return;
			this.initiator = text;
			this.initiatorSource = "Telegram";
			await this.upsertWorkMessage();
			return;
		}
		// Steer: show 👀 while message waits in the queue
		await this.setEyesReaction(messageId);
		this.queuedMessageIds.add(messageId);
		await this.sendUserMessageToPi(text, { deliverAs: "steer" });
	}

	private async runSkill(
		skill: TelegramPublishedSkillCommand,
		task: string,
		messageId: number,
	): Promise<boolean> {
		const trimmedTask = task.trim();
		if (!trimmedTask) return false;
		try {
			const prompt = buildTelegramSkillPrompt(skill, trimmedTask);
			await this.deliverPrompt(prompt, messageId);
			return true;
		} catch (error) {
			await this.sendSystemMessage(
				formatTelegramSkillLoadFailure(
					skill.skillName,
					error instanceof Error ? error.message : undefined,
				),
			);
			return true;
		}
	}

	private async handleCommandMessage(message: TelegramMessage): Promise<boolean> {
		const text = getMessageText(message);
		if (!text) return false;
		const parsed = parseTelegramCommand(text);
		if (!parsed) return false;

		switch (parsed.command) {
			case "new_session":
			case "clear": {
				const result = await this.options.handleSessionReset(parsed.command);
				if (!result.started) {
					await this.sendSystemMessage(result.message);
				}
				return true;
			}
			case "skills":
				await this.sendSystemMessage(formatTelegramSkillsMessage(this.commandState));
				return true;
			case "status":
				await this.sendSystemMessage(this.options.getStatusMessage(this.commandState));
				return true;
			case "refresh": {
				const refreshed = await this.refreshPublishedCommands();
				await this.sendSystemMessage(formatTelegramRefreshResult(refreshed));
				return true;
			}
			case "context":
				await this.sendSystemMessage(this.options.getContextMessage());
				return true;
			case "help":
				await this.sendSystemMessage(formatTelegramHelpMessage(this.commandState));
				return true;
			case "detach":
				await this.sendSystemMessage(formatTelegramDetachMessage());
				await this.options.handleDetach();
				return true;
		}

		const skill = this.findPublishedSkill(parsed.command);
		if (skill) {
			if (parsed.args) {
				await this.runSkill(skill, parsed.args, message.message_id);
				this.state.armedSkill = undefined;
				this.persistState();
				return true;
			}
			this.state.armedSkill = {
				skillName: skill.skillName,
				command: skill.command,
				armedAt: new Date().toISOString(),
			};
			this.persistState();
			await this.sendSystemMessage(formatTelegramArmedSkillMessage(skill.command));
			return true;
		}

		const unpublished = this.commandState.unpublishedSkills.find(
			(candidate) => candidate.attemptedCommand === parsed.command,
		);
		if (unpublished) {
			await this.sendSystemMessage(
				formatTelegramUnpublishedSkillMessage(unpublished.skillName, unpublished.reason),
			);
			return true;
		}

		await this.sendSystemMessage(formatTelegramUnknownCommandMessage());
		return true;
	}

	private async handleArmedSkill(message: TelegramMessage): Promise<boolean> {
		const armed = this.state.armedSkill;
		if (!armed) return false;
		const text = getMessageText(message)?.trim();
		if (!text) return false;
		const skill = this.findPublishedSkill(armed.command);
		this.state.armedSkill = undefined;
		this.persistState();
		if (!skill) {
			await this.sendSystemMessage(
				formatTelegramArmedSkillUnavailableMessage(armed.command),
			);
			return true;
		}
		return this.runSkill(skill, text, message.message_id);
	}

	private async handleTextMessage(message: TelegramMessage): Promise<boolean> {
		const text = getMessageText(message);
		if (!text) return false;
		const pending = this.findPendingForMessage(message);
		if (!pending) return false;
		const record = this.resolveRecord(pending.interactionId);
		if (!record) return false;
		if (record.interaction.kind === "ask") {
			return this.resolveAskFromText(pending, record, text, message.message_id);
		}
		if (record.interaction.kind === "plan") {
			const normalized = text.toLowerCase().trim();
			if (["accept", "accepted", "1"].includes(normalized)) {
				await this.markResolvingMessage(pending, message.message_id);
				this.resolveInteraction(record.id, { action: "accepted" });
				return true;
			}
			if (["save", "saved", "2"].includes(normalized)) {
				await this.markResolvingMessage(pending, message.message_id);
				this.resolveInteraction(record.id, { action: "saved" });
				return true;
			}
			if (["discard", "discarded", "4"].includes(normalized)) {
				await this.markResolvingMessage(pending, message.message_id);
				this.resolveInteraction(record.id, { action: "discarded" });
				return true;
			}
			await this.markResolvingMessage(pending, message.message_id);
			this.resolveInteraction(record.id, { action: "refined", feedback: text.trim() });
			return true;
		}
		if (record.interaction.kind === "review") {
			const normalized = text.toLowerCase().trim();
			if (["keep as is", "keep", "continue", "1"].includes(normalized)) {
				await this.markResolvingMessage(pending, message.message_id);
				this.resolveInteraction(record.id, { decision: "continue" });
				return true;
			}
			await this.markResolvingMessage(pending, message.message_id);
			this.resolveInteraction(record.id, {
				decision: "redefine",
				feedback: text.trim(),
			});
			return true;
		}
		return false;
	}

	private async handleCallback(update: TelegramUpdate): Promise<boolean> {
		const callback = update.callback_query;
		const data = callback?.data;
		const message = callback?.message;
		if (!callback || !data || !message || message.chat.id !== this.options.config.chatId) {
			return false;
		}
		await this.transport.answerCallbackQuery(callback.id);
		const pending = this.state.pending.find((item) =>
			matchesPendingMessage(item, message.message_id),
		);
		if (!pending) return false;
		const record = this.resolveRecord(pending.interactionId);
		if (!record) return false;
		if (record.interaction.kind === "ask" && data.startsWith("ask:")) {
			const [, questionIndexRaw, optionRaw] = data.split(":");
			const questionIndex = Number.parseInt(questionIndexRaw || "0", 10);
			const question = record.interaction.questions[questionIndex];
			if (!question) return false;
			if (optionRaw === "other") {
				const helper = await this.sendBotMessage(
					formatTelegramAgentMessage(formatTelegramOtherAnswerPrompt(question.question)),
					{ replyToMessageId: message.message_id },
				);
				if (!helper) return true;
				pending.helperMessageIds.push(helper.message_id);
				this.savePending(pending);
				return true;
			}
			const optionIndex = Number.parseInt(optionRaw || "0", 10);
			const option = Number.isFinite(optionIndex) ? question.options[optionIndex] : undefined;
			if (!option) return false;
			const answers = [
				...(pending.answers ?? []),
				{ id: question.id, answer: option.label, wasCustom: false, index: optionIndex + 1 },
			];
			const nextIndex = questionIndex + 1;
			if (nextIndex < record.interaction.questions.length) {
				pending.answers = answers;
				pending.currentQuestionIndex = nextIndex;
				this.savePending(pending);
				await this.sendQuestion(record, pending);
				return true;
			}
			this.resolveInteraction(record.id, { answers, cancelled: false });
			return true;
		}
		if (record.interaction.kind === "plan" && data.startsWith("plan:")) {
			const action = data.slice("plan:".length) as "accepted" | "saved" | "refined" | "discarded";
			if (action === "refined") {
				const helper = await this.sendBotMessage(
					formatTelegramAgentMessage(
						formatTelegramPlanFeedbackPrompt(record.interaction.params.title),
					),
					{ replyToMessageId: message.message_id },
				);
				if (!helper) return true;
				pending.helperMessageIds.push(helper.message_id);
				this.savePending(pending);
				return true;
			}
			this.resolveInteraction(record.id, { action });
			return true;
		}
		if (record.interaction.kind === "review" && data.startsWith("review:")) {
			const decision = data.slice("review:".length) as "continue" | "redefine";
			if (decision === "redefine") {
				const helper = await this.sendBotMessage(
					formatTelegramAgentMessage(
						formatTelegramReviewFeedbackPrompt(record.interaction.params.decision),
					),
					{ replyToMessageId: message.message_id },
				);
				if (!helper) return true;
				pending.helperMessageIds.push(helper.message_id);
				this.savePending(pending);
				return true;
			}
			this.resolveInteraction(record.id, { decision });
			return true;
		}
		return false;
	}

	private async forwardInboundMessage(message: TelegramMessage): Promise<void> {
		const file = getTelegramInboundFile(message);
		let text = getMessageText(message) || "";
		if (file) {
			const saved = await saveTelegramFile(
				this.transport,
				this.options.getSessionId(),
				file,
				this.options.getSignal(),
			);
			const attachmentRecord: AttachmentRecord = {
				messageId: message.message_id,
				fileId: saved.fileId,
				localPath: saved.localPath,
				fileName: saved.fileName,
				kind: saved.kind,
				receivedAt: new Date().toISOString(),
			};
			this.state.attachments = trimTrackedState([...this.state.attachments, attachmentRecord]);
			this.persistState();
			text = [text, buildAttachmentForwardText(saved)].filter(Boolean).join("\n\n");
		}
		const forwarded = injectReplyContext(text, getMessageText(message.reply_to_message));
		if (!forwarded.trim()) return;
		await this.deliverPrompt(forwarded, message.message_id);
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (this.disposed) return;
		if (await this.handleCallback(update)) return;
		if (this.disposed) return;
		const message = update.message;
		if (!message || message.chat.id !== this.options.config.chatId) return;
		this.trackInbound(message.message_id);
		if (this.disposed) return;
		if (await this.handleCommandMessage(message)) return;
		if (this.disposed) return;
		if (await this.handleTextMessage(message)) return;
		if (this.disposed) return;
		if (await this.handleArmedSkill(message)) return;
		if (this.disposed) return;
		await this.forwardInboundMessage(message);
	}

	async onAgentStart(initiator?: { text: string; source: "Pi" | "Telegram" }): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		this.currentWorkTurn = 1;
		this.latestToolCall = undefined;
		this.initiator = initiator?.text;
		this.initiatorSource = initiator?.source;
		// Upgrade 👀 reactions to 👨‍💻 — messages are now in context
		await this.promoteQueuedMessages(this.queuedMessageIds);
		this.queuedMessageIds.clear();
		await this.upsertWorkMessage();
	}

	async onTurnStart(turnIndex: number): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		this.currentWorkTurn = Math.max(1, turnIndex + 1);
		await this.upsertWorkMessage();
	}

	async onToolExecutionStart(toolName: string, args: unknown): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		this.latestToolCall = summarizeTelegramToolCall(toolName, args);
		await this.upsertWorkMessage();
	}

	async onAgentEnd(): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		// Working message is kept until notify() clears it right before the result
	}

	isActive(_ctx: ExtensionContext): boolean {
		return this.options.config.enabled;
	}

	async present<T>(pending: PresentedInteraction<T>): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		this.records.set(pending.record.id, pending.record);
		this.resolvers.set(
			pending.record.id,
			pending.resolve as PresentedInteraction<unknown>["resolve"],
		);
		switch (pending.record.interaction.kind) {
			case "ask":
				await this.deliverAsk(pending.record);
				return;
			case "plan":
				await this.deliverPlan(pending.record);
				return;
			case "review":
				await this.deliverReview(pending.record);
				return;
		}
	}

	async handleDeliveredInboundMessage(text: string): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		const messageId = this.findSteeringMessageId(text);
		if (!messageId) return;
		this.initiator = text;
		this.initiatorSource = "Telegram";
		this.latestToolCall = undefined;
		await this.promoteQueuedMessages([messageId]);
		this.queuedMessageIds.delete(messageId);
		await this.upsertWorkMessage();
	}

	async onResolved(
		record: PendingInteractionRecord,
		resolution: { providerId: string },
	): Promise<void> {
		const pending = this.clearPending(record.id);
		this.records.delete(record.id);
		this.resolvers.delete(record.id);
		if (!pending?.activeMessageId) {
			if (pending?.resolvingMessageId) {
				await this.setQueuedReaction(pending.resolvingMessageId, false);
			}
			return;
		}
		const kind = record.interaction.kind;
		const note = formatTelegramResolutionNote(kind, resolution.providerId === this.id);
		await this.clearSteeringReactionsOnBotOutput();
		try {
			await this.transport.editMessageText(pending.activeMessageId, note);
		} catch {
			// ignore best-effort convergence update
		} finally {
			if (pending.resolvingMessageId) {
				await this.setQueuedReaction(pending.resolvingMessageId, false);
			}
		}
	}

	async notify(notification: { title: string; body: string }): Promise<void> {
		await this.startPromise;
		if (this.disposed) return;
		await this.clearWorkMessage();
		await this.sendBotMessageChunks(notification.body, {
			formatter: (chunk) => formatTelegramTitledMessage(notification.title, chunk),
		});
	}

	shutdown(): void {
		this.markDisposed();
	}
}
