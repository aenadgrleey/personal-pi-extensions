import type {
	TelegramApiResponse,
	TelegramConfig,
	TelegramFileInfo,
	TelegramMessage,
	TelegramPublishedCommand,
	TelegramUpdate,
} from "./types.js";

export interface TelegramSendMessageOptions {
	replyMarkup?: Record<string, unknown>;
	replyToMessageId?: number;
	parseMode?: "HTML" | "MarkdownV2";
}

export class TelegramTransport {
	private readonly config: TelegramConfig;
	private running = false;
	private loopAbort: AbortController | undefined;
	private offset: number | undefined;

	constructor(config: TelegramConfig) {
		this.config = config;
	}

	private get apiRoot(): string {
		return `${this.config.apiBaseUrl}/bot${this.config.token}`;
	}

	private get fileRoot(): string {
		return `${this.config.apiBaseUrl}/file/bot${this.config.token}`;
	}

	private async callApi<T>(
		method: string,
		payload?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await fetch(`${this.apiRoot}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload ?? {}),
			signal,
		});
		const json = (await response.json()) as TelegramApiResponse<T>;
		if (!response.ok || !json.ok) {
			throw new Error(json.description || `Telegram API ${method} failed (${response.status})`);
		}
		return json.result;
	}

	async sendMessage(text: string, options: TelegramSendMessageOptions = {}): Promise<TelegramMessage> {
		return this.callApi<TelegramMessage>("sendMessage", {
			chat_id: this.config.chatId,
			text,
			parse_mode: options.parseMode ?? "HTML",
			reply_markup: options.replyMarkup,
			reply_to_message_id: options.replyToMessageId,
		});
	}

	async sendAnimation(
		animation: string,
		caption: string,
		options: TelegramSendMessageOptions = {},
	): Promise<TelegramMessage> {
		return this.callApi<TelegramMessage>("sendAnimation", {
			chat_id: this.config.chatId,
			animation,
			caption,
			parse_mode: options.parseMode ?? "HTML",
			reply_markup: options.replyMarkup,
			reply_to_message_id: options.replyToMessageId,
		});
	}

	async editMessageText(messageId: number, text: string, options: TelegramSendMessageOptions = {}): Promise<void> {
		await this.callApi("editMessageText", {
			chat_id: this.config.chatId,
			message_id: messageId,
			text,
			parse_mode: options.parseMode ?? "HTML",
			reply_markup: options.replyMarkup,
		});
	}

	async editMessageCaption(
		messageId: number,
		caption: string,
		options: TelegramSendMessageOptions = {},
	): Promise<void> {
		await this.callApi("editMessageCaption", {
			chat_id: this.config.chatId,
			message_id: messageId,
			caption,
			parse_mode: options.parseMode ?? "HTML",
			reply_markup: options.replyMarkup,
		});
	}

	async deleteMessage(messageId: number): Promise<void> {
		await this.callApi("deleteMessage", {
			chat_id: this.config.chatId,
			message_id: messageId,
		});
	}

	async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
		await this.callApi("answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			text,
		});
	}

	async setMessageReaction(messageId: number, emoji?: string): Promise<void> {
		await this.callApi("setMessageReaction", {
			chat_id: this.config.chatId,
			message_id: messageId,
			reaction: emoji ? [{ type: "emoji", emoji }] : [],
		});
	}

	async getFile(fileId: string): Promise<TelegramFileInfo> {
		return this.callApi<TelegramFileInfo>("getFile", { file_id: fileId });
	}

	async setMyCommands(commands: TelegramPublishedCommand[]): Promise<void> {
		await this.callApi("setMyCommands", {
			commands: commands.map((command) => ({
				command: command.command,
				description: command.description,
			})),
		});
	}

	async downloadFile(filePath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
		const response = await fetch(`${this.fileRoot}/${filePath}`, { signal });
		if (!response.ok) {
			throw new Error(`Telegram file download failed (${response.status})`);
		}
		return response.arrayBuffer();
	}

	async consumePendingUpdates(initialOffset?: number): Promise<TelegramUpdate[]> {
		let offset = initialOffset;
		const consumed: TelegramUpdate[] = [];
		while (true) {
			const updates = await this.callApi<TelegramUpdate[]>("getUpdates", {
				offset,
				timeout: 0,
				allowed_updates: ["message", "callback_query"],
			});
			if (updates.length === 0) return consumed;
			consumed.push(...updates);
			const lastUpdateId = updates[updates.length - 1]?.update_id;
			if (lastUpdateId === undefined) return consumed;
			offset = lastUpdateId + 1;
		}
	}

	async start(
		onUpdate: (update: TelegramUpdate) => Promise<void>,
		initialOffset?: number,
	): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.offset = initialOffset;
		this.loopAbort = new AbortController();

		while (this.running) {
			try {
				const updates = await this.callApi<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: this.offset,
						timeout: 30,
						allowed_updates: ["message", "callback_query"],
					},
					this.loopAbort?.signal,
				);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					await onUpdate(update);
				}
			} catch (error) {
				if (!this.running || this.loopAbort?.signal.aborted) return;
				await new Promise((resolve) => setTimeout(resolve, 1000));
				if (error instanceof Error && error.name === "AbortError") return;
			}
		}
	}

	stop(): void {
		this.running = false;
		this.loopAbort?.abort();
		this.loopAbort = undefined;
	}
}
