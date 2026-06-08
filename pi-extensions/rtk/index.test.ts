import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  rewriteToolInput,
  shouldBypassRtkRewrite,
  type ToolRewrite,
} from "./index.ts";

// The wrapper delegates the actual rewrite to the `rtk` CLI
// (`rtk rewrite <command>`), so unit tests cover the deterministic guard layer
// only. The CLI path is exercised by the repo-level integration smoke checks.

describe("shouldBypassRtkRewrite", () => {
  test("bypasses rg, git, find, and biome", () => {
    const cwd = process.cwd();
    expect(shouldBypassRtkRewrite("rg foo bar", cwd)).toBe(true);
    expect(shouldBypassRtkRewrite("git status", cwd)).toBe(true);
    expect(shouldBypassRtkRewrite("biome check .", cwd)).toBe(true);
    expect(
      shouldBypassRtkRewrite(
        "find .pi/agents -maxdepth 1 -type f -name '*.md' -print",
        cwd,
      ),
    ).toBe(true);
    expect(
      shouldBypassRtkRewrite(
        "find .pi/agents -maxdepth 1 -type f -name '*.md' -exec basename {} \\;",
        cwd,
      ),
    ).toBe(true);
  });

  test("bypasses RTK_DISABLED=1 prefix", () => {
    expect(
      shouldBypassRtkRewrite("RTK_DISABLED=1 git status", process.cwd()),
    ).toBe(true);
    expect(
      shouldBypassRtkRewrite("env RTK_DISABLED=1 git status", process.cwd()),
    ).toBe(true);
  });

  test("bypasses already-rewritten rtk … commands", () => {
    expect(shouldBypassRtkRewrite("rtk ls -la .pi/agents", process.cwd())).toBe(
      true,
    );
  });

  test("strips leading `cd … && …` wrappers before matching", () => {
    const cwd = process.cwd();
    // Note: only `;` and single `&` separators are matched; the `&&` form is
    // pre-existing known behaviour shared with @mrclrchtr/supi-rtk.
    expect(shouldBypassRtkRewrite("cd /tmp; git status", cwd)).toBe(true);
  });

  test("does not bypass ls / grep / cat", () => {
    expect(shouldBypassRtkRewrite("ls -la .pi/agents", process.cwd())).toBe(
      false,
    );
    expect(
      shouldBypassRtkRewrite(
        'grep -n "subagent-orchestration" .rtango/spec.yaml',
        process.cwd(),
      ),
    ).toBe(false);
    expect(shouldBypassRtkRewrite("cat README.md", process.cwd())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rewriteToolInput — applies RTK rewriting to known shell-command fields on
// both the built-in bash tool and codex-adapter tools (exec_command,
// write_stdin). The unit tests inject a mock `rewrite` function so the
// dispatch logic is exercised without shelling out to the `rtk` CLI.
// ---------------------------------------------------------------------------

type RewriteCall = { command: string; cwd: string };

function makeRecorderRewrite(): {
  fn: ToolRewrite;
  calls: RewriteCall[];
} {
  const calls: RewriteCall[] = [];
  const fn: ToolRewrite = (command, cwd) => {
    calls.push({ command, cwd });
    return { kind: "rewritten", command: `mock-rewritten:${command}` };
  };
  return { fn, calls };
}

describe("rewriteToolInput", () => {
  const ctx = { cwd: "/test/cwd" } as unknown as ExtensionContext;

  test("rewrites exec_command.cmd and resolves cwd from workdir", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { cmd: "ls -la", workdir: "subdir" };
    const result = rewriteToolInput(
      "exec_command",
      input,
      "/test/cwd",
      ctx,
      fn,
    );
    // ctx.cwd is the base, workdir is appended via resolve().
    expect(calls).toEqual([{ command: "ls -la", cwd: "/test/cwd/subdir" }]);
    expect(result.cmd).toBe("mock-rewritten:ls -la");
    expect(result.workdir).toBe("subdir");
  });

  test("falls back to ctx.cwd when exec_command has no workdir", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { cmd: "ls -la" };
    rewriteToolInput("exec_command", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([{ command: "ls -la", cwd: "/test/cwd" }]);
  });

  test("also picks up the `command` alias on exec_command", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { command: "ls -la" };
    const result = rewriteToolInput(
      "exec_command",
      input,
      "/test/cwd",
      ctx,
      fn,
    );
    expect(calls).toEqual([{ command: "ls -la", cwd: "/test/cwd" }]);
    expect(result.command).toBe("mock-rewritten:ls -la");
  });

  test("does not invoke the rewrite function when both `cmd` and `command` are missing", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { workdir: "subdir" };
    rewriteToolInput("exec_command", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([]);
  });

  test("rewrites write_stdin.chars and uses ctx.cwd as the reference cwd", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { session_id: 1, chars: "ls -la" };
    const result = rewriteToolInput("write_stdin", input, "/test/cwd", ctx, fn);
    // write_stdin targets an already-spawned session, so the current ctx.cwd
    // is the right reference (not the session's original cwd).
    expect(calls).toEqual([{ command: "ls -la", cwd: "/test/cwd" }]);
    expect(result.chars).toBe("mock-rewritten:ls -la");
    expect(result.session_id).toBe(1);
  });

  test("does not invoke the rewrite function for apply_patch (no shell field)", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = {
      patch: "*** Begin Patch\n@@\n-foo\n+bar\n*** End Patch",
    };
    const result = rewriteToolInput("apply_patch", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([]);
    expect(result).toEqual(input);
  });

  test("does not invoke the rewrite function for unknown tools", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { cmd: "ls -la" };
    const result = rewriteToolInput("view_image", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([]);
    expect(result).toEqual(input);
  });

  test("rewrites the built-in bash tool through the shared field map", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { command: "ls -la" };
    const result = rewriteToolInput("bash", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([{ command: "ls -la", cwd: "/test/cwd" }]);
    expect(result.command).toBe("mock-rewritten:ls -la");
  });

  test("leaves the field untouched when rewrite returns `unchanged`", () => {
    const fn: ToolRewrite = () => ({ kind: "unchanged" });
    const input: Record<string, unknown> = { cmd: "ls -la" };
    const result = rewriteToolInput(
      "exec_command",
      input,
      "/test/cwd",
      ctx,
      fn,
    );
    expect(result.cmd).toBe("ls -la");
  });

  test("leaves the field untouched when rewrite returns `passthrough`", () => {
    const fn: ToolRewrite = () => ({ kind: "passthrough", reason: "bypass" });
    const input: Record<string, unknown> = { cmd: "git status" };
    const result = rewriteToolInput(
      "exec_command",
      input,
      "/test/cwd",
      ctx,
      fn,
    );
    expect(result.cmd).toBe("git status");
  });

  test("skips non-string cmd values (defensive against bad tool input)", () => {
    const { fn, calls } = makeRecorderRewrite();
    const input: Record<string, unknown> = { cmd: 123, command: null };
    rewriteToolInput("exec_command", input, "/test/cwd", ctx, fn);
    expect(calls).toEqual([]);
  });

  test("mutates the input object in place (caller's reference is updated)", () => {
    const { fn } = makeRecorderRewrite();
    const input: Record<string, unknown> = { cmd: "ls -la" };
    const result = rewriteToolInput(
      "exec_command",
      input,
      "/test/cwd",
      ctx,
      fn,
    );
    expect(result).toBe(input);
    expect(input.cmd).toBe("mock-rewritten:ls -la");
  });
});
