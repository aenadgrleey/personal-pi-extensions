# Plan: Telegram Session Control v1 for Pi

Related spec: [`telegram-session-control-spec.md`](./telegram-session-control-spec.md)

## Objective

Implemented Telegram session-control v1 as a focused remote-control surface for Pi:

- `/new_session` and `/clear` reset flows
- dynamic runtime-discovered `/skill_<name>` commands
- `/skills`, `/status`, `/refresh`, `/context`, `/detach`, `/help`
- Telegram bot command publication refresh on reload/restart
- attach-time warning for skills that are available but not publishable
- remote reset derived from the active runtime instead of a one-time local bootstrap command

## Phase 1 — Command Model & Skill Publication

### Goals

Define the fixed Telegram command set, derive dynamic skill commands from the runtime skill inventory, and publish the current command menu to Telegram.

### Steps

1. Add a small command-model module or local helper layer for:
   - fixed commands
   - generated skill commands
   - publishability checks
   - collision detection
   - “not published because…” metadata
2. Implement skill alias sanitization:
   - lowercase
   - `-` → `_`
   - remove unsupported chars
   - prepend `skill_`
   - enforce Telegram 32-char limit
3. Merge fixed commands and dynamic skill commands into one publishable command list.
4. Add Telegram transport support for updating the published bot command menu.
5. Refresh the published command menu on extension startup/reload.
6. Persist or expose the latest publication result so `/status` and warnings can report it.

### Verification checkpoint

- Given the current repo skill inventory, the extension produces:
  - a valid fixed command list
  - a valid publishable skill-command list
  - a list of excluded skills with reasons
- Restart/reload updates the Telegram bot command menu.

## Phase 2 — Session Reset Commands

### Goals

Implement `/new_session` and `/clear` as separate reset paths: `/new_session` keeps Telegram chat history, while `/clear` best-effort cleans it up.

### Steps

1. Decide the concrete integration point for creating/switching to a fresh Pi session from Telegram-triggered input.
2. Implement reset orchestration that:
   - creates a fresh session
   - transfers/claims Telegram ownership for that session
   - resets pending Telegram remote state
   - optionally triggers best-effort cleanup of bot-managed Telegram history
3. Wire `/new_session` to the non-cleanup reset flow.
4. Wire `/clear` to the cleanup reset flow.
5. Ensure failures in Telegram message deletion do not prevent the new session from becoming active.
6. Return concise Telegram feedback describing success and any partial cleanup failure.

### Verification checkpoint

- `/new_session` from Telegram results in a fresh active Pi session without clearing Telegram chat history.
- `/clear` results in a fresh active Pi session and best-effort clears Telegram chat history.
- Telegram ownership follows the fresh session.
- Cleanup failures are non-fatal and visible.

## Phase 3 — Skill Command Execution

### Goals

Make skills first-class remote actions through `/skill_<name>` commands.

### Steps

1. Extend inbound Telegram parsing to recognize fixed commands and dynamic `/skill_<name>` commands.
2. Add alias-to-skill resolution using the current published skill map.
3. Implement immediate execution for `/skill_<name> <task...>` by sending a normal Pi user request framed as “use skill X for task Y”.
4. Implement armed-skill state for `/skill_<name>` without trailing text.
5. On the next normal Telegram message, convert armed-skill state into the corresponding Pi user request and clear the armed state.
6. Handle invalid, stale, or unpublished skill aliases with a clear Telegram response.

### Verification checkpoint

- `/skill_tdd fix bug` launches a skill-oriented Pi request.
- `/skill_tdd` arms the skill and the next Telegram message uses it.
- Armed state clears predictably after use or reset.

## Phase 4 — User-Facing Control UX

### Goals

Make the command surface understandable and transparent from Telegram.

### Steps

1. Implement `/skills` output grouped as:
   - published skill commands
   - available but not published skills
2. Include the exclusion reason for each non-published skill.
3. Implement `/status` to report:
   - Telegram ownership/attachment
   - current command refresh status
   - whether any skills were excluded from publication
4. Implement `/refresh` to republish the Telegram command menu from the current runtime inventory and report the latest publish result.
5. Implement `/help` with the v1 command model and limitations.
6. Add attach-time warning when some available skills could not be published safely.
7. Ensure messaging stays concise and remote-friendly.

### Verification checkpoint

- `/skills` reflects the current runtime inventory accurately.
- `/status` reports publication state and exclusions.
- `/refresh` republishes the current slash-command menu and reports the result.
- Attach produces a warning if long/colliding skills were skipped.

## Phase 5 — Tests & Hardening

### Goals

Cover the new command model, reset behavior, and skill routing with targeted tests.

### Steps

1. Add unit tests for:
   - alias generation
   - collision handling
   - 32-char filtering
   - command publication payload generation
   - skill-command parsing
   - armed-skill behavior
2. Add integration-style tests for:
   - command refresh on startup/reload
   - reset flow behavior for `/new_session` and `/clear`
   - non-fatal Telegram cleanup failures
   - `/skills` reporting
3. Add or update manual validation notes for a sandbox Telegram chat.
4. Run `bun run check` and fix any regressions.

### Verification checkpoint

- Tests cover the new aliasing, publication, reset, and routing behavior.
- `bun run check` passes.

## Risks & Implementation Notes

- The biggest unknown is the exact Pi API surface for creating/switching sessions from a Telegram-triggered command. Resolve this first before deepening command UX work.
- Keep skill-command generation in one place so the published menu, `/skills`, `/status`, and parser all use the same source of truth.
- Prefer a real publication-status snapshot over recomputing user-visible status from partial state.
- Keep `/new_session` and `/clear` sharing the same session-reset core, but preserve their different Telegram cleanup semantics.

## Task Breakdown

- [x] Task 1: Add command-model helpers for fixed + dynamic Telegram commands
  - Acceptance: runtime can compute publishable commands and skipped skills with reasons
  - Verify: targeted tests for aliasing/filtering
  - Files: `pi-extensions/telegram/index.ts`, `pi-extensions/telegram/types.ts`, new helper if needed

- [x] Task 2: Add Telegram bot command publication support
  - Acceptance: startup/reload updates Telegram’s published slash-command menu
  - Verify: integration test or transport mock
  - Files: `pi-extensions/telegram/transport.ts`, `pi-extensions/telegram/index.ts`

- [x] Task 3: Implement session reset flow for `/new_session` and `/clear`
  - Acceptance: Telegram can create/attach a fresh session and best-effort clean remote history
  - Verify: manual sandbox validation + tests where possible
  - Files: `pi-extensions/telegram/index.ts`, `pi-extensions/telegram/telegram-provider.ts`, maybe `state.ts`

- [x] Task 4: Implement dynamic `/skill_<name>` routing
  - Acceptance: skill commands work both with inline task text and next-message arming
  - Verify: parser/routing tests and manual check
  - Files: `pi-extensions/telegram/telegram-provider.ts`, `pi-extensions/telegram/state.ts`, `pi-extensions/telegram/types.ts`

- [x] Task 5: Implement `/skills`, `/status`, `/refresh`, `/context`, `/help`, and attach warnings
  - Acceptance: user can inspect current command/skill availability from Telegram
  - Verify: output-focused tests and manual check
  - Files: `pi-extensions/telegram/index.ts`, `pi-extensions/telegram/telegram-provider.ts`

- [x] Task 6: Harden, document, and verify
  - Acceptance: docs align with implementation and checks pass
  - Verify: `bun run check`
  - Files: `pi-extensions/telegram/*.md`, related TS files
