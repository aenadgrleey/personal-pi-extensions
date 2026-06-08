import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RTK_DEFAULTS = {
	enabled: true,
	rewriteTimeout: 5000,
};

const GLOBAL_CONFIG_FILE = join(homedir(), ".pi", "agent", "supi", "config.json");
const PROJECT_CONFIG_FILE = join(".pi", "supi", "config.json");
const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"];

const BIOME_RE = /biome(?:\s|$)/;
const FIND_RE = /^find(?:\s|$)/;
const GIT_RE = /^git(?:\s|$)/;
const RG_RE = /^rg(?:\s|$)/;
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

function shouldBypassRtkRewrite(command: string, cwd: string): boolean {
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
		"RTK is enabled for Codex exec_command, but the rtk binary is not available on PATH. Falling back to normal exec_command execution.",
		"warning",
	);
}

function rewriteWithRtk(command: string, timeoutMs: number): RewriteResult {
	try {
		const stdout = execFileSync("rtk", ["rewrite", command], { encoding: "utf8", timeout: timeoutMs });
		const rewritten = stdout.trim();
		if (!rewritten) return { kind: "failed", reason: "empty-output" };
		return { kind: rewritten === command ? "unchanged" : "rewritten", command: rewritten };
	} catch (error) {
		const err = error as { code?: string; stdout?: string | Buffer; message?: string };
		const stdout = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString("utf8");
		const rewritten = stdout?.trim();
		if (rewritten) return { kind: rewritten === command ? "unchanged" : "rewritten", command: rewritten };

		const message = err.message?.toLowerCase() ?? "";
		if (err.code === "ENOENT") return { kind: "failed", reason: "unavailable" };
		if (err.code === "ETIMEDOUT" || message.includes("timeout") || message.includes("timed out")) {
			return { kind: "failed", reason: "timeout" };
		}
		return { kind: "failed", reason: "error" };
	}
}

function resolveCommandCwd(ctx: ExtensionContext, input: ExecCommandInput): string {
	return typeof input.workdir === "string" ? resolve(ctx.cwd, input.workdir) : ctx.cwd;
}

export default function rtkCodexExtension(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		rtkAvailable = undefined;
		warnedAboutUnavailableRtk = false;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "exec_command") return;

		const input = event.input as ExecCommandInput;
		const command = typeof input.cmd === "string" ? input.cmd : typeof input.command === "string" ? input.command : undefined;
		if (!command) return;

		const commandCwd = resolveCommandCwd(ctx, input);
		const config = loadRtkConfig(commandCwd);
		if (!config.enabled || shouldBypassRtkRewrite(command, commandCwd)) return;

		if (!isRtkAvailable()) {
			notifyUnavailableRtkOnce(ctx);
			return;
		}

		const result = rewriteWithRtk(command, config.rewriteTimeout);
		if (result.kind !== "rewritten") return;

		if (typeof input.cmd === "string") {
			input.cmd = result.command;
		}
		if (typeof input.command === "string") {
			input.command = result.command;
		}
	});
}
