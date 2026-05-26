import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTelegramAttachmentForwardText } from "./texts-agent.js";
import type { TelegramMessage } from "./types.js";
import type { TelegramTransport } from "./transport.js";

export interface TelegramInboundFileDescriptor {
	fileId: string;
	fileName?: string;
	kind: string;
	caption?: string;
	mimeType?: string;
}

export interface SavedTelegramFile {
	localPath: string;
	fileName?: string;
	fileId: string;
	kind: string;
	caption?: string;
	mimeType?: string;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "telegram-file";
}

export function getTelegramInboundFile(message: TelegramMessage): TelegramInboundFileDescriptor | undefined {
	if (message.document) {
		return {
			fileId: message.document.file_id,
			fileName: message.document.file_name,
			kind: "document",
			caption: message.caption,
			mimeType: message.document.mime_type,
		};
	}
	if (message.photo && message.photo.length > 0) {
		const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1);
		if (!photo) return undefined;
		return {
			fileId: photo.file_id,
			fileName: `telegram-photo-${photo.file_unique_id}.jpg`,
			kind: "photo",
			caption: message.caption,
			mimeType: "image/jpeg",
		};
	}
	if (message.video) {
		return {
			fileId: message.video.file_id,
			fileName: message.video.file_name || `telegram-video-${message.video.file_unique_id}.mp4`,
			kind: "video",
			caption: message.caption,
			mimeType: message.video.mime_type,
		};
	}
	if (message.audio) {
		return {
			fileId: message.audio.file_id,
			fileName: message.audio.file_name || `telegram-audio-${message.audio.file_unique_id}`,
			kind: "audio",
			caption: message.caption,
			mimeType: message.audio.mime_type,
		};
	}
	if (message.voice) {
		return {
			fileId: message.voice.file_id,
			fileName: `telegram-voice-${message.voice.file_unique_id}.ogg`,
			kind: "voice",
			caption: message.caption,
			mimeType: message.voice.mime_type,
		};
	}
	if (message.animation) {
		return {
			fileId: message.animation.file_id,
			fileName:
				message.animation.file_name || `telegram-animation-${message.animation.file_unique_id}`,
			kind: "animation",
			caption: message.caption,
			mimeType: message.animation.mime_type,
		};
	}
	if (message.video_note) {
		return {
			fileId: message.video_note.file_id,
			fileName: `telegram-video-note-${message.video_note.file_unique_id}.mp4`,
			kind: "video_note",
			caption: message.caption,
			mimeType: "video/mp4",
		};
	}
	if (message.sticker) {
		return {
			fileId: message.sticker.file_id,
			fileName: `telegram-sticker-${message.sticker.file_unique_id}.webp`,
			kind: "sticker",
			caption: message.caption,
			mimeType: "image/webp",
		};
	}
	return undefined;
}

export async function saveTelegramFile(
	transport: TelegramTransport,
	sessionId: string,
	file: TelegramInboundFileDescriptor,
	signal?: AbortSignal,
): Promise<SavedTelegramFile> {
	const fileInfo = await transport.getFile(file.fileId);
	if (!fileInfo.file_path) {
		throw new Error(`Telegram file ${file.fileId} has no download path`);
	}
	const directory = path.join(os.tmpdir(), "pi-telegram", sanitizeFileName(sessionId));
	await mkdir(directory, { recursive: true });
	const fileName = sanitizeFileName(file.fileName || path.basename(fileInfo.file_path));
	const localPath = path.join(directory, `${Date.now()}-${fileName}`);
	const buffer = Buffer.from(await transport.downloadFile(fileInfo.file_path, signal));
	await writeFile(localPath, buffer);
	return { ...file, localPath };
}

export function buildAttachmentForwardText(file: SavedTelegramFile): string {
	return buildTelegramAttachmentForwardText(file);
}
