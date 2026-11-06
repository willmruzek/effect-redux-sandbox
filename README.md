# redux-tanstackdb-effect

A pnpm workspace containing two barebone TanStack Start applications and shared tooling.

## Workspace layout

- `apps/redux-first/` — Redux-first TanStack Start app
- `apps/effect-first/` — Effect-first TanStack Start app
- `tools/eslint-config/` — shared ESLint configuration
- `tools/tsconfig/` — shared TypeScript configuration

## Getting started

Install dependencies with `pnpm install`, then run:

- `pnpm lint` to lint the workspace
- `pnpm typecheck` to type-check both apps
- `pnpm build` to build both apps

Start either app with `pnpm --filter @repo/redux-first dev` or
`pnpm --filter @repo/effect-first dev`.

The Redux-first app creates its Redux Toolkit store only on the client. Redux
Toolkit's default Redux Thunk middleware remains enabled, and dependency-free
Effect values can be dispatched; dispatch returns a promise that rejects if the
Effect fails.

Run tests with `pnpm test`.

## Effect source reference

Following [Effect's agent setup guide](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive),
[repos/effect](repos/effect/) contains a squashed Git subtree of the upstream
Effect repository, pinned to the installed version, `effect@4.1.2`.

[AGENTS.md](AGENTS.md) directs coding agents to read
[Effect's guide](repos/effect/LLMS.md) and inspect upstream source and tests before
writing Effect code. The subtree is reference-only: apps still import the normal
`effect` dependency. It is excluded from application linting and VS Code search,
file watching, Explorer, and auto-import suggestions, but remains tracked by Git.
The workspace package globs and app TypeScript configs do not include `repos/`.

When upgrading Effect, update the dependency and subtree to the same version:

```sh
git subtree pull --prefix=repos/effect \
  https://github.com/Effect-TS/effect.git \
  'effect@<version>' --squash
```

Run this from a clean worktree; subtree updates create a local commit. Update the
version references in this README and AGENTS.md afterward.
