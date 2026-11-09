# 0012: Query refetch

**Status: TO BE IMPLEMENTED**

## Goal

Build a library-owned refetch mechanism on
[query and mutation invalidation](0011-query-mutation-invalidation.md), so
eligible stale queries can be refreshed according to an explicit policy
without each mutation workflow coordinating every affected read.

Both independent request toolkits should support the same observable behavior,
while consumers retain control of transport, normalized data and domain merges.

## Prerequisite and boundaries

- Plan 0011 must establish query identity, dependency matching, observable
  stale revisions and read/invalidation race semantics before this plan is
  implemented. Resolve any remaining interface gaps before coding.
- Generated queries are lazy Effects; matching in-flight reads share execution
  only for the same operation, canonical variables and stable receiving store
  service. They do not retain a response cache or enough execution context to
  automatically reconstruct every prior request.
- Tracker page reads use library-owned cursor pagination. Task writes use
  standalone lifecycles and currently initiate refresh in app workflows.
  The existing refresh retains the visible window on failure.
- Manual hooks do not fetch on mount or argument change. SSR and hydration
  use request-scoped state and do not repeat the initial browser fetch.

## Proposed scope

- Provide an opt-in, library-owned mechanism to identify eligible queries and
  invoke their existing query execution path when policy requests refetch.
  Define an explicit registration and lifetime for the query variables,
  transport configuration, store service and any Effect environment required
  to rerun a query. Runtime objects and callbacks remain outside reducer state.
- Support invalidation-driven refetch of eligible active queries, while
  exposing pending, failure and stale state through the existing store-owned
  metadata or an explicitly designed extension. Inactive queries remain stale
  until the agreed trigger runs.
- Refresh a paginated tracker chain from its first page through the pagination
  workflow, not by independently merging a generated query success. Preserve
  visible data and the previous cursor until a valid eligible refresh succeeds.
- Coalesce or sequence invalidations and concurrent reads according to an
  explicit policy. A later invalidation during refetch must not be lost; a
  pre-invalidation shared worker must not be treated as a fresh response.
- Migrate both tracker apps' existing post-write refresh paths to the agreed
  policy without duplicate transport, accidental extra fetches or loss of
  optimistic/local data. Preserve app-owned transport selection and error
  visibility.
- Keep time-based freshness and retention, endpoint response caching, offline
  synchronization and generic polling outside this stage unless separately
  approved. This plan does not by itself change the manual-hook contract.

## Decisions to resolve before implementation

These are open choices, not approved changes to existing behavior.

1. **Activation:** what makes a query active, who registers it, whether
   subscription alone counts, and how route changes, multiple observers,
   inactive queries and explicit headless users are handled.
2. **Triggers and defaults:** invalidation-only versus additional opt-in
   triggers, whether enabling a policy can refetch on registration or
   hydration, and how explicit refresh interacts with automatic work.
   Decide separately before changing manual query hooks.
3. **Execution ownership:** registration shape, stable service identity,
   variables and transport capture, Effect environment and runtime lifetime,
   store/SSR isolation, disposal and interruption. Define behavior for
   conflicting registrations and missing or disposed owners.
4. **Concurrency:** coalescing bursts, invalidation during pending reads or
   refetch, refresh overtaking a page, supersession, shared-waiter
   cancellation, reruns after a newer stale revision and avoiding infinite
   refetch loops.
5. **Failures and recovery:** how background errors are surfaced, whether
   mutation success remains distinct from subsequent refetch failure, stale
   indicators, manual recovery, retry policy and cancellation on deactivation.
6. **Pagination and source changes:** first-page replacement versus other
   behavior, cursor and optimistic merge ownership, active identity changes,
   GraphQL/REST/mixed transport and old registration cleanup.
7. **Migration and compatibility:** whether tracker workflows await refetch
   or schedule it, preserving existing outcomes and UI behavior, and whether
   any public state or API change needs a clean break or compatibility support.

## Test-first implementation stages

1. Resolve decisions with the user and document the contract and plan 0011
   prerequisite. Write public-consumer tests against both independent toolkits
   before implementation.
2. Test active/inactive registration, explicit triggers, repeated invalidation,
   query sharing, source/identity changes, pagination and stale revision races.
   Count actual transport calls and verify no automatic fetch outside policy.
3. Test background failure, retry, cancellation, disposal, runtime ownership,
   multiple observers and independent stores. Cover request-scoped SSR,
   hydration and unmount cleanup without introducing duplicate initial reads.
4. Implement each toolkit's mechanism and migrate both tracker apps. Exercise
   generated mutations and standalone write lifecycles, optimistic/local data,
   GraphQL, REST and mixed modes, and existing manual request hooks.
5. Update public documentation, comparison and roadmap. Run focused tests,
   then workspace lint, type-check, tests and production builds.

## Acceptance checklist

- [ ] The implementation builds on the completed invalidation contract.
- [ ] Both toolkits expose typed, opt-in refetch behavior for headless consumers.
- [ ] Active and inactive queries, triggers and registration lifetimes follow
      the agreed policy without hidden work or store/runtime leaks.
- [ ] Invalidations and concurrent reads are coalesced or sequenced as agreed;
      no newer stale revision is lost or satisfied by an older shared request.
- [ ] Failures and cancellation remain observable; stale data remains usable and
      retryable without misreporting mutation or refetch outcomes.
- [ ] Pagination refresh, query/source changes, optimistic writes and local
      data retain their agreed behavior in both tracker apps.
- [ ] No duplicate post-write refreshes or unintended initial hydration fetches
      occur; existing manual hooks retain their contract unless changed by agreement.
- [ ] No endpoint response cache, persistence, offline sync or unapproved
      freshness/polling behavior is added.
- [ ] Public consumer tests, documentation and workspace checks pass.
