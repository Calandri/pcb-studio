# Contributing

Thanks for helping out. A few ground rules so the project stays easy to work on.

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in the values
pnpm dev
```

## Before you open a PR

- `npx tsc --noEmit` passes with zero errors.
- `pnpm lint` passes.
- `pnpm build` passes.
- Comments and docs are written in **English**. The product UI text stays in
  Italian for now — that is intentional, not a mistake to "fix".
- No secrets, tokens, or `.env` files in commits — ever. `.env.example` is the
  place to document new variables (names and comments only, never values).

## How the codebase is shaped

- `src/app` — pages and API routes.
- `src/lib` — the engine: compilation, autorouting, DRC, placement, manual
  editing, the LLM agent. Engine code has no React in it and is testable in
  isolation.
- `src/components` — the studio, board and schematic canvases, editor UI.

Two architectural rules that PRs must respect:

1. **The tscircuit code is the project.** Every change to a board goes through
   `write_file` + compile. The Circuit JSON is a result, never an editing
   surface.
2. **The LLM is the orchestrator.** Application code never decides the agent's
   flow: no client-side continuation heuristics, no per-feature if/else about
   "what happens next". New assistant capabilities are expressed as tools,
   context lines, or docs — not as flow logic in glue code.

## Commit style

Short, imperative, Italian or English both fine, with a scope prefix:
`feat(sbrogliatura): …`, `fix(ui): …`, `docs: …`. No `Co-Authored-By` lines.
