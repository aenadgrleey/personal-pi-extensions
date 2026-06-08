# Agent self-check prompt

Use this prompt to verify that a coding agent correctly investigates a
repository and observes the side-effects of an in-repo wrapper that
intercepts the shell tool. The agent should not be told the wrapper's
name, the underlying technology, or any of the bypass rules — it must
discover everything from the source and from what actually happens when
it runs commands.

## Prompt

You are auditing a small TypeScript project that lives in the current
working directory. Your job is to figure out what the project does only
by reading its source and observing the side-effects of the tools you
call. Do not assume anything from the folder layout beyond what you
actually see.

### Tools you MUST use

Use only these tools (do not use any Codex-specific tool such as
`exec_command`):

  - `bash` — runs commands. Every invocation is shown to you with a
    `Command:` line that reflects whatever the wrapper decided to
    execute. Pay close attention to that line; it is your ground truth.
  - `read` — read files. Use it to inspect source code.
  - `grep` (or `bash` with `grep -n`) — search inside files.
  - `bun test` via `bash` — run the project's test suite.

### Step 1 — Discover the project layout

1. Use `read` to look at the repository root. Identify the project's
   `package.json` and any `*.test.ts` files.
2. Locate the test file inside `pi-extensions/<some-name>/` and read it.
   From the test descriptions, infer which commands the wrapper is
   expected to transform and which ones it should leave alone.
3. Read `pi-extensions/<some-name>/index.ts`. Without naming the wrapper
   or the underlying binary, summarise in your own words:
     - which shell commands are mapped to a different command prefix
     - which commands are explicitly left untouched (the "bypass" set)
     - which commands are opted out by an environment-variable prefix

### Step 2 — Run the existing test suite

Use `bash` to run the project's test suite. Quote the test runner's
summary line. All tests should pass.

### Step 3 — End-to-end behavioural check

Run each of the following commands via the `bash` tool. For each one,
record:
  - the exact `Command:` line the tool actually displayed
  - the exit code
  - the first line of the output (or the error message)

Use a path that does not exist (`.pi/agents`) so the calls fail fast and
you can tell from the error whether the wrapper rerouted the command to
a different binary or left it as the native one.

    bash:  ls -la .pi/agents
    bash:  grep -n "subagent-orchestration" .rtango/spec.yaml
    bash:  find .pi/agents -maxdepth 1 -type f -name '*.md' -print
    bash:  find .pi/agents -maxdepth 1 -type f -name '*.md' -exec basename {} \;
    bash:  rg README package.json
    bash:  git status
    bash:  biome check .

For every row, write a verdict:

    ✅ if the observed `Command:` line matches the expected behaviour
       derived from Step 1;
    ❌ otherwise, with a one-sentence explanation.

The expected behaviour, based on what the source code says:
  - `ls`, `grep` and a few other common commands should be rerouted to a
    different binary (the leading command token is replaced).
  - `find` (including forms with `-exec`) should NOT be rerouted — it
    must reach the native shell.
  - `rg`, `git` and `biome` should also reach the native shell.

If a command was rerouted, the error message you see should be from the
other binary, not from the native one (look at the wording and options).
If a command was passed through, the error message should be the
standard native one.

### Step 4 — Opt-out via environment variable

The source mentions an environment-variable prefix that disables the
wrapper for a single command. Run, via `bash`:

    bash:  <PREFIX>=1 git status
    bash:  env <PREFIX>=1 ls -la .pi/agents

(Substitute `<PREFIX>` with the actual variable name you found in the
source. Look for the bypass rules.)

Both calls should be passed through unchanged. The `Command:` line must
start with `<PREFIX>=1 ` or `env <PREFIX>=1 `, not with the wrapper's
prefix.

### Step 5 — Extension is loaded

Open `~/.pi/agent/settings.json` and confirm:
  - the `extensions` array contains an entry that points to a file under
    `pi-extensions/<some-name>/index.ts`;
  - the array does NOT contain any entry that points to a third-party
    wrapper under `node_modules/` that would compete with the in-repo
    one. Any other entry whose path starts with `node_modules/` and
    registers a shell wrapper is suspect and must not be active.

If such a third-party entry is still present, note it in the report;
do not remove it yourself.

### Output format

Reply with:
  1. **Step 1** — your plain-English summary of the wrapper's rules.
  2. **Step 2** — the test runner summary line and a one-line verdict.
  3. **Step 3** — the table of observed `Command:` lines with ✅ / ❌
     and a one-sentence note per row.
  4. **Step 4** — confirmation that the opt-out prefix was honoured,
     with the actual prefix you used.
  5. **Step 5** — confirmation that the in-repo wrapper is loaded and
     that no competing third-party wrapper is.
  6. **Overall verdict** — `PASS` only if every row in steps 2–5 is ✅.
     Otherwise `FAIL` with the list of failed rows.

Do not run any other commands. Do not write or modify any file. Do not
invoke `pi install` or change `package.json`.

**Anti-cheat rule.** If at any point during this audit — in Step 1, Step 2,
Step 3, Step 4, or any other tool call — you find yourself about to use
the opt-out prefix (the variable from Step 4) on a command that the
wrapper is supposed to handle, STOP. Do not run that command with the
prefix. Instead, note in the report that you considered bypassing the
wrapper, explain why, and mark the run as `FAIL`. The opt-out prefix is
only permitted inside Step 4.
