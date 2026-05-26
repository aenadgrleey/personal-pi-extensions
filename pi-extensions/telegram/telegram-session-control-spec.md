# Spec: Telegram Session Control v1 for Pi

Status: implemented v1.

## Assumptions I'm Making

1. Telegram session control is an additional remote-control surface for Pi, not a full transcript mirror.
2. The active local Pi session remains the source of truth for runtime state, session lifecycle, and skill availability.
3. The main v1 user value is remote session reset plus skill-first task launching from Telegram.
4. The Telegram command surface for v1 should be a fixed core set plus dynamic skill commands discovered at runtime.
5. Telegram-visible bot commands must be refreshed on each extension reload or Pi restart so the published command list is never a stale static snapshot.
6. `/new_session` and `/clear` should both exist in v1. Both start a fresh Pi session, but only `/clear` should best-effort wipe the bot-managed Telegram chat history; `/new_session` should keep the chat and just post the fresh-session banner.
7. “Clear all messages” means: make the active Pi conversation start fresh and best-effort clear bot-managed Telegram chat history in the direct chat; it does not require deleting archived session files from disk.
8. Skills should feel first-class from Telegram, but only skills with safe Telegram command aliases should become published slash commands.
9. If a skill alias cannot be published safely because of Telegram limits or collisions, the bot should still expose that skill through `/skills` and warn when Telegram is attached.
10. Remote reset should not depend on a one-time local bootstrap command; the extension should derive a fresh command-capable context from the active Pi runtime when Telegram asks for `/new_session` or `/clear`.

## Objective

Build a first version of Telegram session control for Pi so the user can reset work and launch skill-oriented tasks remotely without needing the full local UI.

The v1 experience should let the user:

- start a fresh Pi session from Telegram
- clear the current Pi + Telegram conversation surface from Telegram
- see which skills are currently available to the active Pi runtime
- invoke publishable skills directly as Telegram slash commands
- understand when some skills are available in Pi but not publishable as Telegram commands

Success means Telegram becomes a lightweight remote cockpit for session reset and skill-driven prompting, while the local Pi session remains authoritative.

## Non-Goals

- mirroring the full Pi transcript into Telegram
- exposing arbitrary local Pi slash-command passthrough in v1
- exposing raw tool calls or raw tool results in Telegram
- supporting arbitrary shell command execution from Telegram
- deleting historical Pi session files from disk as part of `/clear`
- guaranteeing deletion of every Telegram message if the Bot API or chat state prevents it
- making every possible skill publishable as a Telegram slash command regardless of length or collisions

## Tech Stack

- TypeScript Pi extension code in `pi-extensions/telegram/`
- existing Pi session lifecycle hooks and Telegram ownership model
- Telegram Bot API for:
  - inbound command/text updates
  - outbound status/help replies
  - published bot command updates (`setMyCommands` or equivalent)
  - best-effort message deletion / chat cleanup
- Pi skill discovery from the current runtime-visible skill inventory
- existing Telegram integration state for ownership, pending messages, and remote cleanup

## Commands

Build: `bun run tsc`
Lint: `bun run lint`
Format: `bun run format`
Full verification: `bun run check`

User-facing Telegram command model for v1:

### Fixed core commands

- `/new_session`
- `/clear`
- `/skills`
- `/status`
- `/refresh`
- `/context`
- `/detach`
- `/help`

### Dynamic skill commands

Generated from currently available runtime skills using the Telegram-safe pattern:

- `/skill_<sanitized_name>`

Examples:

- `tdd` → `/skill_tdd`
- `commit` → `/skill_commit`
- `write-a-skill` → `/skill_write_a_skill`
- `spec-driven-development` → `/skill_spec_driven_development`

Sanitization rules:

- lowercase only
- replace `-` with `_`
- remove unsupported characters
- prepend `skill_`
- publish only if the final command is valid for Telegram and fits the 32-character limit
- do not publish if the alias collides with another generated alias or fixed command

Command behavior:

- `/new_session`
  - creates a fresh Pi session
  - attaches Telegram ownership to the new session
  - resets pending remote interaction state
  - clears the active user-visible Pi conversation by moving to the new session
  - keeps existing bot-managed Telegram chat history intact
  - posts the fresh-session banner
- `/clear`
  - starts a fresh Pi session reset flow
  - best-effort clears bot-managed Telegram history for the direct chat
  - keeps Telegram visually empty after cleanup (no fresh-session banner or attach warning)
- `/skills`
  - shows currently available skills
  - distinguishes:
    - publishable skill commands
    - available-but-not-published skills
  - includes the reason when a skill is not published (too long, collision, unsupported alias)
- `/skill_<name> <task...>`
  - immediately sends a Pi user request equivalent to “use skill `<skill-name>` for: `<task>`”
- `/skill_<name>` without trailing task text
  - arms that skill for the next incoming normal Telegram message, or explicitly prompts for the task
- `/status`
  - reports current ownership / attachment status and command-refresh status
- `/refresh`
  - republishes the Telegram bot command menu from the current Pi runtime-visible command/skill inventory
  - reports the latest publish counts and any Telegram publish error
- `/context`
  - reports current Pi context leftovers for the active branch, including estimated usage and branch bookkeeping counts
- `/detach`
  - detaches Telegram ownership from the current active owner session
- `/help`
  - explains the fixed command set, skill-command pattern, and current limitations

## Project Structure

Likely implementation areas:

- `pi-extensions/telegram/index.ts`
  - register fixed Telegram control commands and lifecycle hooks
  - trigger command-list refresh on load/reload
  - capture the active `ExtensionRunner` and derive fresh command contexts for remote session reset
- `pi-extensions/telegram/telegram-provider.ts`
  - parse inbound Telegram commands and normal text
  - route skill-command invocations into Pi session input
  - perform remote cleanup / reset messaging
- `pi-extensions/telegram/transport.ts`
  - add Telegram Bot API helpers for published command updates and any required cleanup calls
- `pi-extensions/telegram/state.ts` and `pi-extensions/telegram/types.ts`
  - persist armed-skill state, command publication metadata, and reset-related bookkeeping as needed
- `pi-extensions/telegram/*.md`
  - keep the existing interaction spec separate from this session-control spec until implementation lands

## Code Style

Prefer explicit command descriptors over scattered string handling.

```ts
const command = {
	id: "skill_tdd",
	kind: "skill",
	skillName: "tdd",
	description: "Run the tdd skill",
	published: true,
};

if (command.kind === "skill") {
	routeSkillCommand(command.skillName, trailingText);
}
```

Conventions:

- keep the fixed command surface explicit and reviewable
- keep skill discovery dynamic and sourced from the runtime-visible skill inventory
- keep Telegram-specific alias generation in one place
- record why a skill was not published so `/skills` and attach warnings can explain it
- treat `/new_session` and `/clear` as distinct user intents with different Telegram-side cleanup behavior
- prefer best-effort cleanup with clear user messaging over pretending cleanup is guaranteed

## Testing Strategy

Use layered verification.

### Unit tests

- Telegram-safe skill alias generation
- filtering and collision detection for dynamic skill commands
- 32-character-limit handling
- fixed-command + dynamic-command merge behavior
- parsing `/skill_<name>` with and without trailing task text
- mapping skill commands into Pi user messages or armed-skill state
- command publication payload generation for Telegram
- warning generation for non-publishable skills
- reset command intent mapping for `/new_session` and `/clear`
- fixed-command publication including `/refresh` and `/context`

### Integration-style tests

- extension startup/reload refreshes the published Telegram command list
- changed available skills lead to changed published Telegram commands after reload
- `/new_session` transfers Telegram ownership to a fresh session and resets remote state without wiping Telegram chat history
- `/clear` transfers Telegram ownership to a fresh session and best-effort clears bot-managed Telegram chat history
- best-effort Telegram history cleanup during `/clear` does not break session creation when deletion partially fails
- a dynamic skill command launches a skill-oriented Pi request into the active session
- an armed skill survives long enough for the next Telegram message and then clears predictably
- `/skills` accurately reports published vs non-published skills
- `/context` reports the active Pi branch usage summary without exposing raw tool chatter

### Manual validation

- attach Telegram to a sandbox Pi session and confirm the bot command menu updates after restart/reload
- verify a newly added or removed skill changes the published command list after restart/reload
- trigger `/new_session` from Telegram and confirm the active local Pi session switches to a fresh conversation while Telegram history remains visible
- trigger `/clear` and confirm the active local Pi session switches to a fresh conversation while bot-managed Telegram history is best-effort cleared
- invoke a short skill command like `/skill_tdd ...` and confirm the resulting Pi request is skill-oriented
- confirm at least one too-long skill appears in `/skills` with a not-published reason and that attach warns about it

## Boundaries

### Always do

- keep the local Pi session authoritative
- refresh Telegram published commands on each reload/restart
- generate skill commands from the currently available runtime skill inventory
- publish only Telegram-valid, collision-free, length-safe skill aliases
- warn when some available skills could not be published as commands
- make `/skills` the source of truth for the full current skill inventory visible to Telegram
- best-effort clear bot-managed Telegram history on reset
- preserve a working new session flow even if Telegram cleanup is partial

### Ask first

- adding generic arbitrary command passthrough after v1
- allowing destructive deletion of archived Pi session files from disk
- auto-shortening or inventing opaque aliases for long skills
- supporting per-skill custom argument schemas in Telegram
- broadening Telegram control from one DM chat to multiple operators or chats

### Never do

- keep a stale static internet-visible Telegram command list across restarts
- silently publish a command alias that maps ambiguously to multiple skills
- claim a Telegram cleanup fully succeeded if deletion was only partial
- make Telegram the only place a skill-oriented request can be launched
- expose raw tool chatter in the remote command UX by default

## Success Criteria

1. Telegram can start a fresh Pi session with `/new_session`.
2. Telegram can start a fresh Pi session and best-effort wipe bot-managed Telegram chat history with `/clear`.
3. A reset creates a fresh active Pi session, reattaches Telegram to it, and resets remote interaction state.
4. Only `/clear` attempts best-effort cleanup of bot-managed Telegram chat history.
5. The bot publishes a fixed core command set plus dynamic skill commands on every reload/restart.
6. Dynamic skill commands are generated from the current runtime-visible skill inventory rather than a static hardcoded list.
7. Publishable skills become real Telegram commands using the `/skill_<name>` pattern.
8. Non-publishable skills still appear in `/skills` with a reason.
9. Telegram warns on attach when some available skills could not be published.
10. Telegram exposes `/context` for the active Pi branch usage/leftovers summary.
11. A skill command with trailing text immediately launches a skill-oriented Pi request.
12. A skill command without trailing text supports a next-message flow or explicit follow-up prompt.
13. The v1 surface remains a curated remote-control UX rather than generic command passthrough.

## Risks and Mitigations

### Risk: Telegram command limits hide too many skills
Mitigation: publish only safe aliases, make `/skills` list everything, and warn on attach when some skills are not command-addressable.

### Risk: dynamic command publication drifts from the real runtime state
Mitigation: derive commands from the same skill inventory Pi currently exposes and refresh on every reload/restart.

### Risk: `/clear` implies destructive history deletion beyond what v1 should do
Mitigation: define reset in terms of a fresh active session plus best-effort Telegram cleanup, not deletion of archived local session files.

### Risk: skill command parsing becomes ambiguous
Mitigation: keep the published alias map explicit, collision-checked, and stored with publish metadata.

### Risk: Telegram cleanup failures block the primary reset flow
Mitigation: session creation and reattachment win; cleanup errors are reported but non-fatal.

## Open Questions

No open questions right now.
