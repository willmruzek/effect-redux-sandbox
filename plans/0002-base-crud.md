# 0002: Base CRUD

**Status: IMPLEMENTED**

This is the focused scope adopted after the initial project evolved into a
tracker demo. See [the reconstructed initial plan](0001-original-project-plan.md)
for the project's origins and [boilerplate reduction](0004-reduce-boilerplate.md)
for the subsequent ergonomics stage. See [additional layers](0003-additional-layers.md)
for the implemented optional toolkits and the deferred or removed roadmap.

## Goal

Keep two TanStack Start tracker apps as a focused comparison of Redux and the
Effect-based store. Both apps demonstrate the same CRUD behavior while keeping
their reducers, workflows, runtime ownership and integration tests independent.

## Inherits and adds

Inherit the workspace, application shells, core stores and React bindings from
[0001](0001-original-project-plan.md). Replace the counters with matching
relational trackers and add the CRUD behavior below.
This stage specifies behavior without requiring generated request APIs,
optimistic-field helpers or shared validation extraction. Those implementation
conveniences belong to the subsequent plans.

## Base means behavior, not a particular helper

Normalization, relational projections, filtering/counts/pagination,
SSR/navigation, request-ID/latest-wins protection and reusable core stores
belong to base CRUD in this project. They are not advanced caching features.
The apps currently implement some of this behavior through optional toolkit
helpers; those helpers are a separate architectural layer, not a prerequisite
for defining the base behavior.

## Current baseline

- Task CRUD uses app-server-owned in-memory repositories with deterministic
  seeds, validation, failure controls and reset support.
- GraphQL-only, REST-only and mixed GraphQL-task/REST-people modes are selected
  in the shared UI; transport-specific workflows stay in each app.
- Normalized entities are the source of truth. Request, result and UI metadata
  contain IDs and lifecycle state, not duplicate entity records.
- SSR hydration and list/detail navigation share the app store. Request IDs and
  latest-wins guards prevent stale responses from replacing current results.
- Task filtering, sorting, search, cursor pagination and local page navigation
  are server/client responsibilities as appropriate to the existing query.
- Task creation, edits, reassignment, person rename and deletion have visible
  loading, success and failure behavior with explicit retry where applicable.
- TanStack DB is a read-only relational projection over store-owned entities.
- Reusable core store primitives support typed actions, synchronous transitions,
  subscriptions and app-owned runtime composition without requiring toolkit
  lifecycle or query helpers.
- Basic optimistic edits, authoritative confirmations, visible rollback/errors
  and explicit refresh after successful writes remain part of CRUD.
- Task edit/deletion eligibility is checked before starting writes; apps surface
  failures and the backend retains authoritative input validation. Consolidating
  repeated checks into shared pure validators is a later ergonomics step.

## Guardrails

- Keep app-specific reducers, workflows, runtime ownership and integration
  tests in their respective apps. Share UI, domain types, transport utilities
  and independently consumable store primitives where already appropriate.
- Reducers return data only. Effects, Promises, fibers and callbacks stay in
  workflows or outside the store.
- Plain actions remain synchronous; do not add global dispatch queues or
  asynchronous action middleware.
- Preserve normalized state, store-only SSR hydration and zero duplicate
  initial browser fetches.
- Keep server mutations and their validation consistent across GraphQL and REST.
- Treat the in-memory backend as demo infrastructure: browsers using the same
  app server share data; reset or server restart restores the seed.

## Beyond base CRUD

The [additional layers plan](0003-additional-layers.md) records which optional
helpers are implemented and which broader features are deferred or were
deliberately removed. That record does not authorize restoring them.

## Out of scope

The comparison is intentionally limited to the baseline above. Do not add these
as implicit requirements or expand the implementation without a specific
request:

- Per-field revision conflict protocols or conflict-resolution UI.
- Idempotency receipts, retry-safe non-idempotent writes or deletion tombstones.
- Atomic refresh of previously loaded multi-page windows.
- Request sharing, conditional/time-based freshness or automatic background
  refresh, polling and prefetching.
- Server subscriptions/live updates, cross-tab synchronization or dependent
  multi-endpoint workflows.
- Authentication, user sessions, durable storage, offline queues or sync.
- Full feature parity with TanStack Query or RTK Query.

These exclusions define the baseline, not every later approved stage.
[0006](0006-share-in-flight-reads.md) separately approves shared in-flight query
reads; the other exclusions remain unchanged.

## Completion checks

- Both apps expose matching CRUD and source-mode behavior while retaining
  app-owned workflows.
- Focused tests cover success, failure, retry and stale-response behavior.
- Normalized entity ownership and partial-response merging remain correct.
- SSR hydration and list/detail navigation do not issue duplicate initial reads.
- Workspace tests, type-check and lint pass after cross-app changes.
- Documentation describes only current behavior and its demo limitations.
