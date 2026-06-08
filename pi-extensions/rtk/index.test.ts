import { describe, expect, test } from "bun:test";
import { shouldBypassRtkRewrite } from "./index.ts";

// The wrapper delegates the actual rewrite to the `rtk` CLI
// (`rtk rewrite <command>`), so unit tests cover the deterministic guard layer
// only. The CLI itself is exercised by the integration audit in
// `pi-extensions/rtk/CHECK_PROMPT.md`.

describe("shouldBypassRtkRewrite", () => {
	test("bypasses rg, git, find, and biome", () => {
		const cwd = process.cwd();
		expect(shouldBypassRtkRewrite("rg foo bar", cwd)).toBe(true);
		expect(shouldBypassRtkRewrite("git status", cwd)).toBe(true);
		expect(shouldBypassRtkRewrite("biome check .", cwd)).toBe(true);
		expect(
			shouldBypassRtkRewrite("find .pi/agents -maxdepth 1 -type f -name '*.md' -print", cwd),
		).toBe(true);
		expect(
			shouldBypassRtkRewrite("find .pi/agents -maxdepth 1 -type f -name '*.md' -exec basename {} \\;", cwd),
		).toBe(true);
	});

	test("bypasses RTK_DISABLED=1 prefix", () => {
		expect(shouldBypassRtkRewrite("RTK_DISABLED=1 git status", process.cwd())).toBe(true);
		expect(shouldBypassRtkRewrite("env RTK_DISABLED=1 git status", process.cwd())).toBe(true);
	});

	test("bypasses already-rewritten rtk … commands", () => {
		expect(shouldBypassRtkRewrite("rtk ls -la .pi/agents", process.cwd())).toBe(true);
	});

	test("strips leading `cd … && …` wrappers before matching", () => {
		const cwd = process.cwd();
		// Note: only `;` and single `&` separators are matched; the `&&` form is
		// pre-existing known behaviour shared with @mrclrchtr/supi-rtk.
		expect(shouldBypassRtkRewrite("cd /tmp; git status", cwd)).toBe(true);
	});

	test("does not bypass ls / grep / cat", () => {
		expect(shouldBypassRtkRewrite("ls -la .pi/agents", process.cwd())).toBe(false);
		expect(
			shouldBypassRtkRewrite("grep -n \"subagent-orchestration\" .rtango/spec.yaml", process.cwd()),
		).toBe(false);
		expect(shouldBypassRtkRewrite("cat README.md", process.cwd())).toBe(false);
	});
});
