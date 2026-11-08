# 0003: Additional RTK-like layers

**Status: IMPLEMENTED**

This status covers the completed layer foundations, not the deferred roadmap
or deliberately removed experiments described below.

## Purpose and status

Build optional store and normalized-request conveniences on the
[base CRUD contract](0002-base-crud.md), without changing its feature scope.
Redux Toolkit and RTK Query are conceptual references, not feature parity targets.

## Inherits and adds

Inherit matching CRUD behavior, normalized entities, projections, navigation,
validation and stale-read protection from 0002.
Add optional slice helpers and a normalized request API over the independent
core stores. Keep domain reducers and transport workflows app-owned.

This plan describes the layer foundations before the final ergonomics stage,
not every detail of their current APIs.
[Reduce boilerplate](0004-reduce-boilerplate.md) then consolidates CRUD lifecycle
plumbing, generates metadata, separates reducer registration and extracts
field/domain/UI conveniences.
[0007](0007-generated-api-reducers.md) later replaces normalized per-action
registration with a generated API reducer installed once; domain handlers remain
separate and standalone write cases remain explicitly registered.

## Layer 1: core stores (implemented, part of the base)

- Typed actions, synchronous reducer transitions and subscriptions.
- Application-owned store composition and Effect runtime.
- Effect execution belongs in the Effect core; Redux obtains it through
  middleware. That difference is intentional.
- Core stores work without the optional lifecycle/query toolkit helpers.
- Reducer state and outputs contain data only.

## Layer 2: optional slice helpers

The separate Redux and Effect toolkit packages provide reusable conveniences
over their respective stores:

- Slice/case-reducer helpers for typed state transitions.
- Reusable composition over each store without changing core store ownership.
- Application-defined domain handlers rather than a shared tracker reducer.

This resembles the core Redux plus optional Redux Toolkit relationship; it does
not require Redux-only thunks or entity adapters.
Generated CRUD runners, inferred metadata, guarded field helpers and separate
case registration are introduced in 0004, not prerequisites of this stage.

## Layer 3: normalized request API foundations

- Query/mutation definitions with decode, normalize and scope contracts.
- Canonical request keys and store-owned request metadata.
- Latest-wins settlement guards and cancellation cleanup.
- App-defined reducers for domain merge and request-state transitions.
- Store-independent transport and entity normalization utilities.

Use this API for normalized task reads; retain app-owned CRUD write workflows.
GraphQL, REST and mixed-source transport selection remains app-owned.
The API does not create a second response cache or automatically subscribe
components to cached endpoint results.

Duplicate pending normalized reads skip rather than sharing the original
Promise. Refresh explicitly reloads the first backend page; successful writes
explicitly refresh through app workflows. These are not automatic cache
invalidation, background revalidation or request-sharing systems.
The later separation of API definitions from reducer registration is recorded
in 0004. This describes the behavior at this stage:
[0006](0006-share-in-flight-reads.md) subsequently replaces query skipping with
shared execution and last-waiter cancellation; mutations remain unshared.

## Domain and UI ownership

Task existence,
draft restrictions and deletion/edit conflicts are domain rules, not generic
request-engine semantics. Backend validation remains authoritative. Repeated
workflow checks and UI metadata plumbing can remain explicit at this stage;
0004 consolidates them without moving domain policy into generic toolkits.

## Historical experiments (implemented earlier, deliberately removed)

The project temporarily went beyond the focused comparison. These mechanisms
were removed when the scope returned to base CRUD:

| Mechanism | Retained simpler behavior |
| --- | --- |
| Per-field revision/conflict protocols | Optimistic writes, confirmation and rollback without revision guarantees |
| Creation idempotency receipts | Explicit retry with retained drafts, without retry-safe non-idempotent guarantees |
| Conflict-safe deletion and tombstones/receipts | Pending deletion visibility, confirmation and failure recovery |
| Atomic multi-page refresh | Explicit first-page refresh |
| Mutation invalidation/reconciliation generations | Explicit app-owned refresh after successful writes |

Do not describe these experiments as current capabilities or quietly restore
them for compatibility.

## Broader roadmap (deferred, not approved implementation)

- Conditional/time-based freshness and cache lifetime/eviction policies.
- Automatic invalidation, dependent-query refetch and background revalidation.
- Polling and prefetching.
- Server subscriptions/live updates and cross-tab synchronization.
- Dependent multi-endpoint workflows beyond the existing mixed-source example.
- Durable storage, offline queues and synchronization.

Authentication and user sessions remain explicitly excluded.
Full TanStack Query or RTK Query parity is not a goal.
Any deferred feature needs its own approved, numbered plan with explicit
ownership, behavior, failure handling and acceptance tests.
Shared in-flight query reads are now approved separately in
[0006](0006-share-in-flight-reads.md); the remaining roadmap is still deferred.
The current [library roadmap](../README.md#library-roadmap) now tracks
library-owned cursor pagination, freshness/lifetime, background refetch and
mutation invalidation as explicit future goals. These are not implemented or
approved execution plans; each still requires its own numbered plan.

## Boundary checks

- Base CRUD remains usable without adopting all optional helpers.
- App reducers, workflows and runtime ownership remain independent.
- Generic toolkits contain request mechanics, not tracker-specific policy.
- Request metadata and normalized entities do not become duplicate caches.
- Implemented, removed and deferred features are documented distinctly.

## Handoff to the final stage

The resulting apps have matching CRUD behavior plus optional slice and
normalized-request foundations. Their repeated write lifecycle handlers,
payload construction and domain/UI plumbing are the inputs to
[0004](0004-reduce-boilerplate.md). That stage changes ergonomics and registration
boundaries, not the baseline feature set.
