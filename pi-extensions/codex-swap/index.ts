import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type OAuthCred = {
  type: "oauth";
  refresh?: string;
  access?: string;
  key?: string;
  expires?: number;
  accountId?: string;
  account_id?: string;
  [k: string]: unknown;
};

type Profile = {
  id: string;
  label: string;
  savedAt: number;
  email?: string;
  accountId?: string;
  oauth: OAuthCred;
};

type StoreV2 = {
  version: 2;
  activeProfileId?: string;
  lastProfileId?: string;
  profiles: Profile[];
};

type LegacySlotName = "current" | "previous";

type LegacySlot = {
  label: string;
  savedAt: number;
  email?: string;
  accountId?: string;
  oauth: OAuthCred;
};

type LegacyStore = {
  version: 1;
  activeSlot?: LegacySlotName;
  slots: Partial<Record<LegacySlotName, LegacySlot>>;
};

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const AUTH_FILE = path.join(AGENT_DIR, "auth.json");
const STORE_FILE = path.join(AGENT_DIR, "codexswap.json");
const GLOBAL_PREFERRED_FILE = path.join(AGENT_DIR, "codex-swap.local.json");
const BACKUPS_DIR = path.join(os.homedir(), ".pi", "backups");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TIMEOUT_MS = 8000;

type CodexUsageWindow = {
  label: string;
  usedPercent: number;
  limitWindowSeconds?: number;
  resetAt?: number;
};

type CodexUsageSnapshot = {
  plan?: string;
  windows: CodexUsageWindow[];
  error?: string;
};

type PreferredConfig = {
  preferredProfile?: string;
};

type PreferredScope = "global" | "project";

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore chmod issues on some filesystems
  }
}

export function getOpenAICodexFromAuth(): OAuthCred | null {
  const auth = readJson<Record<string, unknown>>(AUTH_FILE);
  const entry = auth?.["openai-codex"] as OAuthCred | undefined;
  if (!entry || entry.type !== "oauth") return null;
  return entry;
}

function updateOpenAICodexInAuth(oauth: OAuthCred): void {
  const auth = readJson<Record<string, unknown>>(AUTH_FILE) ?? {};
  auth["openai-codex"] = oauth;
  writeJson(AUTH_FILE, auth);
}

function applyOpenAICodexOAuth(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  oauth: OAuthCred,
): void {
  const cred: OAuthCred = { ...oauth, type: "oauth" };
  updateOpenAICodexInAuth(cred);
  ctx.modelRegistry.authStorage.reload();
  pi.events.emit("codexswap:account-changed", undefined);
}

async function refreshAndGetActiveOAuth(
  ctx: ExtensionContext,
): Promise<OAuthCred | null> {
  const storage = ctx?.modelRegistry?.authStorage;
  if (storage) {
    try {
      if (typeof storage.getApiKey === "function") {
        await storage.getApiKey("openai-codex");
      }
    } catch {
      // Ignore refresh errors; we'll still attempt to read current credential.
    }

    try {
      if (typeof storage.get === "function") {
        const cred = storage.get("openai-codex") as OAuthCred | undefined;
        if (cred?.type === "oauth") return cred;
      }
    } catch {
      // ignore
    }
  }

  return getOpenAICodexFromAuth();
}

function formatWindowLabel(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "window";
  if (seconds >= 24 * 60 * 60) {
    const d = Math.round(seconds / (24 * 60 * 60));
    return `${d}d`;
  }
  const h = Math.round(seconds / (60 * 60));
  return `${h}h`;
}

function formatRemaining(resetAt?: number): string {
  if (!resetAt) return "";
  const diffMs = resetAt * 1000 - Date.now();
  if (diffMs <= 0) return " (resetting now)";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return ` (${mins}m left)`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return ` (${hrs}h${rem ? `${rem}m` : ""} left)`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  if (seconds >= 86_400) {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function formatResetClock(resetAtSeconds?: number): string {
  if (!resetAtSeconds) return "";
  const date = new Date(resetAtSeconds * 1000);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    .toLowerCase()
    .replace(/\s+/g, "");
  if (sameDay) return time;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function elapsedPercent(w: CodexUsageWindow): number {
  if (!w.resetAt || !w.limitWindowSeconds || w.limitWindowSeconds <= 0) {
    return w.usedPercent;
  }
  const remaining = Math.max(0, w.resetAt - Math.floor(Date.now() / 1000));
  return Math.max(
    0,
    Math.min(100, ((w.limitWindowSeconds - remaining) / w.limitWindowSeconds) * 100),
  );
}

function renderUsageBar(w: CodexUsageWindow, width = 18): string {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const elapsed = Math.max(0, Math.min(100, elapsedPercent(w)));
  const fillEnd = Math.round((pct / 100) * width);
  const cursor = Math.max(
    0,
    Math.min(width - 1, Math.round((elapsed / 100) * (width - 1))),
  );
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i === cursor) bar += "|";
    else bar += i < fillEnd ? "━" : "─";
  }
  return bar;
}

function usageStatusLines(snapshot: CodexUsageSnapshot): string[] {
  if (snapshot.error) return [`Live usage: ${snapshot.error}`];
  if (!snapshot.windows.length) return ["Live usage: no window data"];

  const header = `Live usage${snapshot.plan ? ` (${snapshot.plan})` : ""}:`;
  const lines = snapshot.windows.map((w) => {
    const remaining = w.resetAt
      ? Math.max(0, w.resetAt - Math.floor(Date.now() / 1000))
      : undefined;
    const reset = formatResetClock(w.resetAt);
    const timing =
      remaining !== undefined && reset
        ? ` · ${formatDuration(remaining)}→${reset}`
        : formatRemaining(w.resetAt);
    return `  ${w.label.padEnd(3)} ${renderUsageBar(w)} ${w.usedPercent}%${timing}`;
  });
  return [header, ...lines];
}

async function fetchCodexUsageSnapshot(
  oauth: OAuthCred,
  signal?: AbortSignal,
): Promise<CodexUsageSnapshot> {
  const token = oauth.access ?? oauth.key;
  if (!token) return { windows: [], error: "missing access token" };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "pi-codexswap",
  };

  const accountId =
    typeof oauth.accountId === "string"
      ? oauth.accountId
      : typeof oauth.account_id === "string"
        ? oauth.account_id
        : undefined;
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const res = await fetch(CODEX_USAGE_URL, { headers, signal: combined });

    if (!res.ok) {
      const msg =
        res.status === 401 || res.status === 403 ? "auth expired" : `HTTP ${res.status}`;
      return { windows: [], error: msg };
    }

    const json = (await res.json()) as {
      plan_type?: string;
      rate_limit?: {
        primary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_at?: number;
        } | null;
        secondary_window?: {
          used_percent?: number;
          limit_window_seconds?: number;
          reset_at?: number;
        } | null;
      };
    };

    const raw = [
      json.rate_limit?.primary_window,
      json.rate_limit?.secondary_window,
    ].filter(Boolean) as Array<{
      used_percent?: number;
      limit_window_seconds?: number;
      reset_at?: number;
    }>;

    const windows: CodexUsageWindow[] = raw.map((w) => ({
      label: formatWindowLabel(w.limit_window_seconds),
      usedPercent: Math.max(0, Math.min(100, Math.round(w.used_percent ?? 0))),
      limitWindowSeconds: w.limit_window_seconds,
      resetAt: w.reset_at,
    }));

    return { plan: json.plan_type, windows };
  } catch (err) {
    const msg = combined.aborted
      ? "timeout/aborted"
      : (err as Error)?.message ?? "network error";
    return { windows: [], error: msg };
  }
}

function usageSummary(snapshot: CodexUsageSnapshot): string {
  return usageStatusLines(snapshot).join("\n");
}

async function usageForProfiles(
  profiles: Profile[],
): Promise<Array<{ profile: Profile; usage: CodexUsageSnapshot }>> {
  return Promise.all(
    profiles.map(async (profile) => ({
      profile,
      usage: await fetchCodexUsageSnapshot(profile.oauth),
    })),
  );
}

function primaryUsage(snapshot: CodexUsageSnapshot): number | undefined {
  if (snapshot.error) return undefined;
  return snapshot.windows[0]?.usedPercent;
}

function secondaryUsage(snapshot: CodexUsageSnapshot): number | undefined {
  if (snapshot.error) return undefined;
  return snapshot.windows[1]?.usedPercent;
}

function profileUsageLine(
  profile: Profile,
  snapshot: CodexUsageSnapshot,
  index?: number,
): string {
  const prefix = index === undefined ? profile.label : `${index + 1}. ${profile.label}`;
  if (snapshot.error) return `${prefix} - ${shortWho(profile)} - usage: ${snapshot.error}`;
  if (!snapshot.windows.length) return `${prefix} - ${shortWho(profile)} - usage: no data`;
  const usage = snapshot.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" | ");
  return `${prefix} - ${shortWho(profile)} - ${usage}`;
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function inferEmail(oauth: OAuthCred): string | undefined {
  const payload = decodeJwtPayload(oauth.access);
  if (!payload) return undefined;
  const profile = payload["https://api.openai.com/profile"] as
    | Record<string, unknown>
    | undefined;
  const email = profile?.email ?? payload.email;
  return typeof email === "string" ? email : undefined;
}

function profileFromOauth(oauth: OAuthCred, label: string): Profile {
  return {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    label,
    savedAt: Date.now(),
    email: inferEmail(oauth),
    accountId: typeof oauth.accountId === "string" ? oauth.accountId : undefined,
    oauth,
  };
}

function sanitizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function ensureUniqueLabel(
  profiles: Profile[],
  preferred: string,
  excludeId?: string,
): string {
  const base = sanitizeLabel(preferred) || "profile";
  const taken = new Set(
    profiles.filter((p) => p.id !== excludeId).map((p) => p.label.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

function defaultLabelFor(oauth: OAuthCred, profiles: Profile[]): string {
  const email = inferEmail(oauth);
  const fromEmail = email?.split("@")[0]?.trim();
  if (fromEmail) return ensureUniqueLabel(profiles, fromEmail);
  const acct = typeof oauth.accountId === "string" ? oauth.accountId.slice(0, 8) : "profile";
  return ensureUniqueLabel(profiles, `codex-${acct}`);
}

function findByRefresh(profiles: Profile[], refresh?: string): Profile | undefined {
  if (!refresh) return undefined;
  return profiles.find((p) => p.oauth.refresh === refresh);
}

function latestCodexBackupOauth(): OAuthCred | null {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return null;
    const files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => /^openai-codex-oauth\..+\.json$/.test(f))
      .sort();
    const latestFile = files.at(-1);
    if (!latestFile) return null;
    const parsed = readJson<Record<string, OAuthCred>>(
      path.join(BACKUPS_DIR, latestFile),
    );
    const oauth = parsed?.["openai-codex"];
    if (!oauth || oauth.type !== "oauth") return null;
    return oauth;
  } catch {
    return null;
  }
}

function migrateLegacyStore(legacy: LegacyStore): StoreV2 {
  const profiles: Profile[] = [];
  const addLegacy = (name: LegacySlotName) => {
    const slot = legacy.slots?.[name];
    if (!slot?.oauth || slot.oauth.type !== "oauth") return;
    if (findByRefresh(profiles, slot.oauth.refresh)) return;
    profiles.push({
      id: `legacy_${name}`,
      label: sanitizeLabel(slot.label || name) || name,
      savedAt: slot.savedAt || Date.now(),
      email: slot.email,
      accountId: slot.accountId,
      oauth: slot.oauth,
    });
  };

  addLegacy("current");
  addLegacy("previous");

  let activeProfileId: string | undefined;
  if (legacy.activeSlot) {
    const found = profiles.find((p) => p.id === `legacy_${legacy.activeSlot}`);
    activeProfileId = found?.id;
  }

  return { version: 2, activeProfileId, profiles };
}

function loadStore(): StoreV2 {
  const raw = readJson<StoreV2 | LegacyStore | Record<string, unknown>>(STORE_FILE);

  if (raw && (raw as StoreV2).version === 2 && Array.isArray((raw as StoreV2).profiles)) {
    const s = raw as StoreV2;
    return {
      version: 2,
      activeProfileId: s.activeProfileId,
      lastProfileId: s.lastProfileId,
      profiles: s.profiles,
    };
  }

  if (raw && (raw as LegacyStore).version === 1 && (raw as LegacyStore).slots) {
    return migrateLegacyStore(raw as LegacyStore);
  }

  return { version: 2, profiles: [] };
}

function saveStore(store: StoreV2): void {
  writeJson(STORE_FILE, store);
}

function ensureBootstrapped(store: StoreV2): StoreV2 {
  const live = getOpenAICodexFromAuth();
  if (!live) return store;

  let liveProfile = findByRefresh(store.profiles, live.refresh);
  if (!liveProfile) {
    const label = defaultLabelFor(live, store.profiles);
    liveProfile = profileFromOauth(live, label);
    store.profiles.push(liveProfile);
  }

  if (!store.activeProfileId) {
    store.activeProfileId = liveProfile.id;
  }

  if (store.profiles.length < 2) {
    const backup = latestCodexBackupOauth();
    if (backup?.refresh && !findByRefresh(store.profiles, backup.refresh)) {
      const label = ensureUniqueLabel(
        store.profiles,
        inferEmail(backup)?.split("@")[0] || "backup",
      );
      store.profiles.push(profileFromOauth(backup, label));
    }
  }

  return store;
}

function getProjectPreferredFile(cwd: string): string {
  return path.join(cwd, ".pi", "codex-swap.local.json");
}

function readPreferredConfig(file: string): PreferredConfig | null {
  const config = readJson<PreferredConfig>(file);
  if (!config || typeof config !== "object") return null;
  return config;
}

function getPreferredConfig(cwd: string):
  | { scope: PreferredScope; path: string; preferredProfile: string }
  | undefined {
  const projectFile = getProjectPreferredFile(cwd);
  const project = readPreferredConfig(projectFile);
  if (typeof project?.preferredProfile === "string" && project.preferredProfile.trim()) {
    return {
      scope: "project",
      path: projectFile,
      preferredProfile: project.preferredProfile.trim(),
    };
  }

  const global = readPreferredConfig(GLOBAL_PREFERRED_FILE);
  if (typeof global?.preferredProfile === "string" && global.preferredProfile.trim()) {
    return {
      scope: "global",
      path: GLOBAL_PREFERRED_FILE,
      preferredProfile: global.preferredProfile.trim(),
    };
  }

  return undefined;
}

function setPreferredConfig(
  scope: PreferredScope,
  cwd: string,
  preferredProfile?: string,
): string {
  const file = scope === "project" ? getProjectPreferredFile(cwd) : GLOBAL_PREFERRED_FILE;
  const value = preferredProfile?.trim();
  if (!value) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return file;
  }
  writeJson(file, { preferredProfile: value });
  return file;
}

function resolveProfile(profiles: Profile[], selector: string): Profile | undefined {
  const target = selector.trim();
  if (!target) return undefined;

  const asNum = Number(target);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= profiles.length) {
    return profiles[asNum - 1];
  }

  const lower = target.toLowerCase();
  const exact = profiles.find(
    (p) => p.label.toLowerCase() === lower || p.id.toLowerCase() === lower,
  );
  if (exact) return exact;

  const fuzzy = profiles.filter(
    (p) =>
      p.label.toLowerCase().includes(lower) ||
      (p.email ?? "").toLowerCase().includes(lower),
  );
  if (fuzzy.length === 1) return fuzzy[0];

  return undefined;
}

function shortWho(profile: Profile): string {
  return profile.email ?? profile.accountId ?? "unknown-account";
}

function preferredProfileLabel(profile: Profile): string {
  return `${profile.label} - ${shortWho(profile)}`;
}

async function configurePreferredProfile(
  ctx: ExtensionContext,
  store: StoreV2,
  options?: { startup?: boolean },
): Promise<void> {
  if (store.profiles.length === 0) {
    ctx.ui.notify("No saved Codex profiles. Use /codexswap add first.", "warning");
    return;
  }

  const actionOptions = options?.startup
    ? ["Set project preferred account", "Set global preferred account", "Skip"]
    : [
        "Set project preferred account",
        "Set global preferred account",
        "Clear project preferred account",
        "Clear global preferred account",
        "Cancel",
      ];
  const action = await ctx.ui.select("Preferred Codex account", actionOptions);
  if (!action || action === "Skip" || action === "Cancel") return;

  if (action === "Clear project preferred account") {
    const file = setPreferredConfig("project", ctx.cwd);
    ctx.ui.notify(`Cleared project preferred Codex account: ${file}`, "info");
    return;
  }

  if (action === "Clear global preferred account") {
    const file = setPreferredConfig("global", ctx.cwd);
    ctx.ui.notify(`Cleared global preferred Codex account: ${file}`, "info");
    return;
  }

  const scope: PreferredScope = action.includes("project") ? "project" : "global";
  const current = getPreferredConfig(ctx.cwd)?.preferredProfile;
  const profileChoice = await ctx.ui.select(
    `Select ${scope} preferred Codex account`,
    store.profiles.map((profile) => {
      const selected = profile.label === current || profile.id === current ? " (current)" : "";
      return `${preferredProfileLabel(profile)}${selected}`;
    }),
  );
  if (!profileChoice) return;

  const selectedLabel = profileChoice.replace(/\s+\(current\)$/, "");
  const profile = store.profiles.find(
    (entry) => preferredProfileLabel(entry) === selectedLabel,
  );
  if (!profile) {
    ctx.ui.notify("Could not resolve selected Codex profile.", "error");
    return;
  }

  const file = setPreferredConfig(scope, ctx.cwd, profile.label);
  ctx.ui.notify(`Saved ${scope} preferred Codex account: ${profile.label}\n${file}`, "info");
}

function maybeApplyPreferredProfile(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  store: StoreV2,
): { applied: boolean; configured: boolean } {
  const configured = getPreferredConfig(ctx.cwd);
  if (!configured) return { applied: false, configured: false };

  const live = getOpenAICodexFromAuth();
  if (!live) return { applied: false, configured: true };

  const target = resolveProfile(store.profiles, configured.preferredProfile);
  if (!target) {
    ctx.ui.notify(
      `Preferred Codex account not found: ${configured.preferredProfile} (${configured.scope})`,
      "warning",
    );
    return { applied: false, configured: true };
  }

  const current = findByRefresh(store.profiles, live.refresh);
  store.activeProfileId = current?.id ?? store.activeProfileId;
  if (current?.id === target.id) {
    saveStore(store);
    return { applied: false, configured: true };
  }

  store.lastProfileId = current?.id;
  applyOpenAICodexOAuth(pi, ctx, target.oauth);
  store.activeProfileId = target.id;
  saveStore(store);
  ctx.ui.notify(
    `Applied ${configured.scope} preferred Codex account: ${target.label}`,
    "info",
  );
  return { applied: true, configured: true };
}

function helpText(): string {
  return [
    "Usage:",
    "  /codexswap                 Cycle to next saved Codex account",
    "  /codexswap back            Switch back to previous saved account",
    "  /codexswap status          Show current + saved accounts",
    "  /codexswap usage [all|sel]  Show live quota for active/all/one profile",
    "  /codexswap best            Switch to saved account with lowest primary usage",
    "  /codexswap low             Show profiles sorted by lowest live usage",
    "  /codexswap purge [dry-run] Purge saved profiles whose auth is expired",
    "  /codexswap who             Show live account from auth.json",
    "  /codexswap add [label]     Save currently logged-in account",
    "  /codexswap use <label|#>   Switch to a saved account",
    "  /codexswap rm <label|#>    Remove a saved account",
    "  /codexswap rename <sel> <new-label>",
    "  /codexpref                 Set preferred account (project/global)",
    "",
    "Flow to add a 3rd account:",
    "  1) /login openai-codex (sign into new account)",
    "  2) /codexswap add work3",
  ].join("\n");
}

export default function codexSwapExtension(pi: ExtensionAPI) {
  const showWho = (
    ctx: ExtensionCommandContext,
    live: OAuthCred,
    store: StoreV2,
  ) => {
    const match = findByRefresh(store.profiles, live.refresh);
    const email = inferEmail(live);
    const who =
      email || (typeof live.accountId === "string" ? live.accountId : "unknown-account");
    ctx.ui.notify(
      `Live openai-codex: ${who}${match ? `\nSaved profile: ${match.label}` : "\nSaved profile: (not yet saved)"}`,
      "info",
    );
  };

  const ensureIdleForAccountSwitch = (ctx: ExtensionCommandContext): boolean => {
    if (ctx.isIdle()) return true;
    ctx.ui.notify(
      "Cannot switch Codex accounts while the agent is working. Wait until it becomes idle.",
      "warning",
    );
    return false;
  };

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !ctx.hasUI) return;

    const live = getOpenAICodexFromAuth();
    if (!live) return;

    const store = ensureBootstrapped(loadStore());
    const preferred = maybeApplyPreferredProfile(pi, ctx, store);
    if (!preferred.configured && store.profiles.length >= 2) {
      await configurePreferredProfile(ctx, store, { startup: true });
    }
  });

  pi.registerCommand("codexwho", {
    description: "Show the currently active OpenAI Codex account",
    handler: async (_args, ctx) => {
      const live = getOpenAICodexFromAuth();
      if (!live) {
        ctx.ui.notify("No openai-codex OAuth found in auth.json.", "error");
        return;
      }
      const store = ensureBootstrapped(loadStore());
      saveStore(store);
      showWho(ctx, live, store);
    },
  });

  pi.registerCommand("codexpref", {
    description: "Set the preferred Codex account for project or global scope",
    handler: async (_args, ctx) => {
      const live = getOpenAICodexFromAuth();
      if (!live) {
        ctx.ui.notify("No openai-codex OAuth found in auth.json.", "error");
        return;
      }

      const store = ensureBootstrapped(loadStore());
      saveStore(store);
      await configurePreferredProfile(ctx, store);
    },
  });

  pi.registerCommand("codexswap", {
    description: "Manage/switch multiple OpenAI Codex OAuth accounts",
    handler: async (args, ctx) => {
      const live = getOpenAICodexFromAuth();
      if (!live) {
        ctx.ui.notify("No openai-codex OAuth found in auth.json.", "error");
        return;
      }

      const raw = (args ?? "").trim();
      const parts = raw.length ? raw.split(/\s+/) : [];
      const sub = (parts[0] ?? "").toLowerCase();
      const rest = raw.length ? raw.slice(parts[0]?.length ?? 0).trim() : "";

      const store = ensureBootstrapped(loadStore());
      const liveProfile = findByRefresh(store.profiles, live.refresh);
      if (liveProfile) store.activeProfileId = liveProfile.id;

      if (!sub || sub === "next" || sub === "toggle") {
        if (!ensureIdleForAccountSwitch(ctx)) return;
        if (store.profiles.length < 2) {
          saveStore(store);
          ctx.ui.notify(
            "Need at least 2 saved Codex accounts. Add another with /login openai-codex then /codexswap add <label>.",
            "warning",
          );
          return;
        }

        const firstProfile = store.profiles[0];
        if (!firstProfile) {
          ctx.ui.notify("No saved Codex profiles.", "warning");
          return;
        }

        const currentId = liveProfile?.id ?? store.activeProfileId ?? firstProfile.id;
        const idx = Math.max(0, store.profiles.findIndex((p) => p.id === currentId));
        const target = store.profiles[(idx + 1) % store.profiles.length];
        if (!target) {
          ctx.ui.notify("Could not resolve next Codex profile.", "error");
          return;
        }

        store.lastProfileId = currentId;
        applyOpenAICodexOAuth(pi, ctx, target.oauth);
        store.activeProfileId = target.id;
        saveStore(store);

        const activeOauth = await refreshAndGetActiveOAuth(ctx);
        const usage = activeOauth
          ? await fetchCodexUsageSnapshot(activeOauth)
          : { windows: [], error: "auth unavailable" };

        ctx.ui.notify(
          `Switched openai-codex → ${target.label} (${shortWho(target)}).\n${usageSummary(usage)}`,
          "info",
        );
        return;
      }

      if (sub === "back" || sub === "prev") {
        if (!ensureIdleForAccountSwitch(ctx)) return;
        const currentId = liveProfile?.id ?? store.activeProfileId;
        const target = store.lastProfileId
          ? store.profiles.find((p) => p.id === store.lastProfileId)
          : undefined;
        if (!target) {
          ctx.ui.notify("No previous Codex profile recorded yet.", "warning");
          return;
        }

        applyOpenAICodexOAuth(pi, ctx, target.oauth);
        store.activeProfileId = target.id;
        store.lastProfileId = currentId;
        saveStore(store);

        const activeOauth = await refreshAndGetActiveOAuth(ctx);
        const usage = activeOauth
          ? await fetchCodexUsageSnapshot(activeOauth)
          : { windows: [], error: "auth unavailable" };
        ctx.ui.notify(
          `Switched openai-codex back → ${target.label} (${shortWho(target)}).\n${usageSummary(usage)}`,
          "info",
        );
        return;
      }

      if (sub === "status" || sub === "list") {
        const activeOauth = await refreshAndGetActiveOAuth(ctx);
        const usage = activeOauth
          ? await fetchCodexUsageSnapshot(activeOauth)
          : { windows: [], error: "auth unavailable" };
        const usageByProfile = await usageForProfiles(store.profiles);
        const lines = store.profiles.map((p, i) => {
          const active = p.id === store.activeProfileId ? "*" : " ";
          const liveMark = p.oauth.refresh && p.oauth.refresh === live.refresh ? "(live)" : "";
          const profileUsage = usageByProfile.find((u) => u.profile.id === p.id)?.usage;
          const usageText = profileUsage
            ? profileUsage.error
              ? profileUsage.error
              : profileUsage.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" | ") ||
                "no data"
            : "usage unknown";
          return `${active} ${i + 1}. ${p.label} - ${shortWho(p)} - ${usageText} ${liveMark}`.trim();
        });
        saveStore(store);
        ctx.ui.notify(
          [
            `Profiles: ${store.profiles.length}`,
            `Active: ${store.profiles.find((p) => p.id === store.activeProfileId)?.label ?? "unknown"}`,
            `Previous: ${store.profiles.find((p) => p.id === store.lastProfileId)?.label ?? "none"}`,
            "",
            lines.length ? lines.join("\n") : "(none)",
            "",
            usageSummary(usage),
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "usage" || sub === "quota") {
        if (rest === "all" || rest === "*") {
          const all = await usageForProfiles(store.profiles);
          ctx.ui.notify(
            all.map(({ profile, usage }, i) => profileUsageLine(profile, usage, i)).join("\n"),
            "info",
          );
          return;
        }

        if (rest) {
          const target = resolveProfile(store.profiles, rest);
          if (!target) {
            ctx.ui.notify(`Profile not found: ${rest}`, "error");
            return;
          }
          const usage = await fetchCodexUsageSnapshot(target.oauth);
          ctx.ui.notify([profileUsageLine(target, usage), "", usageSummary(usage)].join("\n"), "info");
          return;
        }

        const activeOauth = await refreshAndGetActiveOAuth(ctx);
        const usage = activeOauth
          ? await fetchCodexUsageSnapshot(activeOauth)
          : { windows: [], error: "auth unavailable" };
        ctx.ui.notify(usageSummary(usage), "info");
        return;
      }

      if (sub === "best" || sub === "least-used") {
        if (!ensureIdleForAccountSwitch(ctx)) return;
        if (store.profiles.length === 0) {
          ctx.ui.notify("No saved Codex profiles.", "warning");
          return;
        }

        const all = await usageForProfiles(store.profiles);
        const usable = all
          .map((entry) => ({ ...entry, primary: primaryUsage(entry.usage) }))
          .filter(
            (entry): entry is {
              profile: Profile;
              usage: CodexUsageSnapshot;
              primary: number;
            } => typeof entry.primary === "number",
          )
          .sort((a, b) => a.primary - b.primary);

        const best = usable[0];
        if (!best) {
          ctx.ui.notify(
            `Could not compare usage:\n${all.map(({ profile, usage }, i) => profileUsageLine(profile, usage, i)).join("\n")}`,
            "error",
          );
          return;
        }

        const currentId = liveProfile?.id ?? store.activeProfileId;
        if (currentId && currentId !== best.profile.id) store.lastProfileId = currentId;
        applyOpenAICodexOAuth(pi, ctx, best.profile.oauth);
        store.activeProfileId = best.profile.id;
        saveStore(store);
        ctx.ui.notify(
          [
            `Switched openai-codex → ${best.profile.label} (${shortWho(best.profile)}) - lowest primary usage.`,
            usageSummary(best.usage),
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "low" || sub === "lowest" || sub === "sort") {
        if (store.profiles.length === 0) {
          ctx.ui.notify("No saved Codex profiles.", "warning");
          return;
        }

        const all = await usageForProfiles(store.profiles);
        const sorted = all
          .map((entry) => ({
            ...entry,
            primary: primaryUsage(entry.usage),
            secondary: secondaryUsage(entry.usage),
          }))
          .sort((a, b) => {
            const ap = a.primary ?? Number.POSITIVE_INFINITY;
            const bp = b.primary ?? Number.POSITIVE_INFINITY;
            if (ap !== bp) return ap - bp;
            const as = a.secondary ?? Number.POSITIVE_INFINITY;
            const bs = b.secondary ?? Number.POSITIVE_INFINITY;
            if (as !== bs) return as - bs;
            return a.profile.label.localeCompare(b.profile.label);
          });

        const lines = sorted.map(({ profile, usage, primary }, i) => {
          const marker = profile.id === store.activeProfileId ? "*" : " ";
          const rank = primary === undefined ? "--" : String(i + 1).padStart(2, " ");
          return `${marker} ${rank}. ${profileUsageLine(profile, usage)}`;
        });

        ctx.ui.notify(["Lowest live Codex usage:", ...lines].join("\n"), "info");
        return;
      }

      if (sub === "purge" || sub === "prune") {
        const dryRun =
          rest === "dry-run" ||
          rest === "dry" ||
          rest === "--dry-run" ||
          rest === "check";
        const all = await usageForProfiles(store.profiles);
        const expired = all
          .filter(({ usage }) => usage.error === "auth expired")
          .map(({ profile }) => profile);

        if (expired.length === 0) {
          ctx.ui.notify("No expired Codex profiles found.", "info");
          return;
        }

        const expiredIds = new Set(expired.map((p) => p.id));
        const lines = expired.map((p) => `- ${p.label} (${shortWho(p)})`);

        if (dryRun) {
          ctx.ui.notify([`Would purge ${expired.length} expired profile(s):`, ...lines].join("\n"), "info");
          return;
        }

        store.profiles = store.profiles.filter((p) => !expiredIds.has(p.id));
        if (store.activeProfileId && expiredIds.has(store.activeProfileId)) {
          const liveAfterPurge = findByRefresh(store.profiles, live.refresh);
          store.activeProfileId = liveAfterPurge?.id ?? store.profiles[0]?.id;
        }
        if (store.lastProfileId && expiredIds.has(store.lastProfileId)) {
          store.lastProfileId = undefined;
        }
        saveStore(store);

        ctx.ui.notify(
          [`Purged ${expired.length} expired profile(s):`, ...lines].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "who") {
        saveStore(store);
        showWho(ctx, live, store);
        return;
      }

      if (
        sub === "add" ||
        sub === "save" ||
        sub === "save-current" ||
        sub === "save-previous"
      ) {
        const forcedLabel =
          sub === "save-current" ? "current" : sub === "save-previous" ? "previous" : "";
        const desired = sanitizeLabel(forcedLabel || rest);

        const existing = findByRefresh(store.profiles, live.refresh);
        if (existing) {
          existing.oauth = live;
          existing.savedAt = Date.now();
          existing.email = inferEmail(live);
          existing.accountId = typeof live.accountId === "string" ? live.accountId : undefined;
          if (desired) {
            existing.label = ensureUniqueLabel(store.profiles, desired, existing.id);
          }
          store.activeProfileId = existing.id;
          saveStore(store);
          ctx.ui.notify(`Updated profile: ${existing.label} (${shortWho(existing)})`, "info");
          return;
        }

        const label = desired
          ? ensureUniqueLabel(store.profiles, desired)
          : defaultLabelFor(live, store.profiles);
        const profile = profileFromOauth(live, label);
        store.profiles.push(profile);
        store.activeProfileId = profile.id;
        saveStore(store);
        ctx.ui.notify(`Saved new profile: ${profile.label} (${shortWho(profile)})`, "info");
        return;
      }

      if (sub === "use" || sub === "current" || sub === "previous") {
        if (!ensureIdleForAccountSwitch(ctx)) return;
        const selector = sub === "current" || sub === "previous" ? sub : rest;
        const target = resolveProfile(store.profiles, selector);
        if (!target) {
          ctx.ui.notify(`Profile not found: ${selector || "(empty)"}`, "error");
          return;
        }

        applyOpenAICodexOAuth(pi, ctx, target.oauth);
        if (store.activeProfileId && store.activeProfileId !== target.id) {
          store.lastProfileId = store.activeProfileId;
        }
        store.activeProfileId = target.id;
        saveStore(store);

        const activeOauth = await refreshAndGetActiveOAuth(ctx);
        const usage = activeOauth
          ? await fetchCodexUsageSnapshot(activeOauth)
          : { windows: [], error: "auth unavailable" };
        ctx.ui.notify(
          `Switched openai-codex → ${target.label} (${shortWho(target)}).\n${usageSummary(usage)}`,
          "info",
        );
        return;
      }

      if (sub === "rm" || sub === "remove") {
        const target = resolveProfile(store.profiles, rest);
        if (!target) {
          ctx.ui.notify(`Profile not found: ${rest || "(empty)"}`, "error");
          return;
        }

        store.profiles = store.profiles.filter((p) => p.id !== target.id);
        if (store.activeProfileId === target.id) {
          store.activeProfileId = store.profiles[0]?.id;
        }
        if (store.lastProfileId === target.id) {
          store.lastProfileId = undefined;
        }
        saveStore(store);
        ctx.ui.notify(`Removed profile: ${target.label}`, "info");
        return;
      }

      if (sub === "rename") {
        const [selector, ...labelParts] = rest.split(/\s+/);
        const newLabelRaw = labelParts.join(" ").trim();
        if (!selector || !newLabelRaw) {
          ctx.ui.notify("Usage: /codexswap rename <label|#> <new-label>", "error");
          return;
        }

        const target = resolveProfile(store.profiles, selector);
        if (!target) {
          ctx.ui.notify(`Profile not found: ${selector}`, "error");
          return;
        }

        target.label = ensureUniqueLabel(store.profiles, newLabelRaw, target.id);
        saveStore(store);
        ctx.ui.notify(`Renamed profile to: ${target.label}`, "info");
        return;
      }

      ctx.ui.notify(helpText(), "info");
    },
  });
}
