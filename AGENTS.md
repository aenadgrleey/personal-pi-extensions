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
- `pi-extensions/plan/` — phased plan review/save flow. The `plan_preview` tool selector offers **Accept / Save / Hand off / Refine / Discard**; the “📤 Hand off” action copies the plan YAML to `.pi/handoffs/<slug>.yaml`, copies a pickup prompt to the clipboard, and queues it as a follow-up user message via `pi.sendUserMessage({ deliverAs: “followUp” })`. A `pi.on(“context”)` filter in the same extension drops every message that appeared before the latest `<plan-handoff>` marker from what the LLM actually sees, while the full history stays on disk for `/resume` and tree navigation. Same session, no compaction, no new session file.
- `pi-extensions/review/` — keep/revise decision review flow
- `pi-extensions/interaction-components/` — shared interaction contract, hub, local provider, and a pub/sub event hook (`addInteractionListener` / `emitInteraction`) fired by the three shared entry points in plan/ask/review for both bridge and local-fallback paths
- `pi-extensions/indicators.ts` — footer/status indicator customization
- `pi-extensions/system-context/index.ts` — optional system-prompt injector for active model notes (not loaded by default)
- `pi-extensions/notify.ts` — desktop notification helper and commands (fires on `agent_end`)
- `pi-extensions/interaction-notifier.ts` — desktop notifications for ask / plan / review interaction events (macOS `osascript`, per-kind sounds, per-kind toggle via `/notif-config [ask|plan|review]`)
- `pi-extensions/check.ts` — auto-runs tsc + biome + eslint after agent completes work
- `pi-extensions/clear-input/` — `Cmd+Shift+R` (`ctrl+shift+r` in pi notation) wipes the prompt editor via `ctx.ui.setEditorText("")`; also registers `/clear-input` as a slash-command fallback. Sits next to the built-in `app.clear` (`ctrl+c`) without rebinding it.
- `pi-extensions/auto-update/index.ts` — checks for pi updates on startup and updates in the background
- `node_modules/@gotgenes/pi-subagents/src/index.ts` — re-exported sub-agent orchestration extension
- `node_modules/@teelicht/pi-grepai/src/extension/index.ts` — re-exported GrepAI CLI bridge tools and commands

## Working Rules

- Keep changes focused and minimal.
- Update the relevant docs/specs when behavior changes.
- Treat skill `SKILL.md` files as the source of truth for their skill behavior.
- Avoid editing generated, vendor, or local-secret files like `node_modules/`, `.git/`, and `.env` unless explicitly needed.
- When adding or changing extension behavior, keep the implementation and documentation aligned.
- Run `bun run check` before committing to catch type errors and lint issues.
- Pre-existing strict-mode issues in older extensions are tracked as tech debt — fix when modifying those files.
