/**
 * Check Extension — runs checks declared in `.pi/checks.yaml`
 *
 * - Reads check definitions from `.pi/checks.yaml` at runtime.
 * - On `agent_end`: runs checks, sends a custom message with results.
 *   On failure, triggers the agent to fix issues.
 * - `check` tool and `/check` command: run the checks declared in `.pi/checks.yaml`.
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

interface CheckResult {
	tool: string;
	passed: boolean;
	errors: number;
	warnings: number;
	output: string;
}

interface CheckDetails {
	summary: string;
	results: CheckResult[];
}

// ── YAML loader ──────────────────────────────────────────────────────────

function loadChecks(cwd: string): CheckDef[] {
	const path = join(cwd, ".pi", "checks.yaml");
	try {
		const raw = readFileSync(path, "utf-8");
		const file = yaml.load(raw) as ChecksFile;
		if (!file?.checks || !Array.isArray(file.checks)) return [];
		return file.checks;
	} catch {
		return [];
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function runCheck(
	exec: ExtensionAPI["exec"],
	check: CheckDef,
): Promise<CheckResult> {
	const parts = check.command.split(/\s+/);
	const cmd = parts[0] ?? "";
	const args = parts.slice(1);

	try {
		const result = await exec(cmd, args, { timeout: 30_000 });
		const output = (result.stdout + result.stderr).trim();
		const passed = result.code === 0;

		let errors = 0;
		let warnings = 0;

		// Parse tsc error count
		if (args[0] === "tsc") {
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

		return { tool: check.name, passed, errors, warnings, output };
	} catch (err) {
		return {
			tool: check.name,
			passed: false,
			errors: 1,
			warnings: 0,
			output: err instanceof Error ? err.message : String(err),
		};
	}
}

async function runChecks(exec: ExtensionAPI["exec"], cwd: string): Promise<CheckResult[]> {
	const checks = loadChecks(cwd);
	if (checks.length === 0) return [];
	return Promise.all(checks.map((c) => runCheck(exec, c)));
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
		.map((r) => `[${r.tool}]\n${r.output.split("\n").slice(0, 20).join("\n")}`)
		.join("\n\n");
}

function buildCheckMessage(results: CheckResult[]): { content: string; details: CheckDetails } {
	const summary = formatSummary(results);
	const allPassed = results.every((r) => r.passed);
	return {
		content: allPassed ? "All checks pass." : `Check failed. Fix these issues:\n\n${buildErrorText(results)}`,
		details: { summary, results },
	};
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
		const results = await runChecks(pi.exec, cwd);
		if (results.length === 0) {
			return {
				content: [{ type: "text" as const, text: "No checks found in .pi/checks.yaml" }],
				details: undefined,
			};
		}

		const result = buildCheckMessage(results);
		return {
			content: [{ type: "text" as const, text: result.content }],
			details: result.details,
		};
	}

	// Send check result as a custom message
	function sendCheckMessage(result: { content: [{ type: "text"; text: string }]; details: CheckDetails | undefined }) {
		const allPassed = result.details?.results.every((r) => r.passed) ?? true;

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
		const checks = loadChecks(cwd);
		const names = checks.map((c) => c.name);
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
			"Run the checks declared in .pi/checks.yaml. " +
			"Use this when you want an explicit verification run during the task or after fixing issues. " +
			"Do not run it just for end-of-task handoff: if files changed, it runs automatically after agent_end and returns on failure.",
		promptSnippet: "Run project checks from .pi/checks.yaml when you need an explicit verification run",
		promptGuidelines: [
			"Use check when you want to verify the current work during the task or after fixing issues.",
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
				return await runChecksForOutput(ctx.cwd);
			} finally {
				running = false;
			}
		},
	});

	// Auto-check after agent finishes — only if files were changed
	pi.on("agent_end", async (_event, ctx) => {
		if (running || !hadFileChanges) return;
		running = true;

		try {
			const result = await runChecksForOutput(ctx.cwd);
			if (result.details) {
				sendCheckMessage(result);
			}
		} finally {
			running = false;
		}
	});

	// Manual /check command
	pi.registerCommand("check", {
		description: "Run checks declared in .pi/checks.yaml",
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
			} finally {
				running = false;
			}
		},
	});
}
