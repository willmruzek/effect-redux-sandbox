# 0012: REST and GraphQL API factories

**Status: IMPLEMENTED**

## Goal and scope

Provide separate REST and GraphQL API factories in each independent request
toolkit. Consumers centrally define endpoints, typed operations, decoding,
normalization and optimistic updates; the factory owns request execution and
the optimistic mutation lifecycle. Demonstrate both transports and both
toolkits without making either toolkit depend on the other or on tracker code.

Migrate representative operations in both tracker apps: REST person rename,
task assignee writes in both REST and GraphQL modes, and paginated task reads
in both modes. Keep other tracker workflows, including the per-call `persist`
injection for status and priority, unchanged. Existing explicit post-write
refresh remains explicit. This plan does not implement automatic refetch:
[plan 0013](0013-query-refetch.md) remains a separate, unresolved proposal.

## Current behavior and migration boundary

- Both toolkits currently expose `createRequestApi`. Its built-in execution is
  GraphQL-specific; REST and tests can override execution per invocation.
  Tracker pages use this override for REST and the per-call `fetchPage` test
  seam. Tracker writes use standalone `createRequestLifecycle` definitions.
- Replace `createRequestApi` with `createRestApi` and `createGraphqlApi` as a
  clean break. Remove per-run `endpoint`, `headers`, `fetcher` and `execute`
  overrides from generated operations. Remove tracker `fetchPage` from load
  and refresh options. Inject transports when definitions are created instead.
  Do not add a compatibility wrapper.
- Retain standalone lifecycle APIs and their existing behavior for non-API
  workflows. Migrate every existing generated API consumer, including toolkit
  tests, manual-hook tests, `tools/layer-examples`, app code and documentation.
  This is a public API migration even though only representative tracker
  operations gain factory-owned optimistic behavior.
- Today generated GraphQL mutations treat decode/normalization failure after a
  response as `PostCommitError`. This plan intentionally changes **generated
  factory mutations** to return the marked ordinary failure described below.
  It does not change standalone lifecycle semantics.

## Factory and transport contract

- Each toolkit independently implements both factories over common machinery
  internal to that toolkit. Each store creates stable API instances for its
  lifetime, with its own transports and shared optimistic-ownership registry.
  Definitions, transports, registry resources and Effects stay outside reducer
  state. Server requests and browser stores do not share instances or claims.
- Define operations, endpoint/base path, default headers and injected transport
  at factory construction; operations may override transport **at definition
  time**, never per run. A custom executor may use an arbitrary Promise, but
  must implement the same explicit successful-response boundary and failure
  reporting as the built-in transport. Pass the execution's abort signal to it.
  Runtime variables and pagination fences remain per-run inputs.
- The REST factory defines method, path, query parameters, headers and optional
  JSON body from typed variables. Join the configured base path and operation
  path with exactly one separating slash without requiring an absolute URL.
  Encode query values with `URLSearchParams`; omit absent optional values and
  preserve explicitly supplied empty strings, zero and `false`. Default to an
  `Accept: application/json` header, add JSON content type when sending a
  body, and allow explicit operation headers to override factory defaults.
  Non-2xx responses fail with observable HTTP status and message. A successful
  empty response is accepted only when the operation explicitly declares it;
  otherwise parse JSON and surface parsing errors. Streaming, uploads and
  arbitrary binary responses are outside scope.
- The GraphQL factory defines document, optional operation name, variables and
  headers, retaining GraphQL error handling and explicit decode/normalize
  callbacks. Both factories use existing entity-table helpers and app-declared
  normalization/merge policies; neither infers relationships or builds a
  schema engine.
- A successful-response receipt must be distinguishable from parsing, decoding
  and normalization. For built-in HTTP execution establish it when a successful
  response is received, **before** reading/parsing its body; custom execution
  explicitly reports the corresponding boundary. This makes malformed JSON
  and decode failures observable as possible committed writes. No response
  bodies or runtime objects are stored in request metadata.
- A custom executor returns a Promise of either a successful receipt with a
  deferred `read(): Promise<unknown>` body, or a failure containing its error
  and whether a commit is possible. An unexpected rejection is treated as
  commit-uncertain once execution began. The factory establishes the receipt
  before calling `read`, then decodes and normalizes its result. The deferred
  reader and transport errors are runtime values, not action or state data.
- Preserve operation kinds, canonical keys, scopes and freshness. Generated
  endpoints expose `initiate(variables)` and `select(variables)`; keep
  `run`/`runWithResult` as engine-level execution methods. Preserve explicit
  reducer composition and data-only actions/state.
  Preserve shared query execution by operation, stable store service, key and
  invalidation generation, including last-waiter cancellation. Factory
  instances must not inadvertently share workers across stores.

## Optimistic mutation contract

- A mutation optionally declares typed optimistic targets derived from its
  variables and current state. Each target identifies an entity/table, entity
  ID, incarnation and field, plus its proposed value and typed access needed
  to snapshot, update and reconcile it. The app supplies domain validation,
  entity access and result reconciliation; the factory supplies claim,
  application, request, confirmation and rollback mechanics. Targets,
  snapshots and metadata published in state/actions contain data only.
- An incarnation is a stable app-supplied identity for the original entity,
  unchanged by normal field updates and distinct if an ID can be reused after
  deletion. A target key is shared across factory instances in the same store;
  it does not include transport or operation name. Where IDs cannot be reused
  during a store's lifetime, the app may use the ID as its incarnation.
- One mutation may claim multiple fields, including across entities. Before
  transport, validate all targets, reject duplicates or missing targets as an
  explicit preflight failure, and atomically claim and apply all fields.
  Preflight failure changes no state and starts no transport. If any target is
  already claimed, return `{ status: 'skipped', reason: 'conflict' }` without
  changing state or starting transport. Duplicate-request skipping remains
  distinguishable from an ownership conflict. Independent fields may proceed
  concurrently, including through different REST/GraphQL instances.
- Install the factory-provided guarded optimistic reducer explicitly alongside
  its request reducer; no automatic domain reducer registration. Check required
  reducer and invalidation-registry ownership before transport, and fail
  explicitly if composition is missing or incorrect. Claiming, capturing
  original values and applying the full optimistic update are one guarded
  store transition; a failed start releases any reserved runtime claims.
- Rollback restores only fields still owned by that request, in one guarded
  transition, and preserves unrelated fields and local companion data. If a
  target was deleted or replaced, never recreate or alter the replacement:
  restore remaining original targets and report an **incomplete rollback**
  with the missing target identities alongside the original failure. Release
  all claims on every terminal path.
- Confirmation applies the app's reconciliation only to owned fields. Any
  additional app-declared merge must preserve fields owned by other pending
  mutations. Reads and other app-owned workflows must use their existing merge
  policies to avoid overwriting claimed fields; the registry does not magically
  guard arbitrary reducers or standalone lifecycles. If overlapping workflows
  need the same guarantee, their app composition must participate in the same
  ownership policy.
- If an original target is deleted or replaced before server-success
  confirmation, do not resurrect it or partially confirm. Report a
  `PostCommitError`, publish neither confirmation nor its invalidation, expose
  the target identities for reconciliation, and release the claims. Do not
  report ordinary mutation success or automatically roll back an acknowledged
  server write.
- Preserve registry-first reducer composition from
  [plan 0011](0011-query-mutation-invalidation.md). An eligible confirmation
  and its declared invalidation publish atomically in one store transition.
  Tag-calculation or local-publication failure after decoded server success is
  a `PostCommitError`, not an ordinary failure or a rollback. Release claims
  and surface sufficient recovery information rather than silently retaining
  a pending request.

## Failure, uncertainty and cancellation

- A successful server response followed by JSON parsing, decoding or
  normalization failure rolls back the owned fields and returns
  `{ status: 'failed', error, serverMayHaveCommitted: true }`. Do not
  automatically invalidate; callers can explicitly reconcile or invalidate
  before retrying. This is intentionally distinct from a `PostCommitError`
  after a decoded confirmation cannot be published.
- Also mark transport failures or interruptions when a commit cannot be ruled
  out. Once a mutation has been handed to transport, conservatively use
  `serverMayHaveCommitted: true` unless the transport can establish that it
  was not sent or could not have committed. Preflight failures are not marked
  as possible commits. A rejected HTTP or GraphQL response is not by itself
  proof that no server-side write occurred.
- Make this marker available on failed outcomes and failure action/request
  metadata, including cancelled metadata on interruption. Extend the public
  manual mutation hook's outcome and request types so consumers can observe it;
  preserve interruption semantics rather than converting an interrupted Effect
  into a misleading successful result. Incomplete rollback information is
  likewise observable alongside the underlying error, including on cancellation.
  Represent it as `rollback: { status: 'incomplete', missingTargets }`; include
  any rollback-publication error as well. The uncertainty marker is `true`
  when applicable and otherwise absent, not a false assertion of safety.
  Do not automatically invalidate uncertain outcomes.
- Before a successful response receipt, cancellation interrupts transport,
  rolls back owned fields and records cancellation with the uncertainty marker
  where applicable. Once the receipt is known, complete parsing, decoding and
  settlement in a non-cancellable section: publish confirmation and
  invalidation, or the appropriate marked failure/`PostCommitError`, before
  honoring interruption. Never publish both a rollback and a confirmation.
- Failures applying or publishing rollback must themselves be surfaced with
  the original error and affected targets; they must not be presented as a
  complete rollback. Cleanup and publication failures must not leak claims.

## Tracker integration

- Construct per-store REST and GraphQL definitions and their shared ownership
  registry in each app. Wire the instances into store reducers, workflows and
  hooks with stable identities; avoid module-global runtime instances and
  cross-request SSR state. Keep normalized state and reducer outputs data-only.
- Select the transport at the app workflow boundary: REST mode uses REST task
  operations; GraphQL and mixed modes use GraphQL task operations. Person
  rename remains REST-owned and available only in the existing REST/mixed
  modes. Preserve app validation, result normalization and error display.
- Both page operations feed the same app-owned cursor pagination and
  invalidation state. Preserve source-mode chain identity, request metadata
  and visible loading/error behavior, freshness registration, shared-read
  semantics, invalidation fencing at both query and page commit, and merge
  protection for optimistic and local fields. A prior source's pending
  response must not update a newly selected chain.
- Migrate person rename and assignee reducers to factory-owned optimistic
  lifecycle and typed field targets, retaining their current validation and
  invalidation tags. Confirmation must not overwrite independently pending
  fields when the server returns a whole person or task. Keep the existing
  explicit assignee refresh after successful confirmation, with no duplicate
  refresh and no new refresh after failed, skipped or cancelled writes.
- Move page-test injection from `LoadOptions`/`RefreshOptions` to transport
  injection when creating the store/API definitions. Update all affected app
  and project-tracker tests and consumers. Preserve route loading, SSR
  hydration, local navigation and the absence of an extra initial browser fetch.

## Test-first implementation stages

1. Write public-consumer tests for both toolkits and both factory types before
   implementation. Establish definition-time transport injection, HTTP
   request construction, empty and malformed responses, GraphQL errors,
   custom Promise transport, operation typing and clean-break exports.
2. Test multi-target preflight, atomic start/confirmation, conflicts across
   factories, independent concurrent fields, separate stores, missing and
   duplicate targets, deletion/recreation, partial rollback reporting and
   missing reducer/registry ownership. Assert actual transport call counts and
   subscriber-visible state transitions.
3. Test failure and cancellation at each boundary: before dispatch, pending
   transport, response receipt, parsing/decoding/normalization and publication.
   Assert exact outcomes, uncertainty and incomplete-rollback metadata,
   `PostCommitError` distinctions, claim release and no automatic invalidation.
   Test concurrent writes, overlapping reads, stale settlement and cleanup.
4. Implement the internal shared mechanics and the two public factories
   separately within each toolkit. Migrate every generated API consumer and
   manual-hook type/test; retain standalone lifecycle coverage.
5. Test, then migrate both tracker apps. Exercise REST, GraphQL and mixed
   modes, source switching during pending reads, shared pagination fencing,
   person rename, assignee, status/priority injection, post-write refresh,
   optimistic/local data, per-store isolation, SSR and hydration.
6. Update public API documentation, examples, comparison and roadmap to describe
   the final contract and its limitations. Run focused toolkit, hook, example
   and tracker tests first, then `pnpm lint`, `pnpm typecheck`, `pnpm test`
   and `pnpm build`.

## Acceptance checklist

- [x] Each toolkit independently exposes typed REST and GraphQL factories;
      the old factory and per-run generated transport overrides are removed.
- [x] Factory definitions own transport and optional multi-field optimistic
      lifecycles; conflicts, preflight failures and independent fields follow
      the contract with no unintended transport or partial optimistic start.
- [x] Cross-factory ownership is store-scoped, supports entity incarnations,
      releases claims on every terminal path and never corrupts other fields.
- [x] Confirmation/invalidation are atomic; rollback, incomplete rollback,
      uncertain commit and post-commit failures are distinct and observable
      through the applicable public outcomes, metadata and hooks.
- [x] Query sharing, cancellation, invalidation freshness and cursor fencing
      retain their existing observable behavior for both transports.
- [x] Both tracker apps use the new factories for the representative
      operations; source modes, explicit refresh, SSR and local data work as
      described, without per-call page injection or automatic refetch.
- [x] All generated API consumers, examples and documentation use the new
      contracts; no compatibility shim, response cache, relationship engine,
      binary transport or unrelated feature is added.
- [x] Focused tests and the workspace lint, type-check, tests and builds pass.
