import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelegramConfig } from "./types.js";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export type TelegramConfigScope = "project" | "global";

export interface TelegramLocalConfig {
	token?: string;
	chatId?: number | string;
	apiBaseUrl?: string;
	notificationsEnabled?: boolean;
}

function parseChatId(value: number | string | undefined): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.trunc(value) : undefined;
	}
	if (!value?.trim()) return undefined;
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function readConfigFile(file: string): TelegramLocalConfig {
	try {
		if (!fs.existsSync(file)) return {};
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TelegramLocalConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeConfigFile(file: string, config: TelegramLocalConfig): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// ignore chmod issues on some filesystems
	}
	return file;
}

export function getProjectTelegramConfigFile(cwd: string): string {
	return path.join(cwd, ".pi", "telegram.local.json");
}

export function getGlobalTelegramConfigFile(): string {
	return path.join(AGENT_DIR, "telegram.local.json");
}

export function getTelegramConfigFile(scope: TelegramConfigScope, cwd: string): string {
	return scope === "project" ? getProjectTelegramConfigFile(cwd) : getGlobalTelegramConfigFile();
}

export function readProjectTelegramConfig(cwd: string): TelegramLocalConfig {
	return readConfigFile(getProjectTelegramConfigFile(cwd));
}

export function readGlobalTelegramConfig(): TelegramLocalConfig {
	return readConfigFile(getGlobalTelegramConfigFile());
}

export function readTelegramConfigScope(scope: TelegramConfigScope, cwd: string): TelegramLocalConfig {
	return scope === "project" ? readProjectTelegramConfig(cwd) : readGlobalTelegramConfig();
}

export function writeTelegramConfigScope(
	scope: TelegramConfigScope,
	cwd: string,
	config: TelegramLocalConfig,
): string {
	return writeConfigFile(getTelegramConfigFile(scope, cwd), config);
}

export function updateTelegramConfigScope(
	scope: TelegramConfigScope,
	cwd: string,
	patch: Partial<TelegramLocalConfig>,
): string {
	const current = readTelegramConfigScope(scope, cwd);
	const next: TelegramLocalConfig = { ...current };

	for (const [key, value] of Object.entries(patch) as Array<
		[keyof TelegramLocalConfig, TelegramLocalConfig[keyof TelegramLocalConfig]]
	>) {
		if (value === undefined) {
			delete next[key];
			continue;
		}
		switch (key) {
			case "token":
				next.token = value as TelegramLocalConfig["token"];
				break;
			case "chatId":
				next.chatId = value as TelegramLocalConfig["chatId"];
				break;
			case "apiBaseUrl":
				next.apiBaseUrl = value as TelegramLocalConfig["apiBaseUrl"];
				break;
			case "notificationsEnabled":
				next.notificationsEnabled = value as TelegramLocalConfig["notificationsEnabled"];
				break;
		}
	}

	return writeTelegramConfigScope(scope, cwd, next);
}

export function clearTelegramConfigScope(scope: TelegramConfigScope, cwd: string): string {
	const file = getTelegramConfigFile(scope, cwd);
	if (fs.existsSync(file)) fs.rmSync(file);
	return file;
}

export function loadTelegramConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
	const project = readProjectTelegramConfig(cwd);
	const global = readGlobalTelegramConfig();
	const projectToken = normalizeOptionalString(project.token);
	const globalToken = normalizeOptionalString(global.token);
	const envToken = normalizeOptionalString(env.PI_TELEGRAM_BOT_TOKEN);
	const projectChatId = parseChatId(project.chatId);
	const globalChatId = parseChatId(global.chatId);
	const envChatId = parseChatId(env.PI_TELEGRAM_CHAT_ID);
	const token = projectToken || globalToken || envToken;
	const chatId = projectChatId ?? globalChatId ?? envChatId;
	const apiBaseUrl =
		normalizeOptionalString(project.apiBaseUrl) ||
		normalizeOptionalString(global.apiBaseUrl) ||
		normalizeOptionalString(env.PI_TELEGRAM_API_BASE_URL) ||
		"https://api.telegram.org";
	const notificationsEnabled =
		project.notificationsEnabled ?? global.notificationsEnabled ?? true;
	const configured = Boolean(token && chatId !== undefined);
	const enabled = configured && notificationsEnabled;
	const hasProject = Boolean(projectToken || projectChatId !== undefined);
	const hasGlobal = Boolean(globalToken || globalChatId !== undefined);
	const hasEnv = Boolean(envToken || envChatId !== undefined);
	const source = (() => {
		const configuredSources = [hasProject, hasGlobal, hasEnv].filter(Boolean).length;
		if (configuredSources > 1) return "mixed";
		if (hasProject) return "project";
		if (hasGlobal) return "global";
		if (hasEnv) return "env";
		return "none";
	})();
	const configPath = hasProject
		? getProjectTelegramConfigFile(cwd)
		: hasGlobal
			? getGlobalTelegramConfigFile()
			: getProjectTelegramConfigFile(cwd);

	return {
		enabled,
		configured,
		notificationsEnabled,
		token,
		chatId,
		apiBaseUrl,
		configPath,
		source,
	};
}

export function setTelegramNotificationsEnabled(
	scope: TelegramConfigScope,
	cwd: string,
	enabled: boolean,
): string {
	return updateTelegramConfigScope(scope, cwd, { notificationsEnabled: enabled });
}

export function getTelegramStatusText(
	config: TelegramConfig,
	state: "attached" | "busy" | "detached" = "attached",
): string {
	if (!config.configured) return "tg:off";
	if (!config.notificationsEnabled) return "tg:paused";
	if (!config.token || config.chatId === undefined) return "tg:misconfigured";
	return `tg:${state}`;
}
