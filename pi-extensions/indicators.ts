/**
 * Footer Indicator Extension
 *
 * Replaces token counters with a 5-hour quota indicator.
 *
 * Sources:
 * - OpenAI/Codex: pi auth storage (`~/.pi/agent/auth.json`) + `https://chatgpt.com/backend-api/wham/usage`
 * - GLM / z.ai: provider API key + z.ai quota API
 * - MiniMax Token Plan: provider API key + `https://www.minimax.io/v1/token_plan/remains`
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import { getOpenAICodexFromAuth } from "./codex-swap/index.js";
import { truncateToWidth, visibleWidth } from "./deps.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type FiveHourQuota = {
	usedPercent: number;
	resetsAt?: number;
	source: "codex" | "zai" | "minimax";
	windows?: UsageWindow[];
};

type UsageWindow = {
	label: string;
	usedPercent: number;
	resetsAt?: number;
};

type CodexAuth = {
	accessToken: string;
	accountId?: string;
};

type PiCodexOAuthCredential = {
	type: "oauth";
	access?: string;
	key?: string;
	refresh?: string;
	accountId?: string;
	account_id?: string;
};

type CodexSwapStore = {
	profiles?: Array<{
		label: string;
		email?: string;
		accountId?: string;
		oauth?: {
			refresh?: string;
		};
	}>;
};

type FooterTuiLike = {
	requestRender(): void;
};

type FooterThemeLike = {
	fg(color: string, text: string): string;
};

type FooterDataLike = {
	onBranchChange(listener: () => void): () => void;
	getGitBranch(): string | null | undefined;
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CODEX_SWAP_STORE_FILE = join(AGENT_DIR, "codexswap.json");
const FIVE_HOURS_MINUTES = 5 * 60;
const QUOTA_REFRESH_MS = 5 * 60 * 1000;
const COUNTDOWN_RENDER_MS = 30 * 1000;

export default function (pi: ExtensionAPI) {
	let quota: FiveHourQuota | undefined;
	let currentCodexAccount: string | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;
	let currentCtx: ExtensionContext | undefined;
	let refreshInFlight = false;

	const clearTimers = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (countdownTimer) clearInterval(countdownTimer);
		refreshTimer = undefined;
		countdownTimer = undefined;
	};

	const isZaiProvider = (provider?: string) => {
		const normalized = provider?.toLowerCase() ?? "";
		return normalized === "zai" || normalized === "glm" || normalized.includes("zai") || normalized.includes("glm");
	};

	const isCodexProvider = (provider?: string) => {
		const normalized = provider?.toLowerCase() ?? "";
		return normalized === "openai" || normalized === "openai-codex";
	};

	const isMinimaxProvider = (provider?: string) => {
		const normalized = provider?.toLowerCase() ?? "";
		return normalized === "minimax" || normalized.includes("minimax");
	};

	const activeProviderNeeds5h = (provider?: string) =>
		isCodexProvider(provider) || isZaiProvider(provider) || isMinimaxProvider(provider);

	const formatCountdown = (resetsAt?: number) => {
		if (!resetsAt) return "";

		const diffMs = Math.max(0, resetsAt - Date.now());
		const totalMinutes = Math.ceil(diffMs / 60000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;

		if (hours <= 0) return `reset:${minutes}m`;
		if (minutes === 0) return `reset:${hours}h`;
		return `reset:${hours}h${minutes}m`;
	};

	const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

	const parseEpochMs = (value?: number | string) => {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value > 10_000_000_000 ? value : value * 1000;
		}
		if (typeof value === "string" && value.trim()) {
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		}
		return undefined;
	};

	const asRecord = (value: unknown): Record<string, unknown> | undefined =>
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

	const getNumber = (record: Record<string, unknown>, ...keys: string[]) => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string" && value.trim()) {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		return undefined;
	};

	const decodeJwtPayload = (token?: string): Record<string, unknown> | undefined => {
		if (!token) return undefined;
		const payloadPart = token.split(".")[1];
		if (!payloadPart) return undefined;
		try {
			const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
			const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
			return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	};

	const inferCodexAccountLabel = (credential: PiCodexOAuthCredential): string | undefined => {
		try {
			const raw = readFileSync(CODEX_SWAP_STORE_FILE, "utf8");
			const store = JSON.parse(raw) as CodexSwapStore;
			const match = store.profiles?.find((profile) => profile.oauth?.refresh === credential.refresh);
			if (match?.label) return match.label;
		} catch {
			// ignore store lookup errors and fall back to token/account info
		}

		const payload = decodeJwtPayload(credential.access);
		const profile = payload?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
		const email = profile?.email ?? payload?.email;
		if (typeof email === "string" && email.trim()) return email;

		const accountId = credential.accountId || credential.account_id;
		return accountId ? `acc:${accountId}` : undefined;
	};

	const readCodexAuth = async (_ctx: ExtensionContext): Promise<CodexAuth | undefined> => {
		const credential = getOpenAICodexFromAuth() as PiCodexOAuthCredential | null;
		if (credential?.type !== "oauth") return undefined;

		const accessToken = credential.access || credential.key || undefined;
		const accountId = credential.accountId || credential.account_id || undefined;
		currentCodexAccount = inferCodexAccountLabel(credential);
		if (!accessToken) return undefined;
		return { accessToken, accountId };
	};

	const fetchCodexFiveHourQuota = async (ctx: ExtensionContext): Promise<FiveHourQuota | undefined> => {
		const auth = await readCodexAuth(ctx);
		if (!auth?.accessToken) return undefined;

		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				Authorization: `Bearer ${auth.accessToken}`,
				Accept: "application/json",
				"User-Agent": "pi-indicators-extension",
				...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
			},
		});

		if (!response.ok) return undefined;

		const json = (await response.json()) as {
			rate_limit?: {
				primary_window?: {
					used_percent?: number;
					reset_at?: number;
					limit_window_seconds?: number;
				};
			};
		};

		const window = json.rate_limit?.primary_window;
		if (!window || typeof window.used_percent !== "number") return undefined;
		if (window.limit_window_seconds && window.limit_window_seconds !== FIVE_HOURS_MINUTES * 60) return undefined;

		return {
			usedPercent: clampPercent(window.used_percent),
			resetsAt:
				typeof window.reset_at === "number"
					? window.reset_at > 10_000_000_000
						? window.reset_at
						: window.reset_at * 1000
					: undefined,
			source: "codex",
		};
	};

	const resolveZaiQuotaUrl = (baseUrl?: string) => {
		const directOverride = process.env.Z_AI_QUOTA_URL?.trim();
		if (directOverride) return directOverride;

		const hostOverride = process.env.Z_AI_API_HOST?.trim();
		if (hostOverride) {
			const withScheme = /^https?:\/\//i.test(hostOverride) ? hostOverride : `https://${hostOverride}`;
			return `${withScheme.replace(/\/+$/, "")}/api/monitor/usage/quota/limit`;
		}

		if (baseUrl && /open\.bigmodel\.cn/i.test(baseUrl)) {
			return "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
		}

		return "https://api.z.ai/api/monitor/usage/quota/limit";
	};

	const getZaiWindowMinutes = (unit?: number, amount?: number) => {
		if (!amount || amount <= 0) return undefined;
		switch (unit) {
			case 5:
				return amount;
			case 3:
				return amount * 60;
			case 1:
				return amount * 24 * 60;
			case 6:
				return amount * 7 * 24 * 60;
			default:
				return undefined;
		}
	};

	const getZaiUsedPercent = (limit: {
		usage?: number;
		currentValue?: number;
		remaining?: number;
		percentage?: number;
	}) => {
		if (typeof limit.usage === "number" && limit.usage > 0) {
			let usedRaw: number | undefined;
			if (typeof limit.remaining === "number") {
				const usedFromRemaining = limit.usage - limit.remaining;
				usedRaw =
					typeof limit.currentValue === "number"
						? Math.max(usedFromRemaining, limit.currentValue)
						: usedFromRemaining;
			} else if (typeof limit.currentValue === "number") {
				usedRaw = limit.currentValue;
			}
			if (typeof usedRaw === "number") {
				return clampPercent((Math.max(0, Math.min(limit.usage, usedRaw)) / limit.usage) * 100);
			}
		}

		return clampPercent(limit.percentage ?? 0);
	};

	const fetchZaiFiveHourQuota = async (apiKey: string, baseUrl?: string): Promise<FiveHourQuota | undefined> => {
		if (!apiKey) return undefined;

		const response = await fetch(resolveZaiQuotaUrl(baseUrl), {
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json",
			},
		});

		if (!response.ok) return undefined;

		const json = (await response.json()) as {
			success?: boolean;
			code?: number;
			data?: {
				limits?: Array<{
					type?: string;
					unit?: number;
					number?: number;
					usage?: number;
					currentValue?: number;
					remaining?: number;
					percentage?: number;
					nextResetTime?: number;
				}>;
			};
		};

		if (json.success !== true || json.code !== 200 || !json.data?.limits?.length) return undefined;

		const tokenLimits = json.data.limits
			.filter((limit) => limit.type === "TOKENS_LIMIT")
			.map((limit) => ({
				usedPercent: getZaiUsedPercent(limit),
				windowMinutes: getZaiWindowMinutes(limit.unit, limit.number),
				resetsAt: typeof limit.nextResetTime === "number" ? limit.nextResetTime : undefined,
			}))
			.filter((limit) => typeof limit.windowMinutes === "number")
			.sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER));

		const sessionLimit = tokenLimits.find((limit) => (limit.windowMinutes ?? Number.MAX_SAFE_INTEGER) <= FIVE_HOURS_MINUTES);
		if (!sessionLimit) return undefined;

		return {
			usedPercent: sessionLimit.usedPercent,
			resetsAt: sessionLimit.resetsAt,
			source: "zai",
		};
	};

	const minimaxQuotaUrls = (baseUrl?: string) => {
		const urls: string[] = [];
		try {
			if (baseUrl?.trim()) {
				const parsed = new URL(baseUrl);
				urls.push(`${parsed.origin}/v1/token_plan/remains`);
			}
		} catch {
			// ignore malformed configured URL and use documented fallbacks
		}

		for (const url of [
			"https://www.minimax.io/v1/token_plan/remains",
			"https://api.minimax.io/v1/token_plan/remains",
			"https://api.minimaxi.com/v1/token_plan/remains",
		]) {
			if (!urls.includes(url)) urls.push(url);
		}
		return urls;
	};

	const minimaxResetAt = (model: Record<string, unknown>, capturedAt: number, ...keys: string[]) => {
		const raw = keys.map((key) => model[key]).find((value) => value !== undefined);
		const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
		if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds < 10_000_000) {
			return capturedAt + seconds * 1000;
		}
		return parseEpochMs(raw as number | string | undefined);
	};

	const minimaxUsedPercent = (
		model: Record<string, unknown>,
		totalKeys: [string, string],
		usedKeys: [string, string],
		remainingPercentKeys: [string, string],
	) => {
		const total = getNumber(model, ...totalKeys);
		const used = getNumber(model, ...usedKeys);
		if (total && total > 0 && typeof used === "number") {
			// `/v1/token_plan/remains` reports `*_usage_count` as used count.
			return clampPercent((Math.max(0, Math.min(total, used)) / total) * 100);
		}

		const remainingPercent = getNumber(model, ...remainingPercentKeys);
		if (typeof remainingPercent === "number") {
			return clampPercent(100 - clampPercent(remainingPercent <= 1 ? remainingPercent * 100 : remainingPercent));
		}

		return undefined;
	};

	const parseMinimaxQuota = (json: unknown, capturedAt: number): FiveHourQuota | undefined => {
		const root = asRecord(json);
		if (!root) return undefined;

		const baseResp = asRecord(root.base_resp) ?? asRecord(root.baseResp);
		const statusCode = baseResp ? getNumber(baseResp, "status_code", "statusCode") : 0;
		if (statusCode && statusCode !== 0) return undefined;

		const data = asRecord(root.data) ?? root;
		const modelRemains = data.model_remains ?? data.modelRemains;
		if (!Array.isArray(modelRemains)) return undefined;

		const models = modelRemains.map(asRecord).filter((model): model is Record<string, unknown> => Boolean(model));
		const hasSessionSignal = (model: Record<string, unknown>) =>
			(getNumber(model, "current_interval_total_count", "currentIntervalTotalCount") ?? 0) > 0 ||
			getNumber(model, "current_interval_remaining_percent", "currentIntervalRemainingPercent") !== undefined;
		const textModel =
			models.find((model) => {
				const name = String(model.model_name ?? model.modelName ?? "").toLowerCase();
				return name.startsWith("minimax-m") && hasSessionSignal(model);
			}) ??
			models.find((model) => {
				const name = String(model.model_name ?? model.modelName ?? "").toLowerCase();
				return (name === "general" || name.includes("text")) && hasSessionSignal(model);
			}) ??
			models.find(hasSessionSignal);

		if (!textModel) return undefined;

		const sessionUsedPercent = minimaxUsedPercent(
			textModel,
			["current_interval_total_count", "currentIntervalTotalCount"],
			["current_interval_usage_count", "currentIntervalUsageCount"],
			["current_interval_remaining_percent", "currentIntervalRemainingPercent"],
		);
		if (typeof sessionUsedPercent !== "number") return undefined;

		const windows: UsageWindow[] = [
			{
				label: "5h",
				usedPercent: sessionUsedPercent,
				resetsAt: minimaxResetAt(textModel, capturedAt, "remains_time", "remainsTime", "end_time", "endTime"),
			},
		];

		const weeklyUsedPercent = minimaxUsedPercent(
			textModel,
			["current_weekly_total_count", "currentWeeklyTotalCount"],
			["current_weekly_usage_count", "currentWeeklyUsageCount"],
			["current_weekly_remaining_percent", "currentWeeklyRemainingPercent"],
		);
		if (typeof weeklyUsedPercent === "number") {
			windows.push({
				label: "7d",
				usedPercent: weeklyUsedPercent,
				resetsAt: minimaxResetAt(
					textModel,
					capturedAt,
					"weekly_remains_time",
					"weeklyRemainsTime",
					"weekly_end_time",
					"weeklyEndTime",
				),
			});
		}

		return {
			usedPercent: sessionUsedPercent,
			resetsAt: windows[0].resetsAt,
			source: "minimax",
			windows,
		};
	};

	const fetchMinimaxQuota = async (apiKey: string, baseUrl?: string): Promise<FiveHourQuota | undefined> => {
		if (!apiKey) return undefined;

		for (const url of minimaxQuotaUrls(baseUrl)) {
			const capturedAt = Date.now();
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) continue;
			const quota = parseMinimaxQuota(await response.json(), capturedAt);
			if (quota) return quota;
		}

		return undefined;
	};

	const refreshQuota = async (ctx: ExtensionContext) => {
		if (refreshInFlight) return;
		refreshInFlight = true;

		try {
			const provider = ctx.model?.provider?.toLowerCase();
			if (isCodexProvider(provider)) {
				quota = await fetchCodexFiveHourQuota(ctx);
			} else if (isZaiProvider(provider)) {
				const providerId = ctx.model?.provider;
				const apiKey = providerId
					? await ctx.modelRegistry.getApiKeyForProvider(providerId)
					: undefined;
				quota = apiKey ? await fetchZaiFiveHourQuota(apiKey, ctx.model?.baseUrl) : undefined;
			} else if (isMinimaxProvider(provider)) {
				const providerId = ctx.model?.provider;
				const apiKey = providerId
					? await ctx.modelRegistry.getApiKeyForProvider(providerId)
					: undefined;
				quota = apiKey ? await fetchMinimaxQuota(apiKey, ctx.model?.baseUrl) : undefined;
			} else {
				quota = undefined;
				currentCodexAccount = undefined;
			}
		} catch {
			quota = undefined;
			currentCodexAccount = undefined;
		} finally {
			refreshInFlight = false;
			requestRender?.();
		}
	};

	pi.events.on("codexswap:account-changed", () => {
		if (!currentCtx?.hasUI) return;
		quota = undefined;
		currentCodexAccount = undefined;
		requestRender?.();
		void refreshQuota(currentCtx);
	});

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (!ctx.hasUI) return;

		clearTimers();
		quota = undefined;
		currentCodexAccount = undefined;

		ctx.ui.setFooter((tui: FooterTuiLike, theme: FooterThemeLike, footerData: FooterDataLike) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsub();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							cost += m.usage.cost.total;
						}
					}

					const branch = footerData.getGitBranch();
					const statuses = footerData.getExtensionStatuses();
					const usage = ctx.getContextUsage();
					const contextStr = usage?.tokens !== null && usage
						? `ctx:${Math.round((usage.tokens / usage.contextWindow) * 100)}%`
						: "";

					const activeProvider = ctx.model?.provider?.toLowerCase();
					const quotaStr = quota
						? [
								`usage:${(quota.windows ?? [{ label: "", usedPercent: quota.usedPercent }])
									.map((window) => `${window.label ? `${window.label}:` : ""}${Math.round(window.usedPercent)}%`)
									.join(" ")}`,
								formatCountdown(quota.resetsAt),
							]
								.filter(Boolean)
								.join(" ")
						: activeProviderNeeds5h(activeProvider)
							? "usage:-- reset:--"
							: "";
					const costStr = `$${cost.toFixed(3)}`;
					const leftText = [costStr, contextStr].filter(Boolean).join(" ");
					const left = theme.fg("dim", leftText);

					const branchStr = branch ? theme.fg("dim", ` (${branch})`) : "";
					const thinking = pi.getThinkingLevel();
					const thinkingStr = thinking !== "off" ? `:${thinking}` : "";
					const modelStr = theme.fg("dim", (ctx.model?.id || "no-model") + thinkingStr);

					let statusStr = "";
					if (statuses.size > 0) {
						statusStr = `${[...statuses.values()].join(" ")} `;
					}

					const quotaPart = quotaStr ? `${theme.fg("dim", quotaStr)} ` : "";
					const accountPart = isCodexProvider(activeProvider) && currentCodexAccount
						? `${theme.fg("dim", `acc:${currentCodexAccount}`)} `
						: "";
					const right = `${statusStr}${quotaPart}${accountPart}${modelStr}${branchStr}`;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});

		await refreshQuota(ctx);
		refreshTimer = setInterval(() => void refreshQuota(ctx), QUOTA_REFRESH_MS);
		countdownTimer = setInterval(() => requestRender?.(), COUNTDOWN_RENDER_MS);
	});

	pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		await refreshQuota(ctx);
	});

	pi.on("message_end", async (event: { message: { role: string } }, ctx: ExtensionContext) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		await refreshQuota(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimers();
		requestRender = undefined;
		currentCtx = undefined;
		quota = undefined;
		currentCodexAccount = undefined;
	});
}
