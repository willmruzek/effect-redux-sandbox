# 0011: Query and mutation invalidation

**Status: COMPLETED**

## Goal

Provide typed, store-owned query invalidation in both independent request
toolkits. Consumers can declare dependencies, invalidate them after mutations,
and observe which results need a fresh read without deleting visible data or
creating an endpoint response cache.

This plan adds no automatic refetch. It establishes the contract used by
[plan 0013](0013-query-refetch.md), which remains a separate plan with its own
unresolved decisions.

## Existing behavior and boundaries

- Generated operations use canonical variable keys, latest-wins scopes and
  store-owned request metadata. A query shares execution per operation, stable
  receiving store service and key. Scope controls settlement ownership; it is
  not an invalidation dependency.
- Tracker task pages use a single cursor chain for the visible query. Its
  identity includes filters, sort and source mode; its pagination reducer
  commits the app-owned domain merge and cursor together. A first-page refresh
  retains the old window until success.
- Tracker writes use standalone `createRequestLifecycle` definitions, while
  other consumers can use generated mutations. Both apps explicitly refresh
  after applicable writes. Injected status/priority `persist` callbacks
  currently do not trigger that refresh.
- Manual query hooks observe exact operation variables and do not fetch on
  mount. SSR uses request-scoped stores and hydrates without a second fetch.

## Agreed contract

### Registry, tags and identity

- Each toolkit independently provides an explicitly installed invalidation
  registry shared by participating API definitions and standalone lifecycles
  in one store. Different stores and toolkit implementations remain isolated.
  Reducer state contains only data; definitions, functions and resources stay
  outside it. Missing registry ownership or invalid publication fails
  explicitly, never as a successful no-op.
- Consumers declare allowed tag names. A typed tag has a name and optional
  string ID, for example `{ type: 'TaskList' }` or
  `{ type: 'Task', id: '42' }`. Matching is exact: list and entity tags are
  distinct, and neither implies the other. Mutations that affect list
  membership, ordering or counts explicitly invalidate the list tag.
- Ordinary query freshness is keyed by operation and canonical variables.
  Paginated freshness belongs to operation plus canonical chain identity
  (filters, sort and source mode, excluding cursor). Do not conflate these
  identities with latest-wins scopes, transport request keys or tag names.
  Keep the existing app-supplied canonical pagination identity.
- Queries can derive tags from variables and successful normalized results.
  Register variable-derived tags when a query starts, even before its first
  success; register result-derived tags only on an eligible successful result.
  An ordinary query replaces its result-derived tags on its next eligible
  success. A paginated chain accumulates tags across appended pages; a
  successful first-page refresh or replacement replaces the prior chain tags.
- Retain query dependency and freshness metadata for the lifetime of the
  store. Provide a typed explicit forget operation that removes registry
  metadata without deleting domain data. Forgetting or re-registering an
  identity must not permit an older in-flight result to commit. There is no
  automatic eviction in this stage.

### Invalidation and mutation settlement

- Generated mutations and standalone write lifecycles both support declarative
  invalidation tags derived from their input and successful result. Also expose
  explicit typed invalidation for external events and uncertain outcomes.
- Only an eligible successful write automatically invalidates. Failed,
  cancelled, skipped and superseded writes do not. If transport fails after the
  server may have committed, callers can explicitly invalidate; the library
  cannot infer that the server changed.
- Publish confirmed write state and its invalidation in one atomic store
  transition. Subscribers must not observe a confirmed local write without
  its stale markers. Reconcile this with the existing explicit lifecycle case
  registration and generated reducer ownership guards; do not silently
  auto-register domain reducers.
- If the server succeeds but tag calculation or atomic local publication
  fails, surface a distinct post-commit execution error that identifies server
  success and failed local settlement. Do not claim confirmation or
  invalidation succeeded, and do not publish a misleading ordinary write
  failure or roll back an already confirmed write. Callers must be able to
  distinguish this from a rejected server mutation to avoid blindly retrying
  a non-idempotent create.
- Explicit invalidation records a revision even if no registered query
  currently matches and reports zero known matches. Retain the information
  needed to evaluate reads already in flight; this matters when a matching
  entity tag is only discovered in a later result. Invalidation never starts
  transport in this plan.

### Freshness, races and sharing

- Expose a typed headless freshness selector for ordinary queries and another
  for pagination chains. Distinguish an uninitialized query from an established
  result; show invalidation independently of request failure or pending status.
  Extend the existing manual query hook to expose ordinary query freshness
  from the same authoritative store state. No pagination hook is added.
- Seed SSR-hydrated tracker data explicitly as a fresh chain with its list
  and loaded-entity tags. A query without a registered result is uninitialized,
  not implicitly fresh. Seeding and observation do not fetch.
- Invalidation marks matching registered results stale without clearing
  normalized entities, visible membership or the last successful cursor.
  An eligible successful ordinary read clears only invalidations it observed
  when it started. A later matching invalidation remains stale.
- A read whose dependencies were invalidated after it started must settle as
  superseded without publishing a successful domain merge. This includes
  pagination page data and cursor advancement. Determine relevance using
  variable-derived and previously established tags plus tags derived from the
  result, compared with invalidations since the read started. An unrelated
  invalidation alone does not disqualify an older result. If a matching
  result-derived tag was not known at invalidation time, mark the query
  invalidated when that match is discovered, even though its result is
  discarded.
- Since result-derived dependencies are unknown while a read is pending,
  any invalidation starts a new sharing generation. A subsequent caller never
  joins an older worker; it can start a new one immediately. Older workers
  still undergo tag/revision and existing latest-wins checks; only eligible
  results can succeed. Preserve store-service isolation and waiter
  cancellation semantics within each generation.
- Track invalidation revisions and in-flight read start revisions so matching
  can include tags discovered at settlement. Retain relevant revision history
  until the affected in-flight reads settle or are interrupted; clean it up
  safely afterward. Guard both generated query success handlers and the later
  pagination commit, so invalidation between those publications cannot merge
  stale data or advance the cursor.
- A stale cursor chain rejects `next` with an explicit stale outcome until an
  eligible first-page refresh or replacement succeeds. A successful append
  never clears chain staleness. Refresh failure or cancellation keeps the
  visible window, cursor and stale status; an invalidation during refresh
  cannot be cleared by that refresh. Explicit refresh remains manual.

### Tracker migration and compatibility

- In both apps, successful task creation, deletion and edits invalidate the
  task-list tag and affected task entity tag. Person renames invalidate the
  affected person entity tag. These shared-resource tags apply across source
  modes, whose demo transports use the same backend repository.
- Preserve existing explicit post-write refreshes and their execution/error
  behavior; do not introduce a second refresh. In particular, retain the
  existing no-refresh behavior for injected status/priority `persist`
  callbacks. Those successful writes still invalidate their declared tags.
- Preserve optimistic write settlement, local companion records, source-mode
  changes, latest-wins behavior and SSR/hydration. Migrate both apps, fixtures,
  public consumers and the React hook to the new state and API shapes as a
  clean break; do not add compatibility shims.

## Test-first implementation stages

1. Define the typed tag declarations, shared store registry, initialization,
   selectors, invalidation and forget contracts in public-consumer tests for
   both toolkits. Cover exact matching, dynamic tags, independent query and
   chain identities, multiple APIs in one store and separate stores.
2. Test generated mutations and standalone lifecycles with input/result-derived
   tags. Verify atomic observer visibility, explicit invalidation with zero
   matches, all unsuccessful write outcomes, missing ownership and distinct
   post-commit errors. Verify invalidation itself never starts transport.
3. Test reads started before and after invalidation, including unknown
   result-derived tags, unrelated tags, multiple invalidations, new sharing
   generations, waiter interruption, forget/re-registration and cleanup.
   Assert outcomes, transport counts and actual domain state, not just flags.
4. Test page append and first-page refresh, accumulated and replaced chain
   tags, stale-next outcomes, refresh/invalidation races and invalidation
   between query success and pagination commit. Verify no stale entity,
   membership or cursor transition occurs.
5. Implement the contract separately in both toolkits; update the manual
   query hook and migrate both tracker apps and SSR seeding. Exercise GraphQL,
   REST and mixed modes, optimistic/local data, explicitly retained refreshes,
   and absence of duplicate or hydration-triggered requests.
6. Update public API documentation, the comparison guide and roadmap.
   Run focused package, hook and tracker tests first, then `pnpm lint`,
   `pnpm typecheck`, `pnpm test` and `pnpm build`.

## Acceptance checklist

- [x] Both toolkits expose typed exact-match tags, a shared per-store registry,
      explicit invalidation and safe explicit metadata removal.
- [x] Generated and standalone mutations publish confirmed writes and
      invalidation atomically; post-commit publication failures are distinct.
- [x] Variable and result dependencies, pagination chain tags, identities and
      SSR seeding follow the agreed contract across stores and source modes.
- [x] Typed selectors and the manual query hook expose authoritative freshness
      without starting requests; no pagination hook is introduced.
- [x] Matching pre-invalidation reads cannot merge or clear stale state, even
      when tags are discovered in the result or invalidation occurs between
      query and pagination publication.
- [x] New reads never join an older sharing generation; unrelated
      invalidations do not themselves disqualify old results, subject to
      existing latest-wins ownership.
- [x] A stale chain blocks next-page loading until an eligible first-page
      refresh or replacement; failures retain visible data and stale state.
- [x] Tracker writes, explicit refresh behavior, optimistic/local data,
      transport modes and hydration are preserved without duplicate requests.
- [x] No response cache, automatic fetching, eviction, persistence or
      time-based freshness policy is introduced.
- [x] Public consumer tests, documentation and workspace checks pass.

## Outcome

Both tracker apps and independent request toolkits implement explicit typed
invalidation, chain freshness and guarded settlement. Invalidation does not
automatically refetch; [plan 0013](0013-query-refetch.md) remains separate.
Public-consumer tests cover store isolation, shared APIs, interrupted waiters,
write outcomes and page publication races. The final workspace lint,
type-check, test and build commands passed, including 732 tests.
