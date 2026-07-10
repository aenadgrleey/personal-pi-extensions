# personal-pi-extensions

TypeScript extensions for the pi coding agent.

## Entry point

Read [`.rtango/spec.yaml`](./.rtango/spec.yaml) for the managed skills inventory and source mapping.

## What this repo provides

- TypeScript utilities and extensions in `pi-extensions/`
- checks in repository-root `checks.yaml` (with `.pi/checks.yaml` compatibility) and agent config in `.pi/`
- reusable skills and workflows generated into gitignored `skills/` by rtango from `personal-context-files` and curated upstream collections
- shared interaction components for interactive extension flows
- a re-exported `@quintinshaw/pi-dynamic-workflows` extension that turns one prompt into a fleet of subagents fanning out in parallel via a JS orchestration script in a `vm` sandbox (`agent()`/`parallel()`/`phase()`), with journaled resume, git-worktree isolation, real token / cost accounting, an interactive `/workflows` TUI, and `/deep-research` / `/adversarial-review` / `/ultracode` commands. Auto-triggers on the keyword `workflow`; toggle with `/workflows-trigger on|off`
- a re-exported `@howaboua/pi-codex-conversion` Codex tool/prompt adapter
- a local `codex-swap` extension for switching Pi's saved ChatGPT/Codex OAuth accounts
- an RTK/Codex bridge that rewrites Codex `exec_command` calls through `rtk rewrite` while leaving the Codex terminal implementation intact
- a re-exported `@teelicht/pi-grepai` GrepAI CLI bridge

## Setup model

Keep responsibilities separate:

- use `rtango` for shared skills and instructions; `rtango sync` materializes the local `skills/` directory when needed
- use `pi install` for Pi package assets (extensions and checks)
- include `checks.yaml` in the setup plan when the target repo uses Pi; keep `.pi/checks.yaml` only when compatibility is needed
- keep local Pi preferences/secrets as local setup, not exported content

## Codex account switching

`pi-extensions/codex-swap/index.ts` is loaded through this package manifest. It
uses Pi's built-in OAuth provider; it does **not** register another provider or
implement OAuth itself.

1. Sign in through Pi: `/login openai-codex`.
2. Explicitly save that fresh Pi login: `/codexswap add [label]`.
3. Switch while the agent is idle with `/codexswap`, `/codexswap back`,
   `/codexswap use <label|#>`, or `/codexswap best`.
4. Inspect the active account with `/codexwho` or `/codexswap who`.

`/codexswap status`, `usage [all|label|#]`, `low` (also `lowest`/`sort`),
`purge`, `rm`, and `rename` remain available for account management. Commands
and notifications never display OAuth credential material.

Saved OAuth profiles live only in Pi's private global agent directory, in a
locked `0600` file below `~/.pi/agent/codex-swap/`; its directory is `0700`.
The extension uses Pi's public `AuthStorage` API for the live account and an
isolated temporary `AuthStorage` instance to refresh inactive profiles.

`/codexpref` manages global and, when Pi is inside a repository, repository
preferences. The only repository-local setting is
`<repository-root>/.pi/codex-swap/preferred-account-id`. It contains exactly
one stable account ID followed by a newline—never an OAuth token, refresh token,
profile JSON, label, or email. For example:

```text
# .pi/codex-swap/preferred-account-id
acct_123
```

Repository discovery is filesystem-only and supports ordinary repositories and
linked-worktree `.git` files. Symlinks, non-regular files, malformed gitfiles,
oversized/multiline selectors, and unsafe preference paths are rejected. This
is a deliberate trust boundary: a present but invalid, unavailable, unresolved,
or ambiguous repository selector **blocks** global fallback. Only an absent
repository selector permits the private global preference to apply.

On an interactive, idle `session_start` with reason `startup`, the selected
preference is attempted once. Any failure leaves Pi's active account unchanged.
`/codexpref` reports the exact scope and path it wrote or cleared, while only
persisting the selected account ID. The profile store remains private under
`~/.pi/agent`; repository files never receive credentials.

Malformed credentials, elapsed credentials that cannot refresh, and confirmed
authentication rejections are removed rather than re-saved. A transient network
or unexpected refresh failure preserves an otherwise unelapsed credential
unchanged. Remote refresh and usage calls run outside the short profile-store
critical section; refresh results are reconciled only when the captured profile
snapshot is still current.

## Bootstrapping another repo

### Required first step

Before importing anything, inspect the target repository:

1. the stack
2. the product/domain
3. existing repo conventions
4. whether rtango is already present
5. which exports from this repo are actually relevant

### Recommended workflow

1. Create or update the target repo's rtango config.
2. If `.rtango/` is absent, run `rtango init` before adding anything to the spec so the built-in rtango guidance is available.
3. If rtango is already initialized, update the existing spec instead of re-running `rtango init`.
4. Keep the config minimal and aligned with the target stack.
5. Import only the reusable assets that match the repo, and do not drop rtango guidance from the final setup.
6. Prefer `kind: collection` for grouped imports and pin the GitHub ref when practical; use individual skill rules only when a whole collection would be overkill.
7. Run `rtango status` then `rtango sync`.
8. Inspect the current Pi setup to see what is already available globally or from an existing install.
9. Install only the missing Pi package assets via `pi install`, ensure `checks.yaml` is present (or `.pi/checks.yaml` for compatibility).
10. Leave a short summary of what was enabled, skipped, and why.

### Synced skills

- personal Pi package work: `pi-extension-development`, `subagent-orchestration`, `extract-procedures-into-skills`
- handoff workflows: `commit`, `github-pr`, `gitlab-mr`, `yeet`
- general workflow skills from curated collections: `write-a-skill`, `caveman`, `karpathy-guidelines`, `spec-driven-development`, `tdd`, `zoom-out`
- GrepAI skills from the curated `grepai` collection: init, ignore patterns, watch daemon, search, trace, GOB storage, troubleshooting

### What not to do

- Do not copy repo-local agents into the target repo.
- Do not pull in pi checks outside pi.
- Do not manually copy Pi package assets when package install is the intended path.
- Do not install duplicate extensions when already available globally.
- Do not forget `checks.yaml` (or the compatible `.pi/checks.yaml`) when setting up a Pi repo.
- Do not assume Android skills belong in a non-Android repo.
- Do not overwrite existing repo rules without checking local files first.
- Do not claim a setup succeeded if the target harness cannot support it.

## Harness rules

- If you are not using rtango yet, treat `.rtango/spec.yaml` as guidance only.
- If you are not running inside pi coding agent, do not try to install pi extensions or checks.
- If a capability is missing, skip that section and say so explicitly.

## Development tooling

The check pipeline is non-mutating and validates formatting before deterministic
Codex-swap tests and the two `/tmp` smoke builds.

```bash
bun run tsc     # type check only
bun run lint    # biome + eslint
bun run format  # auto-fix formatting
bun run check   # non-mutating Codex-swap validation + smoke builds
```

Package manager is **bun**. Use `bun install`, `bun add`, `bunx` — not npm/npx.

## Repo structure

```
personal-pi-extensions/
├── pi-extensions/           ← TypeScript extensions
├── .pi/                     ← compatibility checks and agent config
├── .rtango/                 ← rtango spec and lock for synced skills
├── skills/                  ← gitignored rtango-managed skill output
├── package.json
├── tsconfig.json
├── biome.json
└── eslint.config.js
```
