// pi-extensions/rtk — self-contained mirror of @mrclrchtr/supi-rtk for this repo.
// Architecture mirrors the upstream package (bash-tool spawnHook + user_bash hook
// + config loading from ~/.pi/agent/supi/config.json and .pi/supi/config.json), and
// the actual rewriting is delegated to the canonical `rtk rewrite <cmd>` CLI rather
// than a hand-maintained mapping table. The codex-swap adapter's `exec_command` tool
// is intercepted in addition to the standard bash tool so that RTK applies to both
// codex and non-codex sessions.
//
// Guards (a superset of the upstream package — adding `find` and `git` to the
// bypass set because `rtk rewrite` is lossy for those commands in 0.37.x):
//   - `RTK_DISABLED=1` or `env RTK_DISABLED=1` env-var prefix
//   - already-prefixed `rtk …` commands (avoid double rewriting)
//   - `biome` (upstream #665, #1489 — `rtk lint` collapses the biome subcommand)
//   - `rg` (upstream #1367, #1604 — ripgrep-specific flags not translated)
//   - `find` and `find -exec` (rtk rewrite is lossy for find predicates)
//   - `git` (rtk rewrite can misroute git plumbing)
//   - package-manager `lint` scripts in projects that use Biome
//   - leading `cd /path && command` shell wrappers (so ^-anchored regexes match)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createBashTool,
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const RTK_DEFAULTS = {
  enabled: true,
  rewriteTimeout: 5000,
};

const GLOBAL_CONFIG_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "supi",
  "config.json",
);
const PROJECT_CONFIG_FILE = join(".pi", "supi", "config.json");
const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"];

const BIOME_RE = /biome(?:\s|$)/;
const FIND_RE = /^find(?=\s|$)/;
const GIT_RE = /^git(?=\s|$)/;
const RG_RE = /^rg(?=\s|$)/;
const PACKAGE_LINT_RE = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/;

type RtkConfig = typeof RTK_DEFAULTS;

type RewriteResult =
  | { kind: "rewritten" | "unchanged"; command: string }
  | {
      kind: "failed";
      reason: "timeout" | "unavailable" | "empty-output" | "error";
    };

type RtkResolution =
  | { kind: "rewritten"; command: string }
  | { kind: "unchanged" }
  | {
      kind: "passthrough";
      reason: "disabled" | "bypass" | "unavailable" | "failed";
    };

let rtkAvailable: boolean | undefined;
let warnedAboutUnavailableRtk = false;

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function loadRtkConfig(cwd: string): RtkConfig {
  const globalSection = readJsonFile(GLOBAL_CONFIG_FILE)?.rtk;
  const projectSection = readJsonFile(join(cwd, PROJECT_CONFIG_FILE))?.rtk;
  return {
    ...RTK_DEFAULTS,
    ...(typeof globalSection === "object" && globalSection !== null
      ? globalSection
      : undefined),
    ...(typeof projectSection === "object" && projectSection !== null
      ? projectSection
      : undefined),
  };
}

function stripShellWrappers(command: string): string {
  let normalized = command.trimStart();
  while (/^cd\s+\S+(?:\s*[;&]\s*|\s+&&\s+)/.test(normalized)) {
    normalized = normalized.replace(/^cd\s+\S+(?:\s*[;&]\s*|\s+&&\s+)/, "");
  }
  return normalized.trimStart();
}

function hasRtkDisabledPrefix(command: string): boolean {
  return (
    command.startsWith("RTK_DISABLED=1 ") ||
    command.startsWith("env RTK_DISABLED=1 ")
  );
}

function projectUsesBiome(cwd: string): boolean {
  if (BIOME_CONFIG_FILES.some((file) => existsSync(join(cwd, file))))
    return true;

  try {
    const packageJson = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, unknown>;
    };
    return Object.values(packageJson.scripts ?? {}).some(
      (script) =>
        typeof script === "string" && /(^|\s)biome(\s|$)/.test(script),
    );
  } catch {
    return false;
  }
}

export function shouldBypassRtkRewrite(command: string, cwd: string): boolean {
  const normalized = stripShellWrappers(command);
  if (hasRtkDisabledPrefix(normalized)) return true;
  if (normalized.startsWith("rtk ")) return true;
  if (BIOME_RE.test(normalized)) return true;
  if (FIND_RE.test(normalized)) return true;
  if (GIT_RE.test(normalized)) return true;
  if (RG_RE.test(normalized)) return true;
  if (PACKAGE_LINT_RE.test(normalized) && projectUsesBiome(cwd)) return true;
  return false;
}

function isRtkAvailable(): boolean {
  if (rtkAvailable !== undefined) return rtkAvailable;
  try {
    execFileSync("rtk", ["--version"], { encoding: "utf8", timeout: 5000 });
    rtkAvailable = true;
  } catch {
    rtkAvailable = false;
  }
  return rtkAvailable;
}

function notifyUnavailableRtkOnce(ctx: ExtensionContext): void {
  if (!ctx.hasUI || warnedAboutUnavailableRtk) return;
  warnedAboutUnavailableRtk = true;
  ctx.ui.notify(
    "RTK is enabled, but the rtk binary is not available on PATH. Falling back to normal bash execution.",
    "warning",
  );
}

function rewriteWithRtk(command: string, timeoutMs: number): RewriteResult {
  try {
    const stdout = execFileSync("rtk", ["rewrite", command], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    const rewritten = stdout.trim();
    if (!rewritten) return { kind: "failed", reason: "empty-output" };
    return {
      kind: rewritten === command ? "unchanged" : "rewritten",
      command: rewritten,
    };
  } catch (error) {
    const err = error as {
      code?: string;
      stdout?: string | Buffer;
      message?: string;
    };
    const stdout =
      typeof err.stdout === "string"
        ? err.stdout
        : err.stdout?.toString("utf8");
    const rewritten = stdout?.trim();
    if (rewritten) {
      return {
        kind: rewritten === command ? "unchanged" : "rewritten",
        command: rewritten,
      };
    }

    const message = err.message?.toLowerCase() ?? "";
    if (err.code === "ENOENT") return { kind: "failed", reason: "unavailable" };
    if (
      err.code === "ETIMEDOUT" ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return { kind: "failed", reason: "timeout" };
    }
    return { kind: "failed", reason: "error" };
  }
}

function resolveRtkCommand(
  command: string,
  cwd: string,
  ctx?: ExtensionContext,
): RtkResolution {
  const config = loadRtkConfig(cwd);
  if (!config.enabled) return { kind: "passthrough", reason: "disabled" };
  if (shouldBypassRtkRewrite(command, cwd))
    return { kind: "passthrough", reason: "bypass" };
  if (!isRtkAvailable()) {
    notifyUnavailableRtkOnce(ctx);
    return { kind: "passthrough", reason: "unavailable" };
  }

  const result = rewriteWithRtk(command, config.rewriteTimeout);
  if (result.kind === "rewritten")
    return { kind: "rewritten", command: result.command };
  if (result.kind === "unchanged") return { kind: "unchanged" };
  return { kind: "passthrough", reason: "failed" };
}

// ---------------------------------------------------------------------------
// Tool-field interception
// ---------------------------------------------------------------------------
//
// The same field-rewrite table drives both the built-in `bash` tool
// spawnHook and the codex-adapter `tool_call` bridge. That keeps the shell
// command rewrite rules in one place, while allowing tool-specific field
// names (`command`, `cmd`, `chars`) and cwd resolution.
//
// Add new tool entries here as the adapter package grows.

type ToolFieldConfig = {
  fields: readonly string[];
  resolveCwd: (
    input: Record<string, unknown>,
    baseCwd: string,
    ctx: ExtensionContext,
  ) => string;
};

const TOOL_FIELDS: Readonly<Record<string, ToolFieldConfig>> = {
  bash: {
    fields: ["command"],
    resolveCwd: (_input, baseCwd) => baseCwd,
  },
  exec_command: {
    // The codex adapter accepts `cmd` (canonical) and `command` (alias).
    fields: ["cmd", "command"],
    resolveCwd: (input, baseCwd) =>
      typeof input.workdir === "string"
        ? resolve(baseCwd, input.workdir)
        : baseCwd,
  },
  write_stdin: {
    // Bytes to send to a running exec session. For a shell session this is
    // shell input and RTK should compress the output; for a non-shell REPL
    // the rewrite will fall through unchanged.
    fields: ["chars"],
    resolveCwd: (_input, baseCwd) => baseCwd,
  },
};

/** A pure rewrite function: command in, resolution out. Injected for tests. */
export type ToolRewrite = (
  command: string,
  cwd: string,
  ctx: ExtensionContext,
) => RtkResolution;

/**
 * Apply RTK rewriting to the known shell-command fields of a codex-adapter
 * tool's input. Mutates the input in place; returns the same reference.
 *
 * The built-in `bash` tool is intentionally NOT handled here — it has its own
 * spawnHook-based pipeline. Tools not registered in `TOOL_FIELDS` are left
 * untouched.
 */
export function rewriteToolInput(
  toolName: keyof typeof TOOL_FIELDS,
  input: Record<string, unknown>,
  baseCwd: string,
  ctx: ExtensionContext,
  rewrite: ToolRewrite = resolveRtkCommand,
): Record<string, unknown> {
  const config = TOOL_FIELDS[toolName];
  if (!config) return input;

  const cwd = config.resolveCwd(input, baseCwd, ctx);
  for (const field of config.fields) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const resolution = rewrite(value, cwd, ctx);
    if (resolution.kind === "rewritten") {
      input[field] = resolution.command;
    }
  }
  return input;
}

export default function rtkExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    rtkAvailable = undefined;
    warnedAboutUnavailableRtk = false;
  });

  // Built-in `bash` tool: replace it with an RTK-aware variant whose spawnHook
  // resolves the command through `rtk rewrite` before the underlying shell runs.
  // Mirrors the supi-rtk package's bash-tool integration.
  const baseBashTool = createBashTool(process.cwd());
  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const settings = SettingsManager.create(cwd);
      const commandPrefix = settings.getShellCommandPrefix();
      const prefixWithNewline = commandPrefix
        ? `${commandPrefix}\n`
        : undefined;
      const bashTool = createBashTool(cwd, {
        shellPath: settings.getShellPath(),
        spawnHook: ({ command, cwd: spawnCwd, env }) => {
          const shellInput =
            prefixWithNewline && command.startsWith(prefixWithNewline)
              ? command.slice(prefixWithNewline.length)
              : command;
          const rewritten = rewriteToolInput(
            "bash",
            { command: shellInput },
            spawnCwd,
            ctx,
            resolveRtkCommand,
          );
          const rewrittenCommand =
            typeof rewritten.command === "string"
              ? rewritten.command
              : shellInput;
          const finalCommand = prefixWithNewline
            ? `${prefixWithNewline}${rewrittenCommand}`
            : rewrittenCommand;
          return {
            command: finalCommand,
            cwd: spawnCwd,
            env,
          };
        },
      });
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // `user_bash` event: when the user runs a bash command from the prompt
  // (e.g. `!ls` or `!!ls`), rewrite it through RTK for consistency. Mirrors
  // supi-rtk's user_bash integration.
  pi.on("user_bash", (event, ctx) => {
    if (event.excludeFromContext) return;
    const resolution = resolveRtkCommand(event.command, event.cwd, ctx);
    if (resolution.kind !== "rewritten") return;
    const settings = SettingsManager.create(event.cwd);
    const local = createLocalBashOperations({
      shellPath: settings.getShellPath(),
    });
    return {
      operations: {
        exec: (_command, cwd, options) =>
          local.exec(resolution.command, cwd, options),
      },
    };
  });

  // Codex-adapter tools (provided by pi-codex-conversion): mutate the
  // known shell-command fields in-place so RTK applies to codex sessions
  // that bypass the standard bash tool. The dispatch table lives in
  // `TOOL_FIELDS`; new tools only need a config entry.
  pi.on("tool_call", (event, ctx) => {
    if (!(event.toolName in TOOL_FIELDS)) return;
    rewriteToolInput(
      event.toolName,
      event.input as Record<string, unknown>,
      ctx.cwd,
      ctx,
      resolveRtkCommand,
    );
  });
}
