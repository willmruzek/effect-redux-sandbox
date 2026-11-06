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
