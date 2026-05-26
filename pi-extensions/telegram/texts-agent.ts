import { readFileSync } from "node:fs";

export interface TelegramAgentMessagePart {
	type: string;
	text?: string;
}

export interface TelegramAttachmentPromptInput {
	localPath: string;
	fileId: string;
	fileName?: string;
	kind: string;
	caption?: string;
	mimeType?: string;
}

export interface TelegramSkillPromptInput {
	skillName: string;
	filePath: string;
	baseDir: string;
	task: string;
}

function trimAgentText(text: string): string {
	return text.replace(/[ \t]+$/gm, "").trim();
}

function previewAgentText(text: string, limit = 280): string {
	const normalized = trimAgentText(text).replace(/\s+/g, " ");
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content.trim();
	const closingIndex = content.indexOf("\n---\n", 4);
	if (closingIndex < 0) return content.trim();
	return content.slice(closingIndex + 5).trim();
}

export function quoteReplyText(text: string): string {
	const cleaned = trimAgentText(text);
	if (!cleaned) return "";
	return cleaned
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

export function injectReplyContext(text: string, repliedToText?: string): string {
	const body = trimAgentText(text);
	const replyContext = repliedToText ? trimAgentText(repliedToText) : "";
	if (!replyContext) return body;
	return body ? `Reply context:\n${replyContext}\n\n${body}` : `Reply context:\n${replyContext}`;
}

export function buildTelegramAttachmentForwardText(file: TelegramAttachmentPromptInput): string {
	const lines = [
		`Telegram ${file.kind} saved to: ${file.localPath}`,
		`Source file id: ${file.fileId}`,
	];
	if (file.fileName) lines.push(`Original name: ${file.fileName}`);
	if (file.mimeType) lines.push(`MIME type: ${file.mimeType}`);
	if (file.caption?.trim()) lines.push(`Caption: ${previewAgentText(file.caption.trim(), 500)}`);
	lines.push("Use the saved local path for any reads or processing.");
	return lines.join("\n");
}

export function buildTelegramSkillPrompt(input: TelegramSkillPromptInput): string {
	const content = readFileSync(input.filePath, "utf8");
	const body = stripFrontmatter(content);
	const skillBlock = `<skill name="${input.skillName}" location="${input.filePath}">\nReferences are relative to ${input.baseDir}.\n\n${body}\n</skill>`;
	const trimmedTask = input.task.trim();
	return trimmedTask ? `${skillBlock}\n\n${trimmedTask}` : skillBlock;
}
