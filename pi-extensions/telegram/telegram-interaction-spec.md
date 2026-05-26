# Spec: Multi-Channel Interaction Layer for Pi + Telegram

Status: implemented v1.

## Assumptions I'm Making

1. Telegram is an additional interaction channel, not a replacement for the local Pi session.
2. The first implementation should focus on user-facing interaction moments: questions, plan proposals, decision reviews, work-complete notifications, concise final summaries, and inbound Telegram text or file messages.
3. Raw tool calls and tool results should stay out of Telegram by default.
4. The local Pi session remains the source of truth for runtime state, while one direct Telegram chat acts as the remote steering and notification surface across sessions.
4a. Only one session may actively own Telegram delivery at a time; another session may attach Telegram to itself when the current Telegram-owning session is idle, and the old idle session must stop using Telegram mode.
5. Telegram-side history cleanup should be an explicit action (`/clear` or a fresh attach cleanup), not an automatic side effect of every new Pi session.
6. In-progress Telegram visibility should stay narrow in v1: work completions, a single live working indicator with the latest tool call, blocking questions, and required review moments are in scope; high-level phase-by-phase progress is not.
7. Telegram follow-up messages should be accepted at any time and treated as normal steering input, including when work is already running.
8. Telegram file attachments should be downloaded into a temporary workspace and forwarded into Pi as normal local file inputs.
9. When a Telegram message is a reply to an earlier Telegram message, the forwarded Pi input should include the replied-to message text in quoted form, and that quoted text is the contract.
10. More than one interaction provider may be active at once, and the first valid resolution should win while all providers converge on the same final interaction state.
11. Telegram delivery now includes user-facing setup and control commands (`/telegram-config`, `/telegram-status`, `/telegram-toggle`) with project/global config scope, and these commands sit on top of the shared interaction model rather than reshaping it.
12. Telegram session-control v1 is implemented on top of this layer with remote `/new_session`, `/clear`, `/skills`, `/status`, `/refresh`, `/context`, `/detach`, `/help`, and publishable `/skill_<name>` aliases.

## Objective

Build a shared interaction layer that lets Pi express user-facing interactions once and deliver them through more than one channel.

The first two channels are:

- the current local interactive Pi experience
- one direct-message Telegram experience for remote interaction and notifications

The shared layer should cover these interaction types:

- asking one or more questions
- proposing a phased plan and collecting a keep / save / refine / discard response
- presenting a decision for keep-as-is or revise feedback
- notifying the user when work finishes or needs attention
- accepting remote steering messages at any time and routing them into the same session flow
- accepting Telegram file messages by saving them to a temporary workspace and forwarding their local paths into Pi input
- forwarding reply context from Telegram by quoting the replied-to message text so the agent can see what the new message refers to
- sending concise remote summaries that point the user to the real work result when relevant

Success means an agent can request an interaction by intent, not by transport. The same interaction should be renderable locally and in Telegram, while each channel remains free to present it in a way that fits that environment.

## Non-Goals

- mirroring the full Pi transcript into Telegram
- exposing raw tool traffic in Telegram
- designing the GitHub/GitLab pull request workflow yet
- supporting every Telegram media type in the first pass
- replacing the existing local interaction experience with a Telegram-first workflow
- adding remote artifact sending back out through Telegram

## Tech Stack

- TypeScript Pi extensions in `pi-extensions/`
- existing Pi extension hooks and session lifecycle
- Telegram Bot API transport for outbound messages, inbound replies, and inbound file downloads
- a small persistence layer for pending remote interactions, queued steering messages, attachment metadata, and delivery state
- the existing repository interaction patterns as the behavior baseline
- `tensorfish/pi-telegram` as a transport and queueing reference, not as a source of exact structure

## Runtime config

Prefer a local config file with selectable scope:

- project: `.pi/telegram.local.json`
- global: `~/.pi/agent/telegram.local.json`

Supported keys:

- `token`
- `chatId`
- optional `apiBaseUrl`
- optional `notificationsEnabled`

Environment variables still work as fallback:

- `PI_TELEGRAM_BOT_TOKEN`
- `PI_TELEGRAM_CHAT_ID`
- optional `PI_TELEGRAM_API_BASE_URL`

User-facing setup / control commands:

- `/telegram-config` — interactive setup wizard with project/global scope selection
- `/telegram-status`
- `/telegram-toggle` — toggle notifications for project/global scope
- `/telegram-test` — run a dual-channel ask/plan/review interaction test across Pi and Telegram
- `/telegram-attach` — manually attach Telegram delivery to the current session
- `/telegram-detach` — manually detach Telegram delivery from the active owner session

Runtime behavior notes:

- only one session owns Telegram delivery at a time, tracked via a global owner file under `~/.pi/agent/`
- Telegram stays detached on ordinary session start; after an explicit attach, switching sessions in the same Pi process transfers ownership to the new session automatically
- the shared interaction bridge must be stored in process-global state so jiti-loaded ask/plan/review and Telegram extensions all observe the same active bridge instance
- inbound Telegram messages should show a temporary working reaction until Pi receives the forwarded message or the interaction reply resolves
- `/telegram-attach` can explicitly override the current owner with confirmation when needed, and a newly attached session should start from a clean bot-managed chat view by deleting the previous tracked Telegram messages best-effort
- remote `/new_session` and `/clear` derive a fresh command-capable context from the active Pi runtime, so Telegram reset does not depend on a separate one-time local bootstrap command
- `/telegram-detach` can manually clear the ownership lock when the recorded owner is stale or wedged
- bridge-owned Telegram messages and inbound user messages seen during the session are best-effort deleted on session shutdown
- provider/API HTTP errors are sent to Telegram as explicit error notifications

## Commands

Build: `bun run tsc`
Lint: `bun run lint`
Format: `bun run format`
Full verification: `bun run check`

## Project Structure

The implementation should introduce a feature area with four conceptual parts:

- a shared interaction contract that defines what the agent wants from the user
- a provider coordinator that can fan one interaction out to more than one active provider and close it exactly once
- a local provider that renders the contract using the current interactive Pi behavior
- a Telegram provider that renders the same contract as message-based interactions and turns inbound Telegram messages into Pi-ready inputs

At a high level, the repository will gain:

- shared interaction definitions and lifecycle helpers
- a coordination layer for provider fan-out, first-resolution wins, and state convergence
- local delivery logic that preserves current behavior
- Telegram delivery logic for outbound notifications, inbound replies, inbound files, queued steering input, and pending-action tracking
- tests for interaction normalization, reply handling, attachment intake, queue behavior, and provider-state synchronization
- feature documentation that describes the contract, state model, inbound file flow, and future command surface

## Code Style

Prefer intent-first interaction definitions over channel-specific branching.
A single interaction should be declared once, then handed to a coordinator that selects active providers, tracks resolution state, and keeps all providers synchronized.

```ts
const interaction = {
	kind: "plan",
	title: "Telegram rollout",
	body: "Introduce a shared interaction layer, then add a remote channel.",
	choices: [
		{ id: "accept", label: "Proceed" },
		{ id: "save", label: "Save for later" },
		{ id: "revise", label: "Revise", expectsText: true },
		{ id: "discard", label: "Discard" },
	],
	visibility: "user-facing",
};

const result = await interactionHub.present(interaction, {
	providers: ["local", "telegram"],
	notificationPolicy: "remote-summary-only",
	resolutionPolicy: "first-valid-response-wins",
});
```

Conventions:

- name abstractions after user intent, not UI widgets
- keep provider adapters thin and keep decision logic in shared code
- store enough metadata to map an inbound Telegram reply back to the interaction it resolves
- represent inbound Telegram files as saved local artifacts plus structured metadata about their source
- represent Telegram reply-to relationships by injecting the replied-to message text as explicit quoted context rather than relying on the model to infer it from free text alone
- feed local and Telegram input into one shared message queue so simultaneous replies are treated as normal session input, not as a special case
- update all active providers when an interaction is resolved so they agree on whether it was completed locally or remotely
- separate user-visible content from transport-specific formatting

## Testing Strategy

Use layered verification.

### Unit tests

- interaction normalization and validation
- choice mapping and free-text response handling
- pending interaction state transitions
- reply correlation between outbound prompt and inbound answer
- attachment intake, temp-file persistence, and forwarded file metadata
- quoted reply-context forwarding from Telegram into Pi input
- queue behavior for follow-up Telegram steering messages during active work
- provider-state synchronization after local or remote resolution
- notification policy behavior, especially suppression of raw tool chatter

### Integration-style tests

- local provider preserves the current interaction outcomes
- Telegram provider converts the same interaction into message-friendly prompts and responses
- Telegram file messages are downloaded to temp storage and forwarded into Pi with usable local paths
- Telegram reply-to messages are forwarded with quoted reply context the agent can consume
- long content is split or summarized safely for Telegram limits
- simultaneous local and Telegram messages are handled through the same queue semantics
- once one provider resolves an interaction, the other providers reflect that resolved state correctly
- cancelled, timed-out, or stale remote interactions resolve predictably

### Manual validation

- run a local Pi session with the local channel only and confirm no visible regression
- run a Pi session with Telegram enabled in a sandbox chat and confirm question / plan / review / work-end flows
- verify that a completed run produces a concise notification without raw tool traces

## Boundaries

### Always do

- keep the local Pi session as the authoritative runtime state
- route user-facing interactions through the shared contract before provider-specific rendering
- preserve existing interaction semantics while moving them onto the new abstraction
- hide raw tool calls and raw tool results from Telegram by default
- persist pending remote-interaction metadata so replies can be matched safely
- accept Telegram steering messages at any time and place them into the same queue model used for other inbound session input
- download Telegram files into a temporary directory before forwarding them into Pi
- include quoted reply context when forwarding Telegram reply messages into Pi
- reset bridge-owned Telegram message history only for explicit cleanup flows such as `/clear` or fresh attach, and treat deletion as best-effort
- mark every outbound interaction with shared state so all active providers can tell whether it is still pending or already resolved, and where it was resolved first

### Ask first

- expanding from one direct Telegram chat to multiple chats or multiple human approvers
- storing long-lived bot credentials or chat identity in a new location
- introducing new runtime dependencies beyond what the repo already needs
- broadening inbound file support beyond the first pragmatic file flow
- changing the local transcript behavior beyond what is required for the abstraction

### Never do

- auto-approve a question, plan, or review interaction just because Telegram is unavailable
- make Telegram the only place where a pending interaction can be resolved
- leak sensitive tool output or internal execution noise into Telegram by default
- hard-wire the interaction contract to Telegram-specific message structures
- require future notification toggles to rewrite the interaction model

## Success Criteria

1. Existing user-facing interaction flows in this repo can be expressed through one shared interaction contract.
2. The local channel preserves the current user experience semantics after the refactor.
3. A Telegram provider can deliver:
   - question prompts
   - plan proposals
   - keep-or-revise decision prompts
   - work-end notifications
   - concise final summaries
4. Telegram supports follow-up steering messages at any time, including while work is already running.
5. Telegram file messages are saved into a temporary directory and forwarded into Pi as usable local file inputs.
6. Telegram reply-to messages are forwarded with quoted reply context so the agent can understand what the user is responding to.
7. Telegram replies can resolve the corresponding pending interaction and return a structured result back into Pi.
8. Simultaneous local and Telegram input is handled through one queueing model instead of a separate conflict path.
9. When more than one provider is active for the same interaction, the first valid resolution wins and the other providers are updated to reflect that final state.
10. Telegram output excludes raw tool calls and raw tool results by default, aside from a lightweight live working indicator that can mention the latest tool name/call; broader in-progress remote visibility is still limited.
11. Explicit cleanup flows such as `/clear` or fresh attach can best-effort reset the remote conversation view without breaking normal new-session continuity.
12. The design supports opt-in setup and enable/disable commands for Telegram delivery without needing to redesign the shared interaction contract.
13. The design is compatible with PR-oriented workflows where the user mainly needs notifications, approvals, and short summaries rather than full execution transcripts.

## Risks and Mitigations

### Risk: local refactor changes current behavior
Mitigation: treat the current local interaction semantics as the baseline contract and verify parity before adding Telegram-specific features.

### Risk: Telegram turns interaction into a brittle chat parser
Mitigation: keep a structured pending-interaction record with explicit allowed choices, fallback free-text capture, quoted reply context, and clear resolution rules.

### Risk: file forwarding becomes unreliable or unsafe
Mitigation: always materialize inbound Telegram files in a controlled temp location, keep source metadata, and forward only local paths plus structured attachment context into Pi.

### Risk: noisy remote updates become distracting
Mitigation: keep Telegram progress narrow in v1 and limit it to a single live working indicator, completions, blocking questions, and required review moments.

### Risk: remote and local responses compete
Mitigation: make the local session authoritative while still feeding both channels into one shared queue and enforcing a first-valid-resolution-wins rule for interactive prompts.

### Risk: bridge history cleanup is imperfect
Mitigation: treat deletion as best-effort and define a visible session-reset marker as the fallback clean-start mechanism.

## Open Questions

No open questions right now.
