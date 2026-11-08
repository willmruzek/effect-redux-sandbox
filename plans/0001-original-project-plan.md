# 0001: Original project plan (reconstructed)

**Status: IMPLEMENTED**

## Historical note

This document reconstructs the initial project direction from the earliest
conversation checkpoints. It is not a recovered verbatim copy of an original
plan. The stages below summarize decisions made as the project began, rather
than implying that every stage was specified in the first request.

The starting request was:

> setup pnpm monorepo. apps/ packages/ tools/ (shared lint, ts)
>
> Two packages: redux-first, effect-first

The two examples were then moved into `apps/` and converted into barebone
TanStack Start applications.

## Goal

Build comparable Redux-first and Effect-first applications in one workspace.
Use the same small demonstration to explore how each approach handles state,
typed actions, asynchronous work and React integration. Extract reusable
mechanics into packages instead of tying them to the demonstration.

## Place in the sequence

This is the foundation: workspace, matching application shells, core stores and
React integration. [Base CRUD](0002-base-crud.md) builds on that foundation by
replacing the counter demonstration with a relational tracker.
The numbered plans form an incremental design narrative reconstructed from the
project's evolution, not an exact replay of every implementation decision.

## Initial implementation stages

### 1. Workspace and application shells

- Set up pnpm with `apps/`, `packages/` and `tools/`.
- Share lint and TypeScript configuration.
- Place `redux-first` and `effect-first` under `apps/`.
- Give both apps minimal TanStack Start routes and development/build scripts.
- Validate the workspace with lint, type-check and builds.

### 2. Redux-first counter

- Add Redux Toolkit state and a client-only React provider.
- Demonstrate synchronous counter actions and asynchronous work.
- Allow Effects to be dispatched through middleware.
- Give dispatched Effects access to the receiving store's state and dispatch
  through an Effect service.
- Retain Redux Toolkit's default thunk support in this early example.
- Test dispatch results, nested dispatch and per-store isolation.

### 3. Effect-first counter

- Build the matching counter with typed actions and an Effect-based store.
- Support ordinary actions and dispatched Effects, without thunk compatibility.
- Demonstrate delayed updates, browser side effects and visible failures.
- Bind stable store snapshots and subscriptions to React.
- Keep the initial demo client-only; SSR store hydration came later.

### 4. Reusable Effect store and integrations

- Extract a framework-independent, typed store into `packages/effect-store`.
- Keep application reducers and store composition in the app.
- Add middleware and a separate development-only console logger package.
- Extract the React snapshot binding into its own package.
- Use vendored, read-only Effect source as development reference material,
  while importing the installed dependency in application code.
- Test library behavior independently of the counter domain.

## How the project evolved

The counters were subsequently replaced with the same relational project
tracker in both apps. Store-owned entities were projected into TanStack DB
collections for live joins. The tracker initially became a read-only example
with loading, filtering, failures and retry, then gained search, aggregates,
backend pagination, optimistic writes, CRUD and detail navigation.

The roadmap later broadened to scenarios inspired by TanStack Query and RTK
Query. Some advanced reliability mechanisms were implemented and then removed
when the comparison was deliberately narrowed back to core CRUD. Those later
experiments were not part of the initial counter/workspace plan.

For the retained baseline and explicit exclusions, see
[base CRUD](0002-base-crud.md).
Next, [additional layers](0003-additional-layers.md) add optional store and
normalized-request conveniences over that baseline.
Finally, [reduce boilerplate](0004-reduce-boilerplate.md) refines those layers
without expanding the tracker feature set.

## Initial acceptance criteria

- Both apps can run and build independently within the pnpm workspace.
- The same counter behavior is demonstrated through distinct store approaches.
- Effects can read state and dispatch through the appropriate store service.
- Store instances remain isolated and public contracts remain strongly typed.
- Reusable packages do not depend on counter-specific application code.
- Focused tests, workspace type-check, lint and builds pass.

These criteria describe the historical starting point, not the current tracker
feature set or current dispatch internals.
