# effect-redux-sandbox

A pnpm workspace containing two barebone TanStack Start applications and shared tooling.

## Workspace layout

- `apps/redux-first/` — Redux-first TanStack Start app
- `apps/effect-first/` — Effect-first TanStack Start app
- `packages/effect-store/` — synchronous custom store and Effect-facing service
- `packages/effect-store-react/` — React `useSyncExternalStore` binding
- `packages/effect-store-logger/` — synchronous plain-action console logger
- `packages/effect-store-toolkit/` — Immer slices and independent request engine
- `packages/redux-toolkit/` — Redux Toolkit-backed slices and request engine
- `packages/gql-api/` — HTTP transport, canonical keys and entity utilities
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

Root build, test and type-check commands build shared packages before consumers.
For a package-only build, use
`pnpm --filter './packages/*' --recursive run build`.

## Reusable store and request contracts

The custom store commits ordinary actions synchronously and exposes lazy
Effect-valued state reads and internal dispatch. External Effect dispatch uses
an application-supplied runtime and returns a Promise. The application owns
runtime disposal; reducers and snapshots contain data only, never Effects,
functions, Promises or other resources.

Both request toolkits independently implement normalized reads and mutations.
Only transport, canonical variable identities and entity utilities are shared;
there is no shared cross-store request engine.

`createRequestApi` generates operation action creators and a metadata reducer.
Install that reducer once. Optional operation domain reducers own normalization,
merge policy and application notices; compose them before the API metadata
reducer so ownership guards inspect the pre-transition state. Missing reducer
installation fails before transport.

Matching pending reads share execution and outcome per operation definition,
receiving store service and canonical variable key. The first caller supplies
transport options and execution context. Runs remain lazy; external Promise
identity is not guaranteed. Cancellation stops the worker only after all waiters
cancel. Completed outcomes are not cached. Duplicate pending mutations skip.

Standalone request lifecycles remain separate: apps explicitly register their
guarded started/confirmed/failed cases. Optional optimistic field helpers update
or restore the owned field; domain validation and workflows remain app-owned.

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
