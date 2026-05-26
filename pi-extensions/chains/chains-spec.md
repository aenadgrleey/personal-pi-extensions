# Chains Spec

Status: draft, spec-only. Runtime is intentionally not implemented yet.

## Scope

This document is the canonical source of truth for the chains feature contract.
It defines chain file layout, execution node shape, data passing, review, tool policy,
step skill injection, and the required user-visible execution model.
It does not prescribe low-level implementation details, but it does prescribe the final behavior the runtime must expose.

## Canonical storage layout

- Chains are stored as one file per chain in `.pi/chains/<name>.yaml`.
- The filename without `.yaml` is the chain name.
- No output aliasing is supported; step results are referenced by step `id`.

## Top-level shape

```yaml
version: "1"

steps:
  - id: scout
    agent: scout
    task: |
      Scout the codebase for {{input}}
    output:
      kind: findings
    tools:
      mode: allowlist
      allow: [read, bash]
    skills:
      - name: notify-me
        instruction: Notify the user on success or failure.

  - id: plan
    agent: planner
    task: |
      Files: {{steps.scout.files}}
      Insights: {{steps.scout.insights}}
    output:
      kind: plan
    review: true
```

## Execution model

Chains are orchestrated through the active pi session.
They are not modeled as isolated spawned subagent sessions/processes whose work is then summarized back into the main UI.

Required semantics:

- chain execution runs as an orchestration layer on top of the active session
- the active chain selects what the current step is, what instructions apply, and what tool/skill constraints apply for that step
- the first user prompt after activation is the chain's canonical `INPUT`
- later user prompts stay in the active session as steering/continuation context; they may influence subsequent turns, but they do not replace `{{input}}`
- the actual assistant/tool activity for a step must be visible in the main pi session UI as native activity
- tool calls and tool results produced while executing a chain step must not be hidden behind synthetic summary-only chain messages
- chain-specific UI may add lightweight markers/HUD state, but it must not replace or suppress normal visible tool execution for the active step
- chain orchestration markers should be visible and session-logged in order, so later analysis can reconstruct chain start, step start, step completion, review pauses/decisions, loop retries, interruptions, and completion
- checkpointing and resume are session-based; the chain runtime restores orchestration state from the pi session

This means the chain runtime should behave like a session manager / orchestration layer, not like a subagent spawner.

## Node types

The spec supports these executable nodes:

### Agent step

```yaml
- id: implement
  agent: worker
  task: |
    Implement {{input}}
  output:
    kind: report
```

Fields:

- `id`: unique step identifier within the chain
- `agent`: target agent name
- `task`: prompt/template for that agent
- `output`: declared predefined output kind
- `tools`: optional tool policy for the step agent
- `skills`: optional extra skills for the step agent
- `review`: optional boolean review gate

### Loop block

```yaml
- id: implement-loop
  loop:
    max_iterations: 3
    steps:
      - id: worker
        agent: worker
        task: Apply feedback: {{prev.feedback}}
        output:
          kind: report
      - id: reviewer
        agent: reviewer
        task: Review current result
        output:
          kind: review
  review: true
```

A loop block may itself have `review`, but reviews are not allowed inside the loop body.
Only the loop node itself may declare review.

Loop semantics are review-driven:

- the loop body is expected to end in a `review`-style outcome
- if that outcome is `redefine`, the loop continues with the new feedback until `max_iterations` is reached
- if that outcome is `continue`, the loop stops successfully

## Inputs and outputs between agents

The chain spec uses predefined output kinds. Users do not declare schemas.

### Rules

- A step declares `output.kind`.
- `output.kind` selects a built-in payload contract owned by the spec.
- The harness/runtime provides the step agent with the corresponding return tool contract.
- The next step receives the normalized result of previous steps through interpolation.
- No output aliasing is supported; step `id` is the stable reference key.

### Output kinds

#### `text`

```json
{ "text": "..." }
```

#### `findings`

```json
{
  "summary": "...",
  "files": ["..."],
  "insights": ["..."]
}
```

#### `plan`

`plan` must match the existing `plan_preview` shape exactly:

```json
{
  "title": "Short title",
  "phases": [
    {
      "name": "Phase name",
      "steps": ["Step 1", "Step 2"]
    }
  ],
  "context": "Optional background context"
}
```

#### `review`

`review` output should match the user review result shape.

```json
{
  "decision": "continue",
  "summary": "..."
}
```

or

```json
{
  "decision": "redefine",
  "summary": "...",
  "feedback": "..."
}
```

#### `report`

```json
{
  "summary": "...",
  "artifacts": ["..."],
  "notes": ["..."]
}
```

## Interpolation

Supported interpolation references:

- `{{input}}` — canonical chain input from the first user prompt
- `{{prev}}` — full previous result object
- `{{steps.<id>}}` — full result object for a named step
- `{{steps.<id>.<field>}}` — field access inside a named step result

Interpolation is the only step-input mechanism. Step input is not auto-injected by the harness beyond these references.
All interpolation references must be fully validated before the chain is run, ideally at chain activation/initialization time.

Examples:

- `{{steps.scout.files}}`
- `{{steps.plan.phases}}`
- `{{steps.review.decision}}`

## Review

If `review: true` is declared, review is required.

A review prompt should be handled as a continuation request, not as a generic approval dialog.
The user review result should express either:

- `continue` — accept the current result and proceed
- `redefine` — provide feedback that changes or refines what should happen next

The spec only declares a boolean flag, not the low-level internal mechanics.
However, the user-visible review flow is part of the contract: review is a continuation request inside the active chain session, not a detached approval flow outside normal chain execution.

Example:

```yaml
review: true
```

Review may be attached to:

- an agent step
- a loop block

Review is not allowed on steps inside a loop body.

## Tools

`tools` defines execution permissions for the step agent.

Example:

```yaml
tools:
  mode: allowlist
  allow: [read, bash, edit, write]
```

This spec currently models tool access declaratively, but does not go deep into implementation details.
`tools` is declared only on individual steps.

The final runtime behavior must still preserve normal visible tool execution in the main pi UI for the active step.
Tool restrictions may change per step, but they must not force the runtime into a hidden child-session UX.

## Skills

A step may inject additional skills into the step agent.

Example:

```yaml
skills:
  - name: notify-me
    instruction: |
      Notify the user when the task succeeds or fails.
      Keep the message short.
```

Semantics:

- the named skill is made available to the agent executing that node
- `instruction` is optional extra guidance scoped to that node
- skill references are by name
- if the same skill appears more than once for a step, it is deduplicated by name
- if a referenced skill is missing, chain validation fails before the run starts
- this is intended for behaviors such as notifying the user, using repo-specific workflows,
  or integrating future approval / messaging patterns

## Session persistence and resume

Chain state should be persisted as part of the pi session so an active chain can be resumed when that pi session is reopened.

Persisted chain state should include at least:

- active chain name
- whether chain mode is active
- chain state such as `selected-awaiting-input`, `running`, `waiting-review`, `interrupted`, or `completed`
- current active step id
- completed step outputs
- loop iteration counters
- queued user messages
- pending review context
- enough step/orchestration metadata to restore the HUD and resume the chain in the active session model

Resume is checkpoint-based.
The system should restore orchestration state, progress, and user-facing chain mode state, but it should not attempt to resume an in-flight model generation or tool call in the middle of execution.
If the previous pi session ended while a chain step was actively running, the chain should be restored as `interrupted` and continue from the last checkpoint rather than pretending the step is still running.

## Validation rules

The following must be validated before a chain run starts, ideally at chain activation/initialization time:

- malformed YAML or invalid node shape
- duplicate step ids
- unknown output kind
- invalid interpolation reference
- missing referenced step id
- invalid field access for a referenced output kind
- review declared inside a loop body
- missing referenced skill

These validation errors are surfaced together at one validation point before execution begins.

## Final UX/runtime contract

The final result should look like this:

- the user activates a chain and stays in the same pi session
- the next user prompt starts the chain and becomes the canonical `INPUT`
- follow-up user prompts steer the active session without replacing that `INPUT`
- the active step is visible in a chain HUD/status area
- the assistant response for the active step appears in the normal transcript
- any tool calls made during that step appear in the normal transcript/UI just like ordinary pi tool calls
- tool results also appear natively in the normal transcript/UI
- chain-specific messages, if any, are lightweight orchestration markers rather than replacements for normal assistant/tool visibility
- those orchestration markers are also persisted in the session transcript in order so the run can be audited later
- if the chain pauses for review, the user sees a continue-or-redefine prompt tied to the active chain state
- if the chain is interrupted and the session is reopened, the chain HUD and orchestration state are restored from checkpoints

## Deferred items

These are intentionally out of scope for this draft:

- action hooks / declarative side effects
- exact internal API shapes used to steer the active session
- exact return tool API naming and transport details
- the full runtime implementation of loop execution
