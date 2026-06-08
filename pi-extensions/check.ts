/**
 * Check Extension — runs checks declared in `checks.yaml` or `.pi/checks.yaml`
 *
 * - Reads check definitions from `checks.yaml` (preferred) or `.pi/checks.yaml` (compatibility) at runtime.
 * - On `agent_end`: runs checks after file changes; stays quiet on success.
 *   On failure, sends a custom message and triggers the agent to fix issues.
 * - `check` tool and `/check` command: run the checks declared in `checks.yaml` or `.pi/checks.yaml`.
 * - Custom messages render with tool-call-like visual appearance.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "./deps.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

// ── Types ────────────────────────────────────────────────────────────────

interface CheckDef {
	name: string;
	command: string;
	description?: string;
}

interface ChecksFile {
	checks: CheckDef[];
}

interface LoadedChecks {
	location: string;
	checks: CheckDef[];
}

interface CheckResult {
	tool: string;
	command: string;
	description?: string;
	passed: boolean;
	errors: number;
	warnings: number;
	output: string;
}

interface CheckDetails {
	source: string;
	summary: string;
	results: CheckResult[];
}

// ── YAML loader ──────────────────────────────────────────────────────────

function parseChecksFile(path: string): CheckDef[] {
	const raw = readFileSync(path, "utf-8");
	const file = yaml.load(raw) as ChecksFile;
	if (!file?.checks || !Array.isArray(file.checks)) return [];
	return file.checks;
}

function loadChecks(cwd: string): LoadedChecks | undefined {
	const candidates = [
		{ location: "checks.yaml", path: join(cwd, "checks.yaml") },
		{ location: ".pi/checks.yaml", path: join(cwd, ".pi", "checks.yaml") },
	];

	for (const candidate of candidates) {
		try {
			const checks = parseChecksFile(candidate.path);
			if (checks.length > 0) return { location: candidate.location, checks };
		} catch {
			// Try the next compatible location.
		}
	}

	return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function runCheck(
	exec: ExtensionAPI["exec"],
	check: CheckDef,
): Promise<CheckResult> {
	try {
		// Run the configured command through a shell so checks.yaml supports
		// normal shell syntax such as globs, environment assignments, and pipes.
		const result = await exec("bash", ["-lc", check.command], { timeout: 30_000 });
		const output = (result.stdout + result.stderr).trim();
		const passed = result.code === 0;

		let errors = 0;
		let warnings = 0;

		// Parse tsc error count
		if (/\btsc\b/.test(check.command)) {
			const lines = output.split("\n").filter((l) => l.includes("error TS"));
			errors = lines.length;
		} else if (output.includes("problems")) {
			// eslint / biome format: "X errors, Y warnings"
			const match = output.match(/(\d+) errors?,\s*(\d+) warnings?/);
			if (match) {
				errors = Number.parseInt(match[1] ?? "0", 10);
				warnings = Number.parseInt(match[2] ?? "0", 10);
			}
		}

		return {
			tool: check.name,
			command: check.command,
			description: check.description,
			passed,
			errors,
			warnings,
			output,
		};
	} catch (err) {
		return {
			tool: check.name,
			command: check.command,
			description: check.description,
			passed: false,
			errors: 1,
			warnings: 0,
			output: err instanceof Error ? err.message : String(err),
		};
	}
}

async function runChecks(
	exec: ExtensionAPI["exec"],
	cwd: string,
): Promise<{ source: string; results: CheckResult[] } | undefined> {
	const loaded = loadChecks(cwd);
	if (!loaded) return undefined;
	return {
		source: loaded.location,
		results: await Promise.all(loaded.checks.map((c) => runCheck(exec, c))),
	};
}

function formatSummary(results: CheckResult[]): string {
	const allPassed = results.every((r) => r.passed);
	if (allPassed) return "✓ all checks pass";

	return results
		.map((r) => {
			const icon = r.passed ? "✓" : "✗";
			const parts = [`${icon} ${r.tool}`];
			if (r.errors > 0) parts.push(`${r.errors} err`);
			if (r.warnings > 0) parts.push(`${r.warnings} warn`);
			return parts.join(" ");
		})
		.join(" | ");
}

function buildErrorText(results: CheckResult[]): string {
	return results
		.filter((r) => !r.passed)
		.map((r) => `[${r.tool}] ${r.command}\n${r.output.split("\n").slice(0, 20).join("\n")}`)
		.join("\n\n");
}

function formatChecksRun(source: string, results: CheckResult[]): string {
	const lines = [`Checks from ${source}:`];
	for (const result of results) {
		const description = result.description ? ` — ${result.description}` : "";
		lines.push(`- ${result.tool}: ${result.command}${description}`);
	}
	return lines.join("\n");
}

function buildCheckMessage(source: string, results: CheckResult[]): { content: string; details: CheckDetails } {
	const summary = formatSummary(results);
	const allPassed = results.every((r) => r.passed);
	const checksRun = formatChecksRun(source, results);
	return {
		content: allPassed
			? `${checksRun}\n\nAll checks pass.`
			: `${checksRun}\n\nCheck failed. Fix these issues:\n\n${buildErrorText(results)}`,
		details: { source, summary, results },
	};
}

function checksPassed(details: CheckDetails | undefined): boolean {
	return details?.results.every((r) => r.passed) ?? false;
}

function normalizeCommand(command: string): string {
	let normalized = command.trim().replace(/\s+/g, " ");
	normalized = normalized.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
	normalized = normalized.replace(/ -v$/, "");
	return normalized;
}

function isKnownCheckCommand(cwd: string, command: string): boolean {
	const normalized = normalizeCommand(command);
	const packageCheckCommands = new Set([
		"bun run check",
		"npm run check",
		"pnpm run check",
		"pnpm check",
		"yarn check",
		"yarn run check",
	]);
	if (packageCheckCommands.has(normalized)) return true;

	const loaded = loadChecks(cwd);
	if (!loaded) return false;
	return loaded.checks.some((check) => normalizeCommand(check.command) === normalized);
}

const CheckParams = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let running = false;
	let hadFileChanges = false;

	// Track whether any file-mutating tools were called during agent work
	const mutatingTools = new Set(["write", "edit"]);

	pi.on("tool_call", (event) => {
		if (mutatingTools.has(event.toolName)) {
			hadFileChanges = true;
		}
		if (event.toolName === "bash" && event.input?.command) {
			hadFileChanges = true;
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash" || event.isError) return;
		const command = typeof event.input?.command === "string" ? event.input.command : undefined;
		if (command && isKnownCheckCommand(ctx.cwd, command)) {
			hadFileChanges = false;
		}
	});

	pi.on("agent_start", () => {
		hadFileChanges = false;
	});

	// Renderer for "running" state
	pi.registerMessageRenderer("check-running", (message, _options, theme) => {
		if (!message.details) return undefined;
		const tools = (message.details as string[]).join(", ");
		return new Text(
			`${theme.fg("toolTitle", "⏳")} ${theme.fg("dim", `running ${tools}…`)}`,
			0,
			0,
		);
	});

	// Renderer for results
	pi.registerMessageRenderer<CheckDetails>("check-result", (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;

		const allPassed = details.results.every((r) => r.passed);
		const icon = allPassed ? theme.fg("success", "✓") : theme.fg("error", "✗");

		if (allPassed) {
			return new Text(`${icon} ${theme.fg("success", "all checks pass")}`, 0, 0);
		}

		const lines = [icon];
		for (const r of details.results) {
			const rIcon = r.passed ? theme.fg("success", "  ✓") : theme.fg("error", "  ✗");
			const parts = [`${rIcon} ${r.tool}`];
			if (r.errors > 0) parts.push(`${r.errors} err`);
			if (r.warnings > 0) parts.push(`${r.warnings} warn`);
			lines.push(parts.join(" "));
		}

		for (const r of details.results) {
			if (!r.passed && r.output) {
				lines.push("");
				lines.push(theme.fg("dim", `  [${r.tool}]`));
				const errorLines = r.output.split("\n").slice(0, 10);
				for (const line of errorLines) {
					lines.push(theme.fg("dim", `  ${line}`));
				}
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	});

	async function runChecksForOutput(cwd: string): Promise<{
		content: [{ type: "text"; text: string }];
		details: CheckDetails | undefined;
	}> {
		const run = await runChecks(pi.exec, cwd);
		if (!run) {
			return {
				content: [{ type: "text" as const, text: "No checks found in checks.yaml or .pi/checks.yaml" }],
				details: undefined,
			};
		}

		const result = buildCheckMessage(run.source, run.results);
		return {
			content: [{ type: "text" as const, text: result.content }],
			details: result.details,
		};
	}

	// Send check result as a custom message
	function sendCheckMessage(result: { content: [{ type: "text"; text: string }]; details: CheckDetails | undefined }) {
		const allPassed = checksPassed(result.details);

		pi.sendMessage<CheckDetails>(
			{
				customType: "check-result",
				content: result.content[0]?.text ?? "",
				display: true,
				details: result.details,
			},
			{
				triggerTurn: result.details ? !allPassed : false,
				deliverAs: "followUp",
			},
		);
	}

	// Send a "running" message before checks start
	function sendRunningMessage(cwd: string) {
		const loaded = loadChecks(cwd);
		const names = loaded?.checks.map((c) => `${c.name}: ${c.command}`) ?? [];
		pi.sendMessage({
			customType: "check-running",
			content: "Running checks…",
			display: true,
			details: names,
		});
	}

	pi.registerTool({
		name: "check",
		label: "check",
		description:
			"Run and report the checks declared in checks.yaml or .pi/checks.yaml. " +
			"The result lists the source file and exact commands before showing pass/fail output. " +
			"Use this when you want an explicit verification run during the task or after fixing issues. " +
			"Do not run it just for end-of-task handoff: if files changed, it runs automatically after agent_end and returns on failure.",
		promptSnippet: "Run project checks from checks.yaml or .pi/checks.yaml when you need an explicit verification run",
		promptGuidelines: [
			"Use check when you want to verify the current work during the task or after fixing issues.",
			"The check result shows the loaded checks file and exact commands that ran; no separate shell command is needed just to inspect them.",
			"Do not run check just for end-of-task handoff; if files changed, it runs automatically after agent_end and returns on failure.",
			"If check fails, fix the issues and run check again rather than guessing.",
		],
		parameters: CheckParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (running) {
				return {
					content: [{ type: "text" as const, text: "Check already running." }],
					details: undefined,
				};
			}

			running = true;
			try {
				const result = await runChecksForOutput(ctx.cwd);
				if (!result.details || checksPassed(result.details)) {
					hadFileChanges = false;
				}
				return result;
			} finally {
				running = false;
			}
		},
	});

	// Auto-check after agent finishes — only if files were changed.
	// Successful auto-checks are intentionally quiet; failures notify and trigger the agent.
	pi.on("agent_end", async (_event, ctx) => {
		if (running || !hadFileChanges) return;
		running = true;

		try {
			const result = await runChecksForOutput(ctx.cwd);
			if (!result.details || checksPassed(result.details)) {
				hadFileChanges = false;
				return;
			}
			sendCheckMessage(result);
		} finally {
			running = false;
		}
	});

	// Manual /check command
	pi.registerCommand("check", {
		description: "Run checks declared in checks.yaml or .pi/checks.yaml",
		handler: async (_args, ctx) => {
			if (running) return;
			running = true;
			sendRunningMessage(ctx.cwd);

			try {
				const result = await runChecksForOutput(ctx.cwd);
				if (result.details) {
					sendCheckMessage(result);
				} else {
					pi.sendMessage({
						customType: "check-result",
						content: result.content,
						display: true,
						details: undefined,
					});
				}
				if (!result.details || checksPassed(result.details)) {
					hadFileChanges = false;
				}
			} finally {
				running = false;
			}
		},
	});
}
