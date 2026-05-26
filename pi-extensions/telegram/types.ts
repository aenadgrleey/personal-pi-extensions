import type {
	BridgeAskAnswer,
	BridgeAskQuestion,
	BridgeNotification,
	BridgePlanDecisionResult,
	BridgePlanPreviewParams,
	BridgeReviewPromptParams,
	BridgeReviewPromptResult,
} from "./bridge.js";

export interface TelegramConfig {
	enabled: boolean;
	configured: boolean;
	notificationsEnabled: boolean;
	token?: string;
	chatId?: number;
	apiBaseUrl: string;
	configPath: string;
	source: "project" | "global" | "env" | "mixed" | "none";
}

export interface AskInteraction {
	kind: "ask";
	questions: BridgeAskQuestion[];
}

export interface PlanInteraction {
	kind: "plan";
	params: BridgePlanPreviewParams;
}

export interface ReviewInteraction {
	kind: "review";
	params: BridgeReviewPromptParams;
}

export type SharedInteraction = AskInteraction | PlanInteraction | ReviewInteraction;

export type SharedInteractionResult =
	| { kind: "ask"; value: { answers: BridgeAskAnswer[]; cancelled: boolean } }
	| { kind: "plan"; value: BridgePlanDecisionResult }
	| { kind: "review"; value: BridgeReviewPromptResult | undefined };

export interface SharedNotification extends BridgeNotification {
	kind: "completion";
}

export interface PendingInteractionRecord {
	id: string;
	createdAt: string;
	interaction: SharedInteraction;
}

export interface InteractionResolution<T> {
	providerId: string;
	value: T;
}

export interface PersistedPendingInteraction {
	interactionId: string;
	kind: SharedInteraction["kind"];
	activeMessageId?: number;
	promptMessageIds: number[];
	helperMessageIds: number[];
	resolvingMessageId?: number;
	currentQuestionIndex?: number;
	answers?: BridgeAskAnswer[];
	awaitingText?: {
		reason: "ask-other" | "plan-refine" | "review-revise";
		questionId?: string;
		promptMessageId?: number;
		helperMessageId?: number;
		allowFreeText?: boolean;
		freeTextLabel?: string;
		freeTextLabelLower?: string;
		freeTextIndex?: number;
		choiceMap?: Record<string, string>;
		choiceValues?: string[];
		currentQuestionIndex?: number;
		decisionLabel?: string;
		decisionKind?: "plan" | "review";
		interactionKind?: SharedInteraction["kind"];
		resolvedPreview?: string;
		question?: string;
		questionLower?: string;
		questionIdLower?: string;
	};
	createdAt: string;
}

export interface AttachmentRecord {
	messageId: number;
	fileId: string;
	localPath: string;
	fileName?: string;
	kind: string;
	receivedAt: string;
}

export interface SteeringRecord {
	messageId: number;
	text: string;
	deliverAs: "immediate" | "steer";
	receivedAt: string;
}

export interface ArmedSkillRecord {
	skillName: string;
	command: string;
	armedAt: string;
}

export interface TelegramStateSnapshot {
	version: 2;
	lastUpdateId?: number;
	outboundMessageIds: number[];
	inboundMessageIds: number[];
	pending: PersistedPendingInteraction[];
	attachments: AttachmentRecord[];
	steering: SteeringRecord[];
	armedSkill?: ArmedSkillRecord;
}

export interface TelegramPublishedCommand {
	command: string;
	description: string;
}

export interface TelegramPublishedSkillCommand {
	skillName: string;
	command: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface TelegramUnpublishedSkillCommand {
	skillName: string;
	description: string;
	attemptedCommand: string;
	reason: string;
	filePath: string;
	baseDir: string;
}

export interface TelegramCommandPublicationState {
	fixedCommands: TelegramPublishedCommand[];
	publishedCommands: TelegramPublishedCommand[];
	publishedSkills: TelegramPublishedSkillCommand[];
	unpublishedSkills: TelegramUnpublishedSkillCommand[];
	refreshedAt: string;
	publishError?: string;
}

export interface TelegramApiResponse<T> {
	ok: boolean;
	result: T;
	description?: string;
	error_code?: number;
}

export interface TelegramChat {
	id: number;
	type: string;
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramVideo {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
	width: number;
	height: number;
	duration: number;
}

export interface TelegramAudio {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
	duration: number;
}

export interface TelegramVoice {
	file_id: string;
	file_unique_id: string;
	mime_type?: string;
	file_size?: number;
	duration: number;
}

export interface TelegramAnimation {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
	width: number;
	height: number;
	duration: number;
}

export interface TelegramVideoNote {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	length: number;
	duration: number;
}

export interface TelegramSticker {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	width: number;
	height: number;
	type: string;
	is_animated: boolean;
	is_video: boolean;
	emoji?: string;
}

export interface TelegramMessage {
	message_id: number;
	date: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	reply_to_message?: TelegramMessage;
	document?: TelegramDocument;
	photo?: TelegramPhotoSize[];
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	video_note?: TelegramVideoNote;
	sticker?: TelegramSticker;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	data?: string;
	message?: TelegramMessage;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface TelegramFileInfo {
	file_id: string;
	file_unique_id: string;
	file_path?: string;
	file_size?: number;
}
