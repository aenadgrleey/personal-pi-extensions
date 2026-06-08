# personal-pi-extensions

TypeScript extensions for the pi coding agent.

## Entry point

Read [`rtango-manifest.md`](./rtango-manifest.md) for the exported skills and collections inventory.

## What this repo provides

- TypeScript utilities and extensions in `pi-extensions/`
- checks in repository-root `checks.yaml` (with `.pi/checks.yaml` compatibility) and agent config in `.pi/`
- reusable skills and workflows in `skills/` (including repo-local skills like the RUG delegation skill)
- shared interaction components for interactive extension flows
- a re-exported `@gotgenes/pi-subagents` sub-agent orchestration extension
- a re-exported `@howaboua/pi-codex-conversion` Codex tool/prompt adapter

## Setup model

Keep responsibilities separate:

- use `rtango` for shared skills and instructions, and `skills/` for repo-local skill packages when needed
- use `pi install` for Pi package assets (extensions and checks)
- include `checks.yaml` in the setup plan when the target repo uses Pi; keep `.pi/checks.yaml` only when compatibility is needed
- keep local Pi preferences/secrets as local setup, not exported content

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

### Useful exports

- default baseline: `general-agents`, `general-engineering`
- Android: `android-mvi-boilerplate`, `compose-slot-api`
- pi work: `pi-extension-development`, `pi-android-sandbox`
- GitHub flow: `github` collection or `github-pr` plus `yeet`
- GitLab flow: `gitlab` collection or `gitlab-mr` plus `yeet`

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

- If you are not using rtango yet, treat `rtango-manifest.md` as guidance only.
- If you are not running inside pi coding agent, do not try to install pi extensions or checks.
- If a capability is missing, skip that section and say so explicitly.

## Development tooling

```bash
bun run tsc     # type check only
bun run lint    # biome + eslint
bun run format  # auto-fix formatting
bun run check   # full pipeline (tsc → biome → eslint)
```

Package manager is **bun**. Use `bun install`, `bun add`, `bunx` — not npm/npx.

## Repo structure

```
personal-pi-extensions/
├── pi-extensions/           ← TypeScript extensions
├── .pi/                     ← checks and agent config
├── skills/                  ← local skills and package-distributed skill content
├── package.json
├── tsconfig.json
├── biome.json
└── eslint.config.js
```