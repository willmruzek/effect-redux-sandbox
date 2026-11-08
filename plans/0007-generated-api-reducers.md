# 0007: Generate API reducers

**Status: IMPLEMENTED**

## Inherits and changes

Build on [shared reads](0006-share-in-flight-reads.md). Match RTK Query's
integration convenience: the request API generates lifecycle metadata handling,
and the application explicitly installs that reducer once.

This is an approved clean break from per-action normalized request registration.
Migrate both toolkits, tracker apps and public consumer examples. Standalone
write lifecycles and their explicit case registration remain unchanged.

## Ownership and public API

- `createRequestApi` returns `reducer(state, action)` for store-owned request
  metadata located by the existing state accessor.
- The generated reducer handles every defined operation's start, success,
  failure and cancellation, including duplicate and latest-wins guards.
- Replace operation `reducers` case bundles with `reducer(handlers)`, a separate
  domain reducer for app-owned loading notices, normalized merges and errors.
- Compose domain reducers before the generated metadata reducer so callbacks
  inspect the same pre-transition ownership. The app installs the composed
  reducer once and continues to own initial domain state.
- Domain callbacks never own generic request metadata. No callbacks are needed
  to execute an operation whose generated reducer is installed.
- Omitting the generated reducer still fails before transport. API creation
  generates behavior but does not mutate or install a store.
- Preserve action payload inference, immutable snapshots, stale-result identity,
  shared reads, cancellation cleanup and visible publication failures.

Unlike RTK Query's endpoint-cache slice, this reducer operates on the existing
normalized root state through its metadata accessor. Do not introduce a second
response cache, automatic middleware, hooks, freshness or invalidation.

## Test-first acceptance

- Generated metadata handling works without manual lifecycle registration or
  domain callbacks, for both query and mutation operations.
- Separate domain callbacks run only for eligible/current ownership.
- Unknown actions and stale settlements preserve snapshot identity.
- Missing API reducer installation fails explicitly.
- Definitions generate reducers without installing them; removed case bundles
  are not preserved as compatibility shims.
- Migrate every application, example and toolkit test.
- Update current documentation and historical-plan supersession notes.
- Workspace lint, type-check, tests and production builds pass.

## Completed outcome

- Both independent request APIs generate metadata reducers covering every query
  and mutation lifecycle, without per-action consumer registration.
- Optional domain reducers remain separate and guarded. Both tracker apps and
  inventory consumers compose them before the generated API reducer.
- Removed normalized operation case bundles without compatibility wrappers.
  Standalone write lifecycles, normalized state, sharing and runtime ownership
  remain unchanged.
- Public consumer tests verify metadata-only execution, transport failure,
  cancellation, unknown-action identity, stale settlements, duplicate starts and
  separate domain composition. Existing app and toolkit tests also pass.
- README and comparison-guide rows now report generated managed request state;
  historical plans explicitly identify this approved contract revision.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed: all 532 tests
  and both production app builds succeeded.
