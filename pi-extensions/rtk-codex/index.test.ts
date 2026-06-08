import { describe, expect, test } from "bun:test";
import { applyRtkMappings, shouldBypassRtkRewrite } from "./index.ts";

// Smoke test fixture: see conversation context. The expected behaviour is:
//   - `ls` / `grep`  -> `rtk ls` / `rtk grep` (positive mapping)
//   - `find`         -> native (no mapping; left to RTK's `rtk rewrite`
//                      fallback or to native execution)
//   - `rg`, `git`, `biome` -> bypassed entirely (handled elsewhere)
const FIXTURES: Array<{ command: string; expectRtkPrefix: boolean }> = [
	{ command: "ls -la .pi/agents", expectRtkPrefix: true },
	{
		command: "grep -n \"subagent-orchestration\" .rtango/spec.yaml",
		expectRtkPrefix: true,
	},
	{
		command: "find .pi/agents -maxdepth 1 -type f -name '*.md' -print",
		expectRtkPrefix: false,
	},
	{
		command: "find .pi/agents -maxdepth 1 -type f -name '*.md' -exec basename {} \\;",
		expectRtkPrefix: false,
	},
];

describe("applyRtkMappings", () => {
	test("rewrites the smoke-test commands to rtk subcommands", () => {
		for (const { command, expectRtkPrefix } of FIXTURES) {
			const mapped = applyRtkMappings(command);
			if (expectRtkPrefix) {
				expect(mapped).toStartWith("rtk ");
				expect(mapped?.startsWith(command)).toBe(false);
			} else {
				expect(mapped).toBeUndefined();
			}
		}
	});

	test("forwards native flags verbatim", () => {
		expect(applyRtkMappings("ls -la .pi/agents")).toBe("rtk ls -la .pi/agents");
		expect(applyRtkMappings("grep -n foo bar")).toBe("rtk grep -n foo bar");
		expect(applyRtkMappings("cat README.md")).toBe("rtk read README.md");
		expect(applyRtkMappings("tree -L 2")).toBe("rtk tree -L 2");
	});

	test("does not match inside other tokens", () => {
		// `ls` inside a path or argument should not trigger mapping.
		expect(applyRtkMappings("echo ls")).toBeUndefined();
		expect(applyRtkMappings("myls")).toBeUndefined();
		expect(applyRtkMappings("Rls -la")).toBeUndefined();
	});

	test("preserves quoted arguments and shell metacharacters", () => {
		const mapped = applyRtkMappings("grep -n \"subagent-orchestration\" .rtango/spec.yaml");
		expect(mapped).toBe("rtk grep -n \"subagent-orchestration\" .rtango/spec.yaml");
	});
});

describe("shouldBypassRtkRewrite", () => {
	test("bypasses rg, git, and biome", () => {
		const cwd = process.cwd();
		expect(shouldBypassRtkRewrite("rg foo bar", cwd)).toBe(true);
		expect(shouldBypassRtkRewrite("git status", cwd)).toBe(true);
		expect(shouldBypassRtkRewrite("biome check .", cwd)).toBe(true);
	});

	test("bypasses RTK_DISABLED=1 prefix", () => {
		expect(shouldBypassRtkRewrite("RTK_DISABLED=1 git status", process.cwd())).toBe(true);
		expect(shouldBypassRtkRewrite("env RTK_DISABLED=1 git status", process.cwd())).toBe(true);
	});

	test("does not bypass plain find (left for the rtk rewrite fallback)", () => {
		// `find` is bypassed so it stays native — `rtk find` cannot handle
		// compound predicates like `-exec`, `-not`, etc.
		expect(
			shouldBypassRtkRewrite("find .pi/agents -maxdepth 1 -type f -name '*.md' -print", process.cwd()),
		).toBe(true);
	});

	test("does not bypass ls / grep", () => {
		expect(shouldBypassRtkRewrite("ls -la .pi/agents", process.cwd())).toBe(false);
		expect(
			shouldBypassRtkRewrite("grep -n \"subagent-orchestration\" .rtango/spec.yaml", process.cwd()),
		).toBe(false);
	});
});
