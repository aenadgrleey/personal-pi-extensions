/**
 * Footer Indicator Extension
 *
 * Replaces token counters with a quota indicator.
 *
 * Sources:
 * - OpenAI/Codex: Pi auth storage + `https://chatgpt.com/backend-api/wham/usage`
 * - Cursor: Cursor Desktop SQLite / macOS keychain session tokens + `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
 * - GLM / z.ai: provider API key + z.ai quota API
 * - MiniMax Token Plan: provider API key + `https://www.minimax.io/v1/token_plan/remains`
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "./deps.js";

type FiveHourQuota = {
  usedPercent: number;
  resetsAt?: number;
  source: "codex" | "cursor" | "zai" | "minimax";
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

type CursorAuth = {
  accessToken: string;
  refreshToken?: string;
  userId?: string;
  expiresAt?: number;
};

type PiCodexOAuthCredential = {
  type: "oauth";
  access?: string;
  key?: string;
  refresh?: string;
  accountId?: string;
  account_id?: string;
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

const FIVE_HOURS_MINUTES = 5 * 60;
const QUOTA_REFRESH_MS = 5 * 60 * 1000;
const COUNTDOWN_RENDER_MS = 30 * 1000;
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  let quota: FiveHourQuota | undefined;
  let currentCodexAccount: string | undefined;
  let cursorAuthCache: CursorAuth | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let currentCtx: ExtensionContext | undefined;
  let refreshInFlight = false;
  let refreshQueued = false;
  let codexSwapAccountChangedUnsub: (() => void) | undefined;

  const clearTimers = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    refreshTimer = undefined;
    countdownTimer = undefined;
  };

  const isZaiProvider = (provider?: string) => {
    const normalized = provider?.toLowerCase() ?? "";
    return (
      normalized === "zai" ||
      normalized === "glm" ||
      normalized.includes("zai") ||
      normalized.includes("glm")
    );
  };

  const isCodexProvider = (provider?: string) => {
    const normalized = provider?.toLowerCase() ?? "";
    return normalized === "openai" || normalized === "openai-codex";
  };

  const isMinimaxProvider = (provider?: string) => {
    const normalized = provider?.toLowerCase() ?? "";
    return normalized === "minimax" || normalized.includes("minimax");
  };

  const isCursorProvider = (provider?: string) => {
    const normalized = provider?.toLowerCase() ?? "";
    return normalized === "cursor" || normalized.includes("cursor");
  };

  const activeProviderNeeds5h = (provider?: string) =>
    isCodexProvider(provider) ||
    isCursorProvider(provider) ||
    isZaiProvider(provider) ||
    isMinimaxProvider(provider);

  const formatCountdown = (resetsAt?: number) => {
    if (!resetsAt) return "";

    const diffMs = Math.max(0, resetsAt - Date.now());
    const totalMinutes = Math.ceil(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0) return `rst:${minutes}m`;
    if (minutes === 0) return `rst:${hours}h`;
    return `rst:${hours}h${minutes}m`;
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
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

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

  const runCommandText = async (
    command: string,
    args: string[],
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }

          const output = stdout.trim();
          resolve(output || undefined);
        },
      );
    });

  const normalizeCursorSecret = (value?: string) => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") {
          const parsedTrimmed = parsed.trim();
          return parsedTrimmed || undefined;
        }
      } catch {
        // keep the raw token below
      }
    }
    return trimmed;
  };

  const sqliteQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

  const cursorStateDbPaths = () => {
    const paths: string[] = [];
    const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
    const appData = process.env.APPDATA?.trim();

    if (homeDir) {
      paths.push(
        join(
          homeDir,
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
        join(
          homeDir,
          ".config",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
      );
    }

    if (appData) {
      paths.push(
        join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      );
    }

    return [...new Set(paths)];
  };

  const cursorAccessTokenExpiresAt = (accessToken: string) => {
    const payload = asRecord(decodeJwtPayload(accessToken));
    const exp = payload ? getNumber(payload, "exp") : undefined;
    return typeof exp === "number" ? exp * 1000 : undefined;
  };

  const cursorUserIdFromToken = (accessToken: string) => {
    const payload = asRecord(decodeJwtPayload(accessToken));
    const userId = payload?.sub;
    return typeof userId === "string" && userId.trim()
      ? userId.trim()
      : undefined;
  };

  const buildCursorAuth = (
    accessToken: string,
    refreshToken?: string,
  ): CursorAuth | undefined => {
    const access = normalizeCursorSecret(accessToken);
    if (!access) return undefined;

    const refresh = normalizeCursorSecret(refreshToken);
    return {
      accessToken: access,
      refreshToken: refresh,
      userId: cursorUserIdFromToken(access),
      expiresAt: cursorAccessTokenExpiresAt(access),
    };
  };

  const readCursorSqliteValue = async (dbPath: string, key: string) => {
    const value = await runCommandText("sqlite3", [
      "-readonly",
      "-batch",
      "-noheader",
      dbPath,
      `SELECT value FROM ItemTable WHERE key = ${sqliteQuoted(key)} LIMIT 1;`,
    ]);
    return normalizeCursorSecret(value);
  };

  const readCursorAuthFromSqlite = async (): Promise<
    CursorAuth | undefined
  > => {
    for (const dbPath of cursorStateDbPaths()) {
      const [accessToken, refreshToken] = await Promise.all([
        readCursorSqliteValue(dbPath, "cursorAuth/accessToken"),
        readCursorSqliteValue(dbPath, "cursorAuth/refreshToken"),
      ]);

      const auth = buildCursorAuth(accessToken ?? "", refreshToken);
      if (auth) return auth;
    }

    return undefined;
  };

  const readCursorAuthFromKeychain = async (): Promise<
    CursorAuth | undefined
  > => {
    if (process.platform !== "darwin") return undefined;

    const [accessToken, refreshToken] = await Promise.all([
      runCommandText("security", [
        "find-generic-password",
        "-a",
        "cursor-user",
        "-s",
        "cursor-access-token",
        "-w",
      ]),
      runCommandText("security", [
        "find-generic-password",
        "-a",
        "cursor-user",
        "-s",
        "cursor-refresh-token",
        "-w",
      ]),
    ]);

    return buildCursorAuth(accessToken ?? "", refreshToken);
  };

  const readCursorAuth = async (): Promise<CursorAuth | undefined> => {
    const sourceAuth =
      (await readCursorAuthFromSqlite()) ??
      (await readCursorAuthFromKeychain());

    if (!sourceAuth) return cursorAuthCache;
    if (!cursorAuthCache) {
      cursorAuthCache = sourceAuth;
      return sourceAuth;
    }

    if (
      sourceAuth.userId &&
      cursorAuthCache.userId &&
      sourceAuth.userId !== cursorAuthCache.userId
    ) {
      cursorAuthCache = sourceAuth;
      return sourceAuth;
    }

    const sourceExpiry = sourceAuth.expiresAt ?? 0;
    const cachedExpiry = cursorAuthCache.expiresAt ?? 0;
    if (cachedExpiry > Date.now() && cachedExpiry > sourceExpiry) {
      return cursorAuthCache;
    }

    cursorAuthCache = sourceAuth;
    return sourceAuth;
  };

  const refreshCursorAuth = async (
    auth: CursorAuth,
  ): Promise<CursorAuth | undefined> => {
    if (
      typeof auth.expiresAt === "number" &&
      auth.expiresAt <= Date.now() &&
      !auth.refreshToken
    ) {
      return undefined;
    }

    if (!auth.refreshToken) return auth;
    if (
      typeof auth.expiresAt !== "number" ||
      auth.expiresAt - Date.now() > CURSOR_REFRESH_MARGIN_MS
    ) {
      return auth;
    }

    try {
      const response = await fetch("https://api2.cursor.sh/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CURSOR_OAUTH_CLIENT_ID,
          refresh_token: auth.refreshToken,
        }),
      });

      if (!response.ok) return auth;

      const json = asRecord(await response.json());
      if (!json) return auth;
      if (json.shouldLogout === true) {
        cursorAuthCache = undefined;
        return undefined;
      }

      const accessToken = normalizeCursorSecret(
        typeof json.access_token === "string" ? json.access_token : undefined,
      );
      if (!accessToken) {
        cursorAuthCache = undefined;
        return undefined;
      }

      const refreshed = buildCursorAuth(
        accessToken,
        normalizeCursorSecret(
          typeof json.refresh_token === "string"
            ? json.refresh_token
            : undefined,
        ) ?? auth.refreshToken,
      );
      if (!refreshed) return auth;

      const expiresIn = getNumber(json, "expires_in", "expiresIn");
      if (typeof expiresIn === "number" && !refreshed.expiresAt) {
        refreshed.expiresAt = Date.now() + expiresIn * 1000;
      }

      cursorAuthCache = refreshed;
      return refreshed;
    } catch {
      return auth;
    }
  };

  const buildCursorSessionCookie = (auth: CursorAuth) => {
    if (!auth.userId) return undefined;
    return `WorkosCursorSessionToken=${encodeURIComponent(
      `${auth.userId}::${auth.accessToken}`,
    )}`;
  };

  const parseCursorUsageResponse = (
    json: unknown,
  ): FiveHourQuota | undefined => {
    const root = asRecord(json);
    if (!root) return undefined;

    const billingCycleEnd = parseEpochMs(
      root.billingCycleEnd as number | string | undefined,
    );

    const planUsage =
      asRecord(root.planUsage) ??
      asRecord(asRecord(root.individualUsage)?.plan);
    if (!planUsage) return undefined;

    const totalPercentUsed = getNumber(planUsage, "totalPercentUsed");
    const limit = getNumber(planUsage, "limit");
    const includedSpend = getNumber(
      planUsage,
      "includedSpend",
      "totalSpend",
      "used",
    );
    const remaining = getNumber(planUsage, "remaining");

    let usedPercent = totalPercentUsed;
    if (
      typeof usedPercent !== "number" &&
      typeof limit === "number" &&
      limit > 0
    ) {
      if (typeof includedSpend === "number") {
        usedPercent =
          (Math.max(0, Math.min(limit, includedSpend)) / limit) * 100;
      } else if (typeof remaining === "number") {
        usedPercent =
          (Math.max(0, Math.min(limit, limit - remaining)) / limit) * 100;
      }
    }

    if (typeof usedPercent !== "number") return undefined;

    const windows: UsageWindow[] = [
      {
        label: "plan",
        usedPercent: clampPercent(usedPercent),
        resetsAt: billingCycleEnd,
      },
    ];

    const apiPercentUsed = getNumber(planUsage, "apiPercentUsed");
    if (typeof apiPercentUsed === "number") {
      windows.push({
        label: "api",
        usedPercent: clampPercent(apiPercentUsed),
        resetsAt: billingCycleEnd,
      });
    }

    const autoPercentUsed = getNumber(planUsage, "autoPercentUsed");
    if (typeof autoPercentUsed === "number") {
      windows.push({
        label: "auto",
        usedPercent: clampPercent(autoPercentUsed),
        resetsAt: billingCycleEnd,
      });
    }

    return {
      usedPercent: windows[0].usedPercent,
      resetsAt: billingCycleEnd,
      source: "cursor",
      windows,
    };
  };

  const fetchCursorQuotaFromPrimary = async (
    auth: CursorAuth,
  ): Promise<FiveHourQuota | undefined> => {
    const response = await fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
      },
    );

    if (!response.ok) return undefined;
    return parseCursorUsageResponse(await response.json());
  };

  const fetchCursorQuotaFromDashboard = async (
    auth: CursorAuth,
  ): Promise<FiveHourQuota | undefined> => {
    const cookie = buildCursorSessionCookie(auth);
    if (!cookie) return undefined;

    const response = await fetch("https://cursor.com/api/usage-summary", {
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "User-Agent": "pi-indicators-extension",
      },
    });

    if (!response.ok) return undefined;
    return parseCursorUsageResponse(await response.json());
  };

  const fetchCursorQuotaFromRequestBased = async (
    auth: CursorAuth,
  ): Promise<FiveHourQuota | undefined> => {
    const cookie = buildCursorSessionCookie(auth);
    if (!cookie || !auth.userId) return undefined;

    const response = await fetch(
      `https://cursor.com/api/usage?user=${encodeURIComponent(auth.userId)}`,
      {
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "User-Agent": "pi-indicators-extension",
        },
      },
    );

    if (!response.ok) return undefined;
    return parseCursorUsageResponse(await response.json());
  };

  const fetchCursorFiveHourQuota = async (): Promise<
    FiveHourQuota | undefined
  > => {
    const auth = await readCursorAuth();
    if (!auth?.accessToken) return undefined;

    const refreshedAuth = await refreshCursorAuth(auth);
    if (!refreshedAuth?.accessToken) return undefined;

    return (
      (await fetchCursorQuotaFromPrimary(refreshedAuth)) ??
      (await fetchCursorQuotaFromDashboard(refreshedAuth)) ??
      (await fetchCursorQuotaFromRequestBased(refreshedAuth))
    );
  };

  const decodeJwtPayload = (
    token?: string,
  ): Record<string, unknown> | undefined => {
    if (!token) return undefined;
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return undefined;
    try {
      const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(
        Buffer.from(padded, "base64").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  const inferCodexAccountLabel = (
    credential: PiCodexOAuthCredential,
  ): string | undefined => {
    const payload = decodeJwtPayload(credential.access);
    const profile = payload?.["https://api.openai.com/profile"] as
      Record<string, unknown> | undefined;
    const email = profile?.email ?? payload?.email;
    if (typeof email === "string" && email.trim()) return email;

    const accountId = credential.accountId || credential.account_id;
    return accountId ? `acc:${accountId}` : undefined;
  };

  const readCodexAuth = async (
    ctx: ExtensionContext,
  ): Promise<CodexAuth | undefined> => {
    const credential = ctx.modelRegistry.authStorage.get("openai-codex");
    if (
      !credential ||
      credential.type !== "oauth" ||
      (credential.access !== undefined &&
        typeof credential.access !== "string") ||
      (credential.key !== undefined && typeof credential.key !== "string") ||
      (credential.accountId !== undefined &&
        typeof credential.accountId !== "string") ||
      (credential.account_id !== undefined &&
        typeof credential.account_id !== "string")
    ) {
      return undefined;
    }

    const accessToken = credential.access || credential.key || undefined;
    const accountId =
      credential.accountId || credential.account_id || undefined;
    currentCodexAccount = inferCodexAccountLabel(credential);
    if (!accessToken) return undefined;
    return { accessToken, accountId };
  };

  const fetchCodexFiveHourQuota = async (
    ctx: ExtensionContext,
  ): Promise<FiveHourQuota | undefined> => {
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
        secondary_window?: {
          used_percent?: number;
          reset_at?: number;
          limit_window_seconds?: number;
        };
      };
    };

    const window = json.rate_limit?.primary_window;
    if (!window || typeof window.used_percent !== "number") return undefined;
    if (
      window.limit_window_seconds &&
      window.limit_window_seconds !== FIVE_HOURS_MINUTES * 60
    )
      return undefined;

    const windows: UsageWindow[] = [
      {
        label: "5h",
        usedPercent: clampPercent(window.used_percent),
        resetsAt:
          typeof window.reset_at === "number"
            ? window.reset_at > 10_000_000_000
              ? window.reset_at
              : window.reset_at * 1000
            : undefined,
      },
    ];

    const secondaryWindow = json.rate_limit?.secondary_window;
    const secondaryUsedPercent = secondaryWindow?.used_percent;
    if (secondaryWindow && typeof secondaryUsedPercent === "number") {
      windows.push({
        label: "7d",
        usedPercent: clampPercent(secondaryUsedPercent),
        resetsAt:
          typeof secondaryWindow.reset_at === "number"
            ? secondaryWindow.reset_at > 10_000_000_000
              ? secondaryWindow.reset_at
              : secondaryWindow.reset_at * 1000
            : undefined,
      });
    }

    return {
      usedPercent: windows[0].usedPercent,
      resetsAt: windows[0].resetsAt,
      source: "codex",
      windows,
    };
  };

  const resolveZaiQuotaUrl = (baseUrl?: string) => {
    const directOverride = process.env.Z_AI_QUOTA_URL?.trim();
    if (directOverride) return directOverride;

    const hostOverride = process.env.Z_AI_API_HOST?.trim();
    if (hostOverride) {
      const withScheme = /^https?:\/\//i.test(hostOverride)
        ? hostOverride
        : `https://${hostOverride}`;
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
        return clampPercent(
          (Math.max(0, Math.min(limit.usage, usedRaw)) / limit.usage) * 100,
        );
      }
    }

    return clampPercent(limit.percentage ?? 0);
  };

  const fetchZaiFiveHourQuota = async (
    apiKey: string,
    baseUrl?: string,
  ): Promise<FiveHourQuota | undefined> => {
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

    if (
      json.success !== true ||
      json.code !== 200 ||
      !json.data?.limits?.length
    )
      return undefined;

    const tokenLimits = json.data.limits
      .filter((limit) => limit.type === "TOKENS_LIMIT")
      .map((limit) => ({
        usedPercent: getZaiUsedPercent(limit),
        windowMinutes: getZaiWindowMinutes(limit.unit, limit.number),
        resetsAt:
          typeof limit.nextResetTime === "number"
            ? limit.nextResetTime
            : undefined,
      }))
      .filter((limit) => typeof limit.windowMinutes === "number")
      .sort(
        (a, b) =>
          (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) -
          (b.windowMinutes ?? Number.MAX_SAFE_INTEGER),
      );

    const sessionLimit = tokenLimits.find(
      (limit) =>
        (limit.windowMinutes ?? Number.MAX_SAFE_INTEGER) <= FIVE_HOURS_MINUTES,
    );
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

  const minimaxResetAt = (
    model: Record<string, unknown>,
    capturedAt: number,
    ...keys: string[]
  ) => {
    const raw = keys
      .map((key) => model[key])
      .find((value) => value !== undefined);
    const seconds =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : undefined;
    // If it looks like an epoch in milliseconds (> 10B), return it directly.
    // MiniMax `end_time` values like 1778630400000 are millisecond epochs.
    if (typeof seconds === "number" && seconds > 10_000_000_000) {
      return seconds;
    }
    // Cap session reset at 8 hours to avoid absurd values (weekly quota bugs, etc.)
    const SESSION_MAX_SECONDS = 8 * 3600;
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds > 0 &&
      seconds < SESSION_MAX_SECONDS
    ) {
      return capturedAt + seconds * 1000;
    }
    return parseEpochMs(raw as number | string | undefined);
  };

  const minimaxUsedPercent = (
    model: Record<string, unknown>,
    totalKeys: [string, string],
    remainingCountKeys: [string, string],
    remainingPercentKeys: [string, string],
  ) => {
    const total = getNumber(model, ...totalKeys);
    const remaining = getNumber(model, ...remainingCountKeys);
    if (total && total > 0 && typeof remaining === "number") {
      // MiniMax reports `*_usage_count` as remaining quota, not consumed usage.
      return clampPercent(
        100 - (Math.max(0, Math.min(total, remaining)) / total) * 100,
      );
    }

    const remainingPercent = getNumber(model, ...remainingPercentKeys);
    if (typeof remainingPercent === "number") {
      const normalizedRemainingPercent =
        remainingPercent <= 1 ? remainingPercent * 100 : remainingPercent;
      return clampPercent(100 - clampPercent(normalizedRemainingPercent));
    }

    return undefined;
  };

  const parseMinimaxQuota = (
    json: unknown,
    capturedAt: number,
  ): FiveHourQuota | undefined => {
    const root = asRecord(json);
    if (!root) return undefined;

    const baseResp = asRecord(root.base_resp) ?? asRecord(root.baseResp);
    const statusCode = baseResp
      ? getNumber(baseResp, "status_code", "statusCode")
      : 0;
    if (statusCode && statusCode !== 0) return undefined;

    const data = asRecord(root.data) ?? root;
    const modelRemains = data.model_remains ?? data.modelRemains;
    if (!Array.isArray(modelRemains)) return undefined;

    const models = modelRemains
      .map(asRecord)
      .filter((model): model is Record<string, unknown> => Boolean(model));
    const hasSessionSignal = (model: Record<string, unknown>) =>
      (getNumber(
        model,
        "current_interval_total_count",
        "currentIntervalTotalCount",
      ) ?? 0) > 0 ||
      getNumber(
        model,
        "current_interval_remaining_percent",
        "currentIntervalRemainingPercent",
      ) !== undefined;
    const textModel =
      models.find((model) => {
        const name = String(
          model.model_name ?? model.modelName ?? "",
        ).toLowerCase();
        return name.startsWith("minimax-m") && hasSessionSignal(model);
      }) ??
      models.find((model) => {
        const name = String(
          model.model_name ?? model.modelName ?? "",
        ).toLowerCase();
        return (
          (name === "general" || name.includes("text")) &&
          hasSessionSignal(model)
        );
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
        resetsAt: minimaxResetAt(textModel, capturedAt, "end_time", "endTime"),
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
          "weekly_end_time",
          "weeklyEndTime",
        ),
      });
    }

    const result = {
      usedPercent: sessionUsedPercent,
      resetsAt: windows[0].resetsAt,
      source: "minimax" as const,
      windows,
    };
    return result;
  };

  const fetchMinimaxQuota = async (
    apiKey: string,
    baseUrl?: string,
  ): Promise<FiveHourQuota | undefined> => {
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
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;

    try {
      const provider = ctx.model?.provider?.toLowerCase();
      if (isCodexProvider(provider)) {
        quota = await fetchCodexFiveHourQuota(ctx);
      } else if (isCursorProvider(provider)) {
        quota = await fetchCursorFiveHourQuota();
      } else if (isZaiProvider(provider)) {
        const providerId = ctx.model?.provider;
        const apiKey = providerId
          ? await ctx.modelRegistry.getApiKeyForProvider(providerId)
          : undefined;
        quota = apiKey
          ? await fetchZaiFiveHourQuota(apiKey, ctx.model?.baseUrl)
          : undefined;
      } else if (isMinimaxProvider(provider)) {
        const providerId = ctx.model?.provider;
        const apiKey = providerId
          ? await ctx.modelRegistry.getApiKeyForProvider(providerId)
          : undefined;
        quota = apiKey
          ? await fetchMinimaxQuota(apiKey, ctx.model?.baseUrl)
          : undefined;
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
      if (refreshQueued) {
        refreshQueued = false;
        void refreshQuota(ctx);
      }
    }
  };

  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      currentCtx = ctx;
      if (!ctx.hasUI) return;

      clearTimers();
      quota = undefined;
      currentCodexAccount = undefined;
      cursorAuthCache = undefined;
      refreshQueued = false;

      codexSwapAccountChangedUnsub?.();
      codexSwapAccountChangedUnsub = pi.events.on(
        "codexswap:account-changed",
        () => {
          if (!currentCtx?.hasUI) return;
          currentCodexAccount = undefined;
          void refreshQuota(currentCtx);
        },
      );

      ctx.ui.setFooter(
        (
          tui: FooterTuiLike,
          theme: FooterThemeLike,
          footerData: FooterDataLike,
        ) => {
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
              const contextStr =
                usage?.tokens !== null && usage
                  ? `ctx:${Math.round((usage.tokens / usage.contextWindow) * 100)}%`
                  : "";

              const activeProvider = ctx.model?.provider?.toLowerCase();
              const quotaStr = quota
                ? [
                    `usage:${(
                      quota.windows ?? [
                        { label: "", usedPercent: quota.usedPercent },
                      ]
                    )
                      .map(
                        (window) =>
                          `${window.label ? `${window.label}:` : ""}${Math.round(window.usedPercent)}%`,
                      )
                      .join(" ")}`,
                    formatCountdown(quota.resetsAt),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : activeProviderNeeds5h(activeProvider)
                  ? "usage:-- rst:--"
                  : "";
              const costStr = `$${cost.toFixed(3)}`;
              const leftText = [costStr, contextStr].filter(Boolean).join(" ");
              const left = theme.fg("dim", leftText);

              const branchStr = branch ? theme.fg("dim", ` (${branch})`) : "";
              const thinking = pi.getThinkingLevel();
              const thinkingStr = thinking !== "off" ? `:${thinking}` : "";
              const modelStr = theme.fg(
                "dim",
                (ctx.model?.id || "no-model") + thinkingStr,
              );

              let statusStr = "";
              if (statuses.size > 0) {
                statusStr = `${[...statuses.values()].join(" ")} `;
              }

              const quotaPart = quotaStr ? `${theme.fg("dim", quotaStr)} ` : "";
              const accountPart =
                isCodexProvider(activeProvider) && currentCodexAccount
                  ? `${theme.fg("dim", `acc:${currentCodexAccount}`)} `
                  : "";
              const right = `${statusStr}${quotaPart}${accountPart}${modelStr}${branchStr}`;
              const pad = " ".repeat(
                Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
              );
              return [truncateToWidth(left + pad + right, width)];
            },
          };
        },
      );

      await refreshQuota(ctx);
      refreshTimer = setInterval(
        () => void refreshQuota(ctx),
        QUOTA_REFRESH_MS,
      );
      countdownTimer = setInterval(
        () => requestRender?.(),
        COUNTDOWN_RENDER_MS,
      );
    },
  );

  pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    await refreshQuota(ctx);
  });

  pi.on(
    "message_end",
    async (event: { message: { role: string } }, ctx: ExtensionContext) => {
      if (!ctx.hasUI || event.message.role !== "assistant") return;
      await refreshQuota(ctx);
    },
  );

  pi.on("session_shutdown", async () => {
    clearTimers();
    codexSwapAccountChangedUnsub?.();
    codexSwapAccountChangedUnsub = undefined;
    refreshQueued = false;
    requestRender = undefined;
    currentCtx = undefined;
    quota = undefined;
    currentCodexAccount = undefined;
    cursorAuthCache = undefined;
  });
}
