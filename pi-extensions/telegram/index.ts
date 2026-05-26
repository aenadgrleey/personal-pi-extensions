import {
	ExtensionRunner,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getInteractionBridge, setInteractionBridge } from "../interaction-components/bridge.js";
import { showAskPrompt } from "../ask-components/index.js";
import { InteractionHub } from "../interaction-components/hub.js";
import { LocalInteractionProvider } from "../interaction-components/local-provider.js";
import { showPlanPreview } from "../plan-components/index.js";
import { showReviewPrompt } from "../review-components/index.js";
import {
	clearTelegramConfigScope,
	getGlobalTelegramConfigFile,
	getProjectTelegramConfigFile,
	getTelegramStatusText,
	loadTelegramConfig,
	readGlobalTelegramConfig,
	readTelegramConfigScope,
	setTelegramNotificationsEnabled,
	type TelegramConfigScope,
	updateTelegramConfigScope,
} from "./config.js";
import {
	buildTelegramCompletionNotification,
	extractTextContent,
	previewText,
} from "./formatting.js";
import {
	TELEGRAM_UI_TEXT,
	buildTelegramInteractionTestAskQuestion,
	buildTelegramInteractionTestPlan,
	buildTelegramInteractionTestReview,
	formatSessionResetCancelledMessage,
	formatSessionResetStartedMessage,
	formatSessionResetUnavailableMessage,
	formatTelegramAlreadyDetachedMessage,
	formatTelegramAttachFailedMessage,
	formatTelegramAttachSuccessMessage,
	formatTelegramAttachUnavailableMessage,
	formatTelegramConfigClearConfirmMessage,
	formatTelegramConfigClearTitle,
	formatTelegramConfigClearedMessage,
	formatTelegramConfigMenuTitle,
	formatTelegramConfigSavedMessage,
	formatTelegramContextSummary,
	formatTelegramDetachConfirmMessage,
	formatTelegramDetachConfirmTitle,
	formatTelegramDetachSuccessMessage,
	formatTelegramForceAttachPrompt,
	formatTelegramForceAttachTitle,
	getTelegramApiActionOptions,
	getTelegramApiInputPlaceholder,
	getTelegramChatActionOptions,
	getTelegramChatInputPlaceholder,
	getTelegramTokenActionOptions,
	getTelegramTokenInputPlaceholder,
	formatTelegramInteractionTestCancelledMessage,
	formatTelegramInteractionTestDiscardedMessage,
	formatTelegramInteractionTestProgressMessage,
	formatTelegramInteractionTestStartedMessage,
	formatTelegramInteractionTestSummary,
	formatTelegramInteractionTestUnavailableMessage,
	formatTelegramNotificationsToggled,
	formatTelegramProviderErrorNotification,
	formatTelegramRemoteStatus,
	formatTelegramSetupScopePrompt,
	formatTelegramStatusCommandMessage,
	formatTelegramToggleScopePrompt,
	getTelegramResetStartupBehavior,
} from "./texts-user.js";
import {
	claimTelegramOwnership,
	forceClaimTelegramOwnership,
	forceReleaseTelegramOwnership,
	getTelegramOwnerFile,
	isTelegramOwner,
	readTelegramOwnerState,
	refreshTelegramOwnership,
	releaseTelegramOwnership,
} from "./ownership.js";
import { formatTelegramAttachWarning } from "./session-control.js";
import {
	loadTelegramState,
	loadTelegramStateFromSessionFile,
	mergeTelegramStates,
} from "./state.js";
import { TelegramInteractionProvider } from "./telegram-provider.js";

export function getTelegramSessionStartActivationMode(params: {
	owner: ReturnType<typeof readTelegramOwnerState>;
	previousSessionFile?: string;
	nextSessionId?: string;
	nextSessionFile?: string;
}): "current-owner" | "transfer" | undefined {
	const { owner, previousSessionFile, nextSessionId, nextSessionFile } = params;
	if (!owner || !nextSessionId) return undefined;
	if (owner.sessionId === nextSessionId) return "current-owner";
	if (!previousSessionFile || !nextSessionFile) return undefined;
	return owner.sessionFile === previousSessionFile ? "transfer" : undefined;
}

export function getTelegramPendingCleanupState(params: {
	currentState: ReturnType<typeof loadTelegramState>;
	persistedPreviousState?: ReturnType<typeof loadTelegramState>;
	livePreviousState?: ReturnType<TelegramInteractionProvider["getStateSnapshot"]>;
}): ReturnType<typeof loadTelegramState> {
	return params.livePreviousState ?? params.persistedPreviousState ?? params.currentState;
}

function maskToken(token: string | undefined): string {
	if (!token) return "(unset)";
	if (token.length <= 10) return "••••";
	return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

const TELEGRAM_SESSION_CONTROL_SHARED_STATE_KEY =
	"__personalAiToolsTelegramSessionControlSharedState";

type TelegramSessionControlSharedState = {
	pendingStartupMessages: string[];
	includeAttachWarningOnNextStartup: boolean;
	historyResetModeOnNextStartup?: "tracked" | "whole-chat";
	sessionControlContext?: ExtensionCommandContext;
	latestRunner?: ExtensionRunner;
	runnerHookInstalled: boolean;
};

function getTelegramSessionControlSharedState(): TelegramSessionControlSharedState {
	const globalState = globalThis as typeof globalThis & {
		[TELEGRAM_SESSION_CONTROL_SHARED_STATE_KEY]?: TelegramSessionControlSharedState;
	};
	globalState[TELEGRAM_SESSION_CONTROL_SHARED_STATE_KEY] ??= {
		pendingStartupMessages: [],
		includeAttachWarningOnNextStartup: true,
		historyResetModeOnNextStartup: undefined,
		sessionControlContext: undefined,
		latestRunner: undefined,
		runnerHookInstalled: false,
	};
	return globalState[TELEGRAM_SESSION_CONTROL_SHARED_STATE_KEY];
}

function installTelegramRunnerHook(): void {
	const sharedState = getTelegramSessionControlSharedState();
	if (sharedState.runnerHookInstalled) return;
	sharedState.runnerHookInstalled = true;
	const originalCreateContext = ExtensionRunner.prototype.createContext;
	ExtensionRunner.prototype.createContext = function patchedCreateContext(
		this: ExtensionRunner,
	): ExtensionContext {
		getTelegramSessionControlSharedState().latestRunner = this;
		return originalCreateContext.call(this);
	};
}

export { getTelegramResetStartupBehavior } from "./texts-user.js";

async function chooseTelegramScope(
	ctx: ExtensionCommandContext,
	title: string,
): Promise<TelegramConfigScope | undefined> {
	const choice = await ctx.ui.select(title, [...TELEGRAM_UI_TEXT.scopeOptions]);
	if (!choice || choice === TELEGRAM_UI_TEXT.scopeOptions[2]) return undefined;
	return choice === TELEGRAM_UI_TEXT.scopeOptions[0] ? "project" : "global";
}

function scopeLabel(scope: TelegramConfigScope): string {
	return scope === "project" ? "project" : "global";
}

function buildInitiator(
	text: string | undefined,
	provider?: TelegramInteractionProvider,
): { text: string; source: "Pi" | "Telegram" } | undefined {
	const normalized = text?.trim();
	if (!normalized) return undefined;
	return {
		text: normalized,
		source: provider?.consumeTelegramInitiator(normalized) ? "Telegram" : "Pi",
	};
}

function getLatestUserInitiator(
	ctx: ExtensionContext,
	provider?: TelegramInteractionProvider,
): { text: string; source: "Pi" | "Telegram" } | undefined {
	const latestUserEntry = [...ctx.sessionManager.getEntries()]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				(entry as { message?: { role?: string } }).message?.role === "user",
		) as
		| {
				message?: {
					content?: string | Array<{ type: string; text?: string }>;
				};
		  }
		| undefined;
	const content = latestUserEntry?.message?.content;
	if (!content) return undefined;
	return buildInitiator(extractTextContent(content), provider);
}

async function promptTelegramSetup(
	ctx: ExtensionCommandContext,
	scope: TelegramConfigScope,
): Promise<string | undefined> {
	const current = readTelegramConfigScope(scope, ctx.cwd);
	const tokenAction = await ctx.ui.select(
		TELEGRAM_UI_TEXT.tokenActions.title,
		getTelegramTokenActionOptions(Boolean(current.token)),
	);
	if (!tokenAction || tokenAction === TELEGRAM_UI_TEXT.tokenActions.cancel) return undefined;

	let tokenPatch: string | undefined | null = null;
	if (tokenAction === TELEGRAM_UI_TEXT.tokenActions.enter) {
		const value = await ctx.ui.input(
			TELEGRAM_UI_TEXT.tokenActions.title,
			getTelegramTokenInputPlaceholder(current.token),
		);
		if (!value?.trim()) return undefined;
		tokenPatch = value.trim();
	} else if (tokenAction === TELEGRAM_UI_TEXT.tokenActions.clear) {
		tokenPatch = undefined;
	}

	const chatAction = await ctx.ui.select(
		TELEGRAM_UI_TEXT.chatActions.title,
		getTelegramChatActionOptions(current.chatId),
	);
	if (!chatAction || chatAction === TELEGRAM_UI_TEXT.chatActions.cancel) return undefined;

	let chatIdPatch: number | string | undefined | null = null;
	if (chatAction === TELEGRAM_UI_TEXT.chatActions.enter) {
		const value = await ctx.ui.input(
			TELEGRAM_UI_TEXT.chatActions.title,
			getTelegramChatInputPlaceholder(current.chatId),
		);
		if (!value?.trim()) return undefined;
		chatIdPatch = value.trim();
	} else if (chatAction === TELEGRAM_UI_TEXT.chatActions.clear) {
		chatIdPatch = undefined;
	}

	const apiAction = await ctx.ui.select(
		TELEGRAM_UI_TEXT.apiActions.title,
		getTelegramApiActionOptions(current.apiBaseUrl),
	);
	if (!apiAction || apiAction === TELEGRAM_UI_TEXT.apiActions.cancel) return undefined;

	let apiBaseUrlPatch: string | undefined | null = null;
	if (apiAction === TELEGRAM_UI_TEXT.apiActions.enter) {
		const value = await ctx.ui.input(
			TELEGRAM_UI_TEXT.apiActions.title,
			getTelegramApiInputPlaceholder(current.apiBaseUrl),
		);
		if (!value?.trim()) return undefined;
		apiBaseUrlPatch = value.trim();
	} else if (apiAction === TELEGRAM_UI_TEXT.apiActions.clear) {
		apiBaseUrlPatch = undefined;
	}

	const notificationsChoice = await ctx.ui.select(
		"Telegram notifications",
		[...TELEGRAM_UI_TEXT.notificationOptions],
	);
	if (!notificationsChoice) return undefined;

	return updateTelegramConfigScope(scope, ctx.cwd, {
		token: tokenPatch === null ? current.token : tokenPatch,
		chatId: chatIdPatch === null ? current.chatId : chatIdPatch,
		apiBaseUrl: apiBaseUrlPatch === null ? current.apiBaseUrl : apiBaseUrlPatch,
		notificationsEnabled: notificationsChoice === TELEGRAM_UI_TEXT.notificationOptions[0],
	});
}

export default function (pi: ExtensionAPI) {
	installTelegramRunnerHook();
	let agentBusy = false;
	let currentSignal: AbortSignal | undefined;
	let telegramProvider: TelegramInteractionProvider | undefined;
	let telegramActive = false;
	let hub: InteractionHub | undefined;
	let apiErrorNotified = false;
	let ownershipTimer: ReturnType<typeof setInterval> | undefined;
	let currentSessionId: string | undefined;
	let currentSessionFile: string | undefined;
	let currentCwd: string | undefined;
	let pendingCleanupState: ReturnType<typeof loadTelegramState> | undefined;
	let pendingAgentInitiator: { text: string; source: "Pi" | "Telegram" } | undefined;
	const localProvider = new LocalInteractionProvider();

	function rememberSessionControlContext(ctx: ExtensionCommandContext): void {
		getTelegramSessionControlSharedState().sessionControlContext = ctx;
	}

	function resolveSessionControlContext(): ExtensionCommandContext | undefined {
		const sharedState = getTelegramSessionControlSharedState();
		const latestRunner = sharedState.latestRunner;
		if (latestRunner) {
			try {
				const ctx = latestRunner.createCommandContext();
				void ctx.cwd;
				sharedState.sessionControlContext = ctx;
				return ctx;
			} catch {
				sharedState.latestRunner = undefined;
			}
		}
		const fallbackContext = sharedState.sessionControlContext;
		if (!fallbackContext) return undefined;
		try {
			void fallbackContext.cwd;
			return fallbackContext;
		} catch {
			sharedState.sessionControlContext = undefined;
			return undefined;
		}
	}

	function queueTelegramStartupState(params: {
		startupMessage?: string;
		includeAttachWarning: boolean;
		historyResetMode?: "tracked" | "whole-chat";
	}): void {
		const sharedState = getTelegramSessionControlSharedState();
		sharedState.pendingStartupMessages = [];
		sharedState.includeAttachWarningOnNextStartup = params.includeAttachWarning;
		sharedState.historyResetModeOnNextStartup = params.historyResetMode;
		if (!params.startupMessage?.trim()) return;
		sharedState.pendingStartupMessages.push(params.startupMessage.trim());
	}

	function clearPendingTelegramStartupState(): void {
		const sharedState = getTelegramSessionControlSharedState();
		sharedState.pendingStartupMessages = [];
		sharedState.includeAttachWarningOnNextStartup = true;
		sharedState.historyResetModeOnNextStartup = undefined;
	}

	function takeTelegramStartupState(): {
		startupMessages: string[];
		includeAttachWarning: boolean;
		historyResetMode?: "tracked" | "whole-chat";
	} {
		const sharedState = getTelegramSessionControlSharedState();
		const startupState = {
			startupMessages: [...sharedState.pendingStartupMessages],
			includeAttachWarning: sharedState.includeAttachWarningOnNextStartup,
			historyResetMode: sharedState.historyResetModeOnNextStartup,
		};
		clearPendingTelegramStartupState();
		return startupState;
	}

	function buildTelegramRemoteStatus(): string {
		const owner = readTelegramOwnerState();
		const commandState = telegramProvider?.getSessionControlState();
		return formatTelegramRemoteStatus({
			attached: telegramActive,
			ownerSessionId: owner?.sessionId,
			thisSessionOwnsTelegram: Boolean(currentSessionId && isTelegramOwner(currentSessionId)),
			sessionResetAvailable: Boolean(resolveSessionControlContext()),
			publishedSlashCommands: commandState?.publishedCommands.length,
			publishedSkills: commandState?.publishedSkills.length,
			unpublishedSkills: commandState?.unpublishedSkills.length,
			commandRefresh: commandState?.refreshedAt,
			commandPublishError: commandState?.publishError,
		});
	}

	function buildTelegramContextMessage(ctx: ExtensionContext): string {
		const usage = ctx.getContextUsage();
		const branchEntries = ctx.sessionManager.getBranch();
		const allEntries = ctx.sessionManager.getEntries();
		const branchMessages = branchEntries.filter((entry) => entry.type === "message");
		const customEntries = branchEntries.filter((entry) => entry.type === "custom").length;
		const customMessages = branchEntries.filter((entry) => entry.type === "custom_message").length;
		const compactions = branchEntries.filter((entry) => entry.type === "compaction").length;
		const branchSummaries = branchEntries.filter((entry) => entry.type === "branch_summary").length;
		const lastMessage = [...branchMessages].reverse().find((entry) => {
			const message = entry.message;
			return (
				(message.role === "user" || message.role === "assistant") && "content" in message
			);
		});
		let lastPreview: string | undefined;
		if (lastMessage) {
			const { message } = lastMessage;
			if ("content" in message) {
				lastPreview = previewText(extractTextContent(message.content), 120) || "(no text preview)";
			}
		}
		return formatTelegramContextSummary({
			sessionId: ctx.sessionManager.getSessionId(),
			branchEntries: branchEntries.length,
			branchMessages: branchMessages.length,
			customStateEntries: customEntries,
			customInContextMessages: customMessages,
			compactionEntries: compactions,
			branchSummaries,
			totalStoredSessionEntries: allEntries.length,
			contextWindow: usage?.contextWindow,
			usedTokens: usage?.tokens,
			usedPercent: usage?.percent,
			lastPreview,
		});
	}

	function stopOwnershipWatcher(): void {
		if (!ownershipTimer) return;
		clearInterval(ownershipTimer);
		ownershipTimer = undefined;
	}

	function isCurrentTelegramSession(ctx: ExtensionContext): boolean {
		return (
			ctx.sessionManager.getSessionId() === currentSessionId &&
			ctx.sessionManager.getSessionFile() === currentSessionFile
		);
	}

	function rebuildHub(): void {
		const providers =
			telegramProvider && telegramActive ? [localProvider, telegramProvider] : [localProvider];
		hub = new InteractionHub(providers);
		setInteractionBridge(hub);
	}

	async function handleRemoteSessionReset(intent: "new_session" | "clear"): Promise<{
		started: boolean;
		message: string;
	}> {
		const sessionControlContext = resolveSessionControlContext();
		if (!sessionControlContext) {
			return {
				started: false,
				message: formatSessionResetUnavailableMessage(),
			};
		}

		try {
			await sessionControlContext.waitForIdle();
			queueTelegramStartupState(getTelegramResetStartupBehavior(intent));
			const result = await sessionControlContext.newSession({
				withSession: async (replacementCtx) => {
					rememberSessionControlContext(replacementCtx);
				},
			});
			if (result.cancelled) {
				clearPendingTelegramStartupState();
				return { started: false, message: formatSessionResetCancelledMessage() };
			}
			return { started: true, message: formatSessionResetStartedMessage() };
		} catch (error) {
			clearPendingTelegramStartupState();
			return {
				started: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async function handleRemoteDetach(ctx: ExtensionContext): Promise<void> {
		forceReleaseTelegramOwnership();
		telegramProvider?.shutdown();
		telegramProvider = undefined;
		telegramActive = false;
		stopOwnershipWatcher();
		rebuildHub();
		ctx.ui.setStatus("telegram", getTelegramStatusText(loadTelegramConfig(ctx.cwd), "detached"));
	}

	async function activateTelegram(
		ctx: ExtensionContext,
		reason: "startup" | "reload" | "new" | "resume" | "fork",
		cleanupState?:
			| ReturnType<typeof loadTelegramStateFromSessionFile>
			| ReturnType<typeof loadTelegramState>,
		historyResetMode?: "tracked" | "whole-chat",
	): Promise<boolean> {
		const config = loadTelegramConfig(ctx.cwd);
		ctx.ui.setStatus("telegram", getTelegramStatusText(config, "detached"));
		if (!config.enabled) {
			telegramProvider?.shutdown();
			telegramProvider = undefined;
			telegramActive = false;
			rebuildHub();
			return false;
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const claim = claimTelegramOwnership({
			sessionId,
			sessionFile,
			cwd: ctx.cwd,
			busy: agentBusy,
		});
		if (!claim.acquired) {
			telegramProvider?.shutdown();
			telegramProvider = undefined;
			telegramActive = false;
			ctx.ui.setStatus("telegram", getTelegramStatusText(config, "busy"));
			rebuildHub();
			return false;
		}

		const currentState = loadTelegramState(ctx.sessionManager);
		const effectiveCleanupState = mergeTelegramStates(
			currentState,
			cleanupState ?? pendingCleanupState ?? currentState,
		);
		telegramProvider?.shutdown();
		const startupState = takeTelegramStartupState();
		telegramProvider = new TelegramInteractionProvider({
			pi,
			config,
			getIsIdle: () => !agentBusy,
			getSessionId: () => ctx.sessionManager.getSessionId(),
			getSignal: () => currentSignal,
			getCommandEntries: () => pi.getCommands(),
			getStatusMessage: buildTelegramRemoteStatus,
			getContextMessage: () => buildTelegramContextMessage(ctx),
			handleSessionReset: handleRemoteSessionReset,
			handleDetach: async () => handleRemoteDetach(ctx),
			reason,
			currentState,
			cleanupState: effectiveCleanupState,
			startupMessages: startupState.startupMessages,
			includeAttachWarning: startupState.includeAttachWarning,
			historyResetMode: historyResetMode ?? startupState.historyResetMode,
		});
		pendingCleanupState = undefined;
		telegramActive = true;
		ctx.ui.setStatus("telegram", getTelegramStatusText(config, "attached"));
		refreshTelegramOwnership(sessionId, {
			busy: agentBusy,
			sessionFile,
			cwd: ctx.cwd,
		});
		startOwnershipWatcher(ctx);
		rebuildHub();
		return true;
	}

	function startOwnershipWatcher(ctx: ExtensionContext): void {
		stopOwnershipWatcher();
		ownershipTimer = setInterval(() => {
			if (!currentSessionId || !telegramProvider || !telegramActive) return;
			const claim = claimTelegramOwnership({
				sessionId: currentSessionId,
				sessionFile: currentSessionFile,
				cwd: currentCwd ?? ctx.cwd,
				busy: agentBusy,
			});
			if (claim.acquired || isTelegramOwner(currentSessionId)) return;
			telegramProvider.shutdown();
			telegramProvider = undefined;
			telegramActive = false;
			stopOwnershipWatcher();
			const config = loadTelegramConfig(ctx.cwd);
			ctx.ui.setStatus("telegram", getTelegramStatusText(config, "detached"));
			rebuildHub();
		}, 3_000);
	}

	pi.on("session_start", async (event, ctx) => {
		agentBusy = false;
		currentSignal = undefined;
		apiErrorNotified = false;
		getTelegramSessionControlSharedState().sessionControlContext = undefined;
		currentSessionId = ctx.sessionManager.getSessionId();
		currentSessionFile = ctx.sessionManager.getSessionFile();
		currentCwd = ctx.cwd;
		const owner = readTelegramOwnerState();
		const activationMode = getTelegramSessionStartActivationMode({
			owner,
			previousSessionFile: event.previousSessionFile,
			nextSessionId: currentSessionId,
			nextSessionFile: currentSessionFile,
		});
		const previousLiveState = event.previousSessionFile
			? telegramProvider?.getStateSnapshot()
			: undefined;
		stopOwnershipWatcher();
		telegramProvider?.shutdown();
		telegramProvider = undefined;
		telegramActive = false;
		const currentState = loadTelegramState(ctx.sessionManager);
		pendingCleanupState = getTelegramPendingCleanupState({
			currentState,
			persistedPreviousState: event.previousSessionFile
				? loadTelegramStateFromSessionFile(event.previousSessionFile)
				: undefined,
			livePreviousState: previousLiveState,
		});
		const config = loadTelegramConfig(ctx.cwd);
		ctx.ui.setStatus("telegram", getTelegramStatusText(config, "detached"));
		rebuildHub();
		if (!activationMode || !currentSessionId || !currentSessionFile) return;
		if (activationMode === "transfer") {
			forceClaimTelegramOwnership({
				sessionId: currentSessionId,
				sessionFile: currentSessionFile,
				cwd: ctx.cwd,
				busy: false,
			});
		}
		await activateTelegram(ctx, event.reason, pendingCleanupState);
	});

	pi.on("before_agent_start", async (event) => {
		if (!telegramActive || !telegramProvider) {
			pendingAgentInitiator = undefined;
			return;
		}
		pendingAgentInitiator = buildInitiator(event.prompt, telegramProvider);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentBusy = true;
		currentSignal = ctx.signal;
		apiErrorNotified = false;
		currentSessionId = ctx.sessionManager.getSessionId();
		currentSessionFile = ctx.sessionManager.getSessionFile();
		currentCwd = ctx.cwd;
		if (telegramActive && currentSessionId && isTelegramOwner(currentSessionId)) {
			refreshTelegramOwnership(currentSessionId, {
				busy: true,
				sessionFile: currentSessionFile,
				cwd: ctx.cwd,
			});
		}
		if (telegramActive && telegramProvider) {
			const initiator = pendingAgentInitiator ?? getLatestUserInitiator(ctx, telegramProvider);
			pendingAgentInitiator = undefined;
			await telegramProvider.onAgentStart(initiator);
		}
	});

	pi.on("turn_start", async (event) => {
		if (!telegramActive || !telegramProvider) return;
		await telegramProvider.onTurnStart(event.turnIndex);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!telegramActive || !telegramProvider) return;
		await telegramProvider.onToolExecutionStart(event.toolName, event.args);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "user" || !telegramActive || !telegramProvider) return;
		const content = (
			event.message as {
				content?: string | Array<{ type: string; text?: string }>;
			}
		).content;
		if (!content) return;
		const text = extractTextContent(content);
		if (!text) return;
		void telegramProvider.handleDeliveredInboundMessage(text);
	});

	pi.on("after_provider_response", async (event) => {
		if (event.status < 400 || apiErrorNotified) return;
		apiErrorNotified = true;
		const bridge = getInteractionBridge();
		if (!bridge) return;
		const retryAfter = event.headers["retry-after"];
		await bridge.notifyCompletion({
			title: "",
			body: formatTelegramProviderErrorNotification(event.status, retryAfter),
		});
	});

	pi.on("agent_end", async (event) => {
		agentBusy = false;
		currentSignal = undefined;
		if (currentSessionId && isTelegramOwner(currentSessionId)) {
			refreshTelegramOwnership(currentSessionId, {
				busy: false,
				sessionFile: currentSessionFile,
				cwd: currentCwd,
			});
		}
		if (telegramActive && telegramProvider) {
			await telegramProvider.onAgentEnd();
		}
		const bridge = getInteractionBridge();
		if (!bridge) return;
		const notification = buildTelegramCompletionNotification(event.messages, apiErrorNotified);
		await bridge.notifyCompletion({
			title: notification.title,
			body: notification.body,
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!isCurrentTelegramSession(ctx)) return;
		agentBusy = false;
		currentSignal = undefined;
		apiErrorNotified = false;
		const sharedState = getTelegramSessionControlSharedState();
		sharedState.sessionControlContext = undefined;
		sharedState.latestRunner = undefined;
		stopOwnershipWatcher();
		ctx.ui.setStatus("telegram", undefined);
		setInteractionBridge(undefined);
		const shouldPreserveOwnershipForTransfer =
			telegramActive &&
			event.targetSessionFile !== undefined &&
			(event.reason === "new" || event.reason === "resume" || event.reason === "fork") &&
			Boolean(currentSessionId && isTelegramOwner(currentSessionId));
		if (telegramProvider) {
			if (shouldPreserveOwnershipForTransfer) {
				telegramProvider.shutdown();
			} else {
				await telegramProvider.clearTrackedMessages();
				telegramProvider.shutdown();
			}
		}
		if (
			!shouldPreserveOwnershipForTransfer &&
			currentSessionId &&
			isTelegramOwner(currentSessionId)
		) {
			releaseTelegramOwnership(currentSessionId);
		}
		telegramProvider = undefined;
		telegramActive = false;
		hub = undefined;
		currentSessionId = undefined;
		currentSessionFile = undefined;
		currentCwd = undefined;
	});

	pi.registerCommand("telegram-status", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.status,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			const config = loadTelegramConfig(ctx.cwd);
			const project = readTelegramConfigScope("project", ctx.cwd);
			const global = readGlobalTelegramConfig();
			const owner = readTelegramOwnerState();
			ctx.ui.notify(
				formatTelegramStatusCommandMessage({
					active: config.enabled,
					configured: config.configured,
					notificationsEnabled: config.notificationsEnabled,
					chatId: config.chatId,
					token: maskToken(config.token),
					source: config.source,
					configPath: config.configPath,
					ownerFile: getTelegramOwnerFile(),
					ownerSessionId: owner?.sessionId,
					ownerBusy: owner?.busy,
					thisSessionOwnsTelegram: Boolean(
						currentSessionId && isTelegramOwner(currentSessionId),
					),
					projectConfigPath: getProjectTelegramConfigFile(ctx.cwd),
					projectTokenSet: Boolean(project.token),
					projectChatId: project.chatId,
					projectNotifications: project.notificationsEnabled,
					globalConfigPath: getGlobalTelegramConfigFile(),
					globalTokenSet: Boolean(global.token),
					globalChatId: global.chatId,
					globalNotifications: global.notificationsEnabled,
					apiBaseUrl: config.apiBaseUrl,
					remoteStatus: buildTelegramRemoteStatus(),
				}),
				"info",
			);
		},
	});

	pi.registerCommand("telegram-toggle", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.toggle,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			const scope = await chooseTelegramScope(ctx, formatTelegramToggleScopePrompt());
			if (!scope) return;
			const current = readTelegramConfigScope(scope, ctx.cwd);
			const nextEnabled = current.notificationsEnabled === false;
			const configPath = setTelegramNotificationsEnabled(scope, ctx.cwd, nextEnabled);
			ctx.ui.notify(
				formatTelegramNotificationsToggled(scopeLabel(scope), nextEnabled, configPath),
				"info",
			);
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("telegram-test", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.test,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			currentSessionId = ctx.sessionManager.getSessionId();
			currentSessionFile = ctx.sessionManager.getSessionFile();
			currentCwd = ctx.cwd;

			if (
				!telegramProvider ||
				!telegramActive ||
				!currentSessionId ||
				!isTelegramOwner(currentSessionId)
			) {
				await activateTelegram(ctx, "resume");
			}

			if (
				!telegramProvider ||
				!telegramActive ||
				!currentSessionId ||
				!isTelegramOwner(currentSessionId)
			) {
				ctx.ui.notify(formatTelegramInteractionTestUnavailableMessage(), "error");
				return;
			}

			ctx.ui.notify(formatTelegramInteractionTestStartedMessage(), "info");

			const askResult = await showAskPrompt(ctx, [buildTelegramInteractionTestAskQuestion()]);
			if (askResult.cancelled) {
				ctx.ui.notify(formatTelegramInteractionTestCancelledMessage("ask"), "info");
				return;
			}

			ctx.ui.notify(formatTelegramInteractionTestProgressMessage("ask"), "info");

			const planResult = await showPlanPreview(ctx, buildTelegramInteractionTestPlan());
			if (planResult.action === "discarded") {
				ctx.ui.notify(formatTelegramInteractionTestDiscardedMessage(), "info");
				return;
			}

			ctx.ui.notify(formatTelegramInteractionTestProgressMessage("plan"), "info");

			const reviewResult = await showReviewPrompt(ctx, buildTelegramInteractionTestReview());
			if (!reviewResult) {
				ctx.ui.notify(formatTelegramInteractionTestCancelledMessage("review"), "info");
				return;
			}

			const answers = askResult.answers.map((answer) => `${answer.id}=${answer.answer}`).join(", ");
			ctx.ui.notify(
				formatTelegramInteractionTestSummary({
					answers,
					planAction: planResult.action,
					reviewDecision: reviewResult.decision,
					reviewFeedback: reviewResult.feedback,
				}),
				"info",
			);
		},
	});

	pi.registerCommand("telegram-attach", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.attach,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			currentSessionId = ctx.sessionManager.getSessionId();
			currentSessionFile = ctx.sessionManager.getSessionFile();
			currentCwd = ctx.cwd;
			const owner = readTelegramOwnerState();

			if (!currentSessionId || !currentSessionFile) {
				ctx.ui.notify(formatTelegramAttachUnavailableMessage(), "error");
				return;
			}

			const attachCleanupState =
				owner && owner.sessionId !== currentSessionId
					? loadTelegramStateFromSessionFile(owner.sessionFile)
					: undefined;

			if (owner && owner.sessionId !== currentSessionId) {
				const ok = await ctx.ui.confirm(
					formatTelegramForceAttachTitle(),
					formatTelegramForceAttachPrompt(owner.sessionId, owner.busy),
				);
				if (!ok) return;
				forceClaimTelegramOwnership({
					sessionId: currentSessionId,
					sessionFile: currentSessionFile,
					cwd: ctx.cwd,
					busy: agentBusy,
				});
			}

			const activated = await activateTelegram(ctx, "resume", attachCleanupState, "tracked");
			if (!activated || !isTelegramOwner(currentSessionId)) {
				ctx.ui.notify(formatTelegramAttachFailedMessage(), "error");
				return;
			}

			ctx.ui.notify(
				formatTelegramAttachSuccessMessage(
					owner && owner.sessionId !== currentSessionId ? owner.sessionId : undefined,
				),
				"info",
			);
			const attachWarning = telegramProvider
				? formatTelegramAttachWarning(telegramProvider.getSessionControlState())
				: undefined;
			if (attachWarning) {
				ctx.ui.notify(attachWarning, "warning");
			}
		},
	});

	pi.registerCommand("telegram-detach", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.detach,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			currentSessionId = ctx.sessionManager.getSessionId();
			const owner = readTelegramOwnerState();
			if (!owner) {
				ctx.ui.notify(formatTelegramAlreadyDetachedMessage(), "info");
				return;
			}

			const isCurrentOwner = Boolean(currentSessionId && owner.sessionId === currentSessionId);
			const ok = await ctx.ui.confirm(
				formatTelegramDetachConfirmTitle(),
				formatTelegramDetachConfirmMessage(isCurrentOwner, owner.sessionId),
			);
			if (!ok) return;

			forceReleaseTelegramOwnership();
			if (isCurrentOwner) {
				telegramProvider?.shutdown();
				telegramProvider = undefined;
				telegramActive = false;
				stopOwnershipWatcher();
				rebuildHub();
				const config = loadTelegramConfig(ctx.cwd);
				ctx.ui.setStatus("telegram", getTelegramStatusText(config, "detached"));
			}

			ctx.ui.notify(
				formatTelegramDetachSuccessMessage(isCurrentOwner, owner.sessionId),
				"info",
			);
		},
	});

	pi.registerCommand("telegram-config", {
		description: TELEGRAM_UI_TEXT.localCommandDescriptions.config,
		handler: async (_args, ctx) => {
			rememberSessionControlContext(ctx);
			const action = await ctx.ui.select(
				formatTelegramConfigMenuTitle(),
				[...TELEGRAM_UI_TEXT.configMenuOptions],
			);
			if (!action || action === TELEGRAM_UI_TEXT.configMenuOptions[4]) return;

			if (action === TELEGRAM_UI_TEXT.configMenuOptions[1]) {
				const scope = await chooseTelegramScope(ctx, formatTelegramToggleScopePrompt());
				if (!scope) return;
				const current = readTelegramConfigScope(scope, ctx.cwd);
				const nextEnabled = current.notificationsEnabled === false;
				const configPath = setTelegramNotificationsEnabled(scope, ctx.cwd, nextEnabled);
				ctx.ui.notify(
					formatTelegramNotificationsToggled(scopeLabel(scope), nextEnabled, configPath),
					"info",
				);
				await ctx.reload();
				return;
			}

			if (
				action === TELEGRAM_UI_TEXT.configMenuOptions[2] ||
				action === TELEGRAM_UI_TEXT.configMenuOptions[3]
			) {
				const scope: TelegramConfigScope =
					action === TELEGRAM_UI_TEXT.configMenuOptions[2] ? "project" : "global";
				const configPath =
					scope === "project"
						? getProjectTelegramConfigFile(ctx.cwd)
						: getGlobalTelegramConfigFile();
				const ok = await ctx.ui.confirm(
					formatTelegramConfigClearTitle(),
					formatTelegramConfigClearConfirmMessage(configPath),
				);
				if (!ok) return;
				clearTelegramConfigScope(scope, ctx.cwd);
				ctx.ui.notify(
					formatTelegramConfigClearedMessage(scopeLabel(scope), configPath),
					"info",
				);
				await ctx.reload();
				return;
			}

			const scope = await chooseTelegramScope(ctx, formatTelegramSetupScopePrompt());
			if (!scope) return;
			const configPath = await promptTelegramSetup(ctx, scope);
			if (!configPath) return;
			ctx.ui.notify(
				formatTelegramConfigSavedMessage(scopeLabel(scope), configPath),
				"info",
			);
			await ctx.reload();
			return;
		},
	});
}
