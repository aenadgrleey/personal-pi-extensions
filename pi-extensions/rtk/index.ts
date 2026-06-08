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

const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "supi", "config.json");
const PROJECT_CONFIG_FILE = join(".pi", "supi", "config.json");
const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"];

const BIOME_RE = /biome(?:\s|$)/;
const FIND_RE = /^find(?=\s|$)/;
const GIT_RE = /^git(?=\s|$)/;
const RG_RE = /^rg(?=\s|$)/;
const PACKAGE_LINT_RE = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/;

type RtkConfig = typeof RTK_DEFAULTS;

type ExecCommandInput = {
	cmd?: unknown;
	command?: unknown;
	workdir?: unknown;
};

type RewriteResult =
	| { kind: "rewritten" | "unchanged"; command: string }
	| { kind: "failed"; reason: "timeout" | "unavailable" | "empty-output" | "error" };

type RtkResolution =
	| { kind: "rewritten"; command: string }
	| { kind: "unchanged" }
	| { kind: "passthrough"; reason: "disabled" | "bypass" | "unavailable" | "failed" };

let rtkAvailable: boolean | undefined;
let warnedAboutUnavailableRtk = false;

function readJsonFile(path: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
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
		...(typeof globalSection === "object" && globalSection !== null ? globalSection : undefined),
		...(typeof projectSection === "object" && projectSection !== null ? projectSection : undefined),
	};
}

function resolveCommandCwd(ctx: ExtensionContext, input: ExecCommandInput): string {
	return typeof input.workdir === "string" ? resolve(ctx.cwd, input.workdir) : ctx.cwd;
}

function stripShellWrappers(command: string): string {
	let normalized = command.trimStart();
	while (/^cd\s+\S+(?:\s*[;&]\s*|\s+&&\s+)/.test(normalized)) {
		normalized = normalized.replace(/^cd\s+\S+(?:\s*[;&]\s*|\s+&&\s+)/, "");
	}
	return normalized.trimStart();
}

function hasRtkDisabledPrefix(command: string): boolean {
	return command.startsWith("RTK_DISABLED=1 ") || command.startsWith("env RTK_DISABLED=1 ");
}

function projectUsesBiome(cwd: string): boolean {
	if (BIOME_CONFIG_FILES.some((file) => existsSync(join(cwd, file)))) return true;

	try {
		const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		return Object.values(packageJson.scripts ?? {}).some(
			(script) => typeof script === "string" && /(^|\s)biome(\s|$)/.test(script),
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
		return { kind: rewritten === command ? "unchanged" : "rewritten", command: rewritten };
	} catch (error) {
		const err = error as { code?: string; stdout?: string | Buffer; message?: string };
		const stdout = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString("utf8");
		const rewritten = stdout?.trim();
		if (rewritten) {
			return { kind: rewritten === command ? "unchanged" : "rewritten", command: rewritten };
		}

		const message = err.message?.toLowerCase() ?? "";
		if (err.code === "ENOENT") return { kind: "failed", reason: "unavailable" };
		if (err.code === "ETIMEDOUT" || message.includes("timeout") || message.includes("timed out")) {
			return { kind: "failed", reason: "timeout" };
		}
		return { kind: "failed", reason: "error" };
	}
}

function resolveRtkCommand(command: string, cwd: string, ctx?: ExtensionContext): RtkResolution {
	const config = loadRtkConfig(cwd);
	if (!config.enabled) return { kind: "passthrough", reason: "disabled" };
	if (shouldBypassRtkRewrite(command, cwd)) return { kind: "passthrough", reason: "bypass" };
	if (!isRtkAvailable()) {
		notifyUnavailableRtkOnce(ctx);
		return { kind: "passthrough", reason: "unavailable" };
	}

	const result = rewriteWithRtk(command, config.rewriteTimeout);
	if (result.kind === "rewritten") return { kind: "rewritten", command: result.command };
	if (result.kind === "unchanged") return { kind: "unchanged" };
	return { kind: "passthrough", reason: "failed" };
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
			const prefixWithNewline = commandPrefix ? `${commandPrefix}\n` : undefined;
			const bashTool = createBashTool(cwd, {
				shellPath: settings.getShellPath(),
				spawnHook: ({ command, cwd: spawnCwd, env }) => {
					let userCommand = command;
					if (prefixWithNewline && command.startsWith(prefixWithNewline)) {
						userCommand = command.slice(prefixWithNewline.length);
					}
					const resolution = resolveRtkCommand(userCommand, spawnCwd, ctx);
					const finalCommand =
						resolution.kind === "rewritten"
							? prefixWithNewline
								? `${prefixWithNewline}${resolution.command}`
								: resolution.command
							: command;
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
		const local = createLocalBashOperations({ shellPath: settings.getShellPath() });
		return {
			operations: {
				exec: (_command, cwd, options) => local.exec(resolution.command, cwd, options),
			},
		};
	});

	// Codex `exec_command` (provided by pi-codex-conversion): mutate the
	// command in-place when the model reaches for it, so RTK also applies to
	// codex sessions that bypass the standard bash tool.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "exec_command") return;

		const input = event.input as ExecCommandInput;
		const command =
			typeof input.cmd === "string"
				? input.cmd
				: typeof input.command === "string"
					? input.command
					: undefined;
		if (!command) return;

		const commandCwd = resolveCommandCwd(ctx, input);
		const resolution = resolveRtkCommand(command, commandCwd, ctx);
		if (resolution.kind !== "rewritten") return;

		if (typeof input.cmd === "string") input.cmd = resolution.command;
		if (typeof input.command === "string") input.command = resolution.command;
	});
}
