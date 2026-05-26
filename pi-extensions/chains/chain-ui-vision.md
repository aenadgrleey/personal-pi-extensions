# Chain UI Vision

Status: draft, spec-only.

## Mode model

Pi starts in plain mode by default.

There is no active chain until the user explicitly activates one.

Once a chain is activated, pi enters active-chain mode for the current session.
After selection, the chain should not start immediately. Pi should wait for the next user prompt, and that prompt defines what work should be done.
In active-chain mode, normal user messages are treated as inputs or continuations for the active chain.
The user can explicitly exit chain mode and return to plain pi behavior.

The key UX requirement is that chain execution remains native to the current pi session.
It should not feel like hidden spawned subagents whose work is later summarized back into the main transcript.

## Core UX principles

- Plain pi is the default startup experience.
- Chain mode is explicit, visible, and reversible.
- The user should always know which chain is active.
- Follow-up user messages should continue through the active chain rather than starting unrelated ad-hoc work.
- Review checkpoints should surface clearly to the user as continue-or-redefine prompts.
- Tool execution for the active step should appear natively in the main pi UI.
- Chain-specific UI should orchestrate and annotate, not replace the normal transcript/tool visibility.
- The spec defines behavior, not low-level implementation details.

## Message handling

### No active chain

When no chain is active:

- user messages are handled as normal pi messages
- no chain runtime semantics apply

### Active chain

When a chain is active:

- after chain selection, the next user message is the initial chain-start prompt and becomes the canonical INPUT
- that initial prompt defines the work to be done by the chain
- subsequent normal user messages are routed into the active chain as steering/continuation context
- those follow-up messages can influence later turns, but they do not replace the initial INPUT
- messages act as continuation context for the active chain session
- while the chain is actively running, the user must not be allowed to send a new message immediately; the UI should either block input or queue the message for later delivery
- assistant output for the active step appears in the normal session transcript
- tool calls and tool results for the active step appear in the normal session transcript/UI like ordinary pi activity
- chain UI may add lightweight step markers or chain-state annotations, but it must not hide normal tool execution behind synthetic summary-only messages
- the exact internal queueing/dispatch mechanism is not prescribed here, only the user-visible behavior

## Required visible states

The UI should make these states visible:

- plain mode
- active chain selected
- active chain selected and waiting for initial user prompt
- active chain step highlighted
- chain currently running / busy
- queued user input while the chain is busy
- waiting for required review
- interrupted chain restored from the previous pi session
- chain deactivated / exited
- step-local tool activity visible in the main UI while the chain runs

## Chain HUD

A simple UI element should be shown above the input field while a chain is active.

It should display:

- the active chain
- the chain steps rendered flat in a single row
- the currently active step, highlighted
- whether the chain is waiting for input, running, waiting for review, interrupted, or has queued user input

The HUD is an orchestration surface, not a replacement transcript.
It should not duplicate every tool result if those results are already visible in the normal pi UI.

## Minimal command surface

The spec expects a minimal command surface equivalent to:

- open a chain selector to browse/select/activate a chain
- deactivate / exit chain mode
- resume the previously active chain state when reopening the same pi session

Command names are not the primary concern of this spec, but the state transitions are.

## Session resume UX

When the same pi session is reopened, chain state should be restored from the previous checkpoint.

Expected behavior:

- if no chain was active, pi opens in normal mode
- if a chain was selected but not started, restore the waiting-for-initial-prompt state
- if a chain was waiting for review, restore that review state
- if a chain had completed some steps, restore the HUD and continue from the last saved checkpoint
- if pi was closed while a step was actively running, restore the chain as interrupted rather than pretending that execution is still in flight
- because execution is session-managed, restore orchestration state around the same main transcript/UI rather than presenting restored work as detached subagent output

## Review UX

If a node declares:

```yaml
review: true
```

then the user must be prompted with a continuation request for that node result.

The review result should match the user review outcome shape:

- `continue`
- `redefine` with feedback

This document intentionally does not define the internal review transport/mechanics.
It only defines that review is required and flag-driven.

The model should remain flexible enough for future non-UI providers such as messaging-based approval.

## Final UX snapshot

The intended final result is:

- the user activates a chain
- the next prompt starts chain execution in the same session
- the HUD shows which chain and which step is active
- the assistant responds normally in the main transcript for that step
- any tool calls/results made during that step are visible in the normal pi UI
- follow-up prompts continue to steer the active chain while preserving the original INPUT
- if review is needed, the chain pauses into a continue-or-redefine prompt
- when the chain resumes, it continues in the same visible session flow
- the overall experience feels like native pi with orchestration, not like a hidden worker runner
