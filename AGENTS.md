# AGENTS.md

## Purpose

`personal-pi-extensions` provides TypeScript extensions and tooling for the pi coding agent.

## Repo Inventory

### External Pi packages

The global Pi setup also includes:

- `npm:@howaboua/pi-glm-via-anthropic`
- `npm:pi-hermes-memory`
- `npm:pi-web-access`
- `personal-pi-extensions` as `../../repos/mics/personal-pi-extensions`

If `~/.pi/agent/settings.json` still mentions `message-queue`, remove it; that path is stale.
Before adding Pi package assets, inspect `~/.pi/agent/settings.json` and the current installed Pi packages/extensions first so you do not duplicate capabilities already available globally.

### Skills

Skills may live in `personal-context-files` or this repo's `skills/` package. Refer to `rtango-manifest.md` for the full inventory.

### TypeScript Extensions

- `pi-extensions/ask/` — interactive question/answer UI tool
- `pi-extensions/interaction-components/` — shared interaction contract, hub, local provider, and a pub/sub event hook (`addInteractionListener` / `emitInteraction`) fired by the ask entry point for both bridge and local-fallback paths
- `pi-extensions/indicators.ts` — footer/status indicator customization, including Codex/Cursor/Z.ai/MiniMax quota display
- `pi-extensions/system-context/index.ts` — optional system-prompt injector for active model notes (not loaded by default)
- `pi-extensions/notify.ts` — desktop notification helper and commands (fires on `agent_end`)
- `pi-extensions/interaction-notifier.ts` — desktop notifications for ask interaction events (macOS `osascript`, toggle via `/notif-config [ask]`)
- `pi-extensions/check.ts` — auto-runs tsc + biome + eslint after agent completes work
- `pi-extensions/auto-update/index.ts` — checks for pi updates on startup and updates in the background
- `pi-extensions/codex-swap/` — private, locked multi-account switching for Pi's built-in `openai-codex` OAuth login
- `pi-extensions/honcho-memory/` — local Honcho persistent memory extension (fork of `@agney/pi-honcho-memory` with stale-`ctx` guards; automatic conversation export is explicit opt-in and filters credential-shaped content)
- `node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts` — re-exported dynamic-workflows extension (vm-sandboxed JS scripts that fan out to many subagents via `agent()`/`parallel()`/`phase()`; journaled resume, worktree isolation, `/workflows` TUI; see `.pi/skills/subagent-orchestration/SKILL.md` for usage)
- `node_modules/@teelicht/pi-grepai/src/extension/index.ts` — re-exported GrepAI CLI bridge tools and commands

## Working Rules

- Keep changes focused and minimal.
- Update the relevant docs/specs when behavior changes.
- Treat skill `SKILL.md` files as the source of truth for their skill behavior.
- Avoid editing generated, vendor, or local-secret files like `node_modules/`, `.git/`, and `.env` unless explicitly needed.
- When adding or changing extension behavior, keep the implementation and documentation aligned.
- Run `bun run check` before committing to catch type errors and lint issues.
- Pre-existing strict-mode issues in older extensions are tracked as tech debt — fix when modifying those files.
