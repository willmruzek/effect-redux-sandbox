# 0010: Library-owned cursor pagination

**Status: IMPLEMENTED**

## Goal

Provide reusable, library-owned cursor pagination mechanics for both request
toolkits, so consumers do not have to implement next-page execution, cursor
advancement and exhaustion handling for each query.

Build on [manual request hooks](0009-manual-request-hooks.md), the existing
generated request reducers and shared in-flight reads.

## Current behavior

- Both tracker apps own their page and refresh workflows. They select transport,
  construct query variables, choose the next cursor and guard duplicate loads.
- A failed page can be retried from its failed cursor. A first-page refresh
  replaces the visible result window; subsequent loading continues from the
  refreshed cursor. Refresh failure retains the existing visible data.
- The tracker owns normalized entity merges, visible result IDs, counts and
  page information. Its merge preserves optimistic writes and local companion
  data. Query changes and latest-wins guards prevent stale pages from replacing
  the current result.
- Initial server-loaded state is hydrated into each browser store without an
  extra automatic fetch. Backend page count is separate from the UI's local
  page navigation.

## Proposed ownership

- Each independent request toolkit provides equivalent cursor workflow
  mechanics. Reuse its existing query execution, request ownership and metadata
  rather than introducing a shared cross-store engine.
- The library manages the active cursor chain, next-page eligibility and
  advancement only after an eligible successful page. It exposes typed,
  observable pagination state and explicit execution outcomes.
- The consumer supplies typed query identity and variables, transport,
  response decoding, cursor/exhaustion extraction and domain merge policy.
  GraphQL and REST remain transport choices, not pagination implementations.
- Normalized entities and result membership remain in the application store.
  Do not add a duplicate response cache, a second write authority or functions,
  Effects or resources to reducer state. TanStack DB remains a read-only
  projection.
- Preserve request-scoped stores, existing runtime ownership and synchronous
  reducer publication. Pagination must remain usable without React; any hook
  integration must not auto-fetch or change plan 0009's manual-hook behavior.

## Agreed contract

- Each toolkit exposes a separate composable pagination definition, with one
  authoritative cursor chain stored in application state through typed
  accessors. Migrate both tracker apps and their consumers with a clean break;
  transport selection and entity merge policy remain app-owned.
- Each store owns one active chain identified by canonical filters, sort and
  source mode. A changed identity requests its first page and keeps the old
  visible results until the replacement succeeds. Stale results cannot advance
  or merge into the new chain.
- Duplicate next-page calls skip while a page is pending. This does not change
  the underlying query API's shared-read semantics.
- Failures and cancellation retain the last successful data and cursor, surface
  the error and allow retrying the same cursor. A response claiming more pages
  without a cursor, or repeating the cursor just requested, fails explicitly.
- The library owns explicit first-page refresh. A successful refresh replaces
  the visible window and establishes its new cursor; failure retains the old
  window. Refresh supersedes an older pending page.
- This stage is headless. Do not add a pagination hook or automatic fetching.

## Implemented outcome

Each toolkit provides its own headless `createCursorPagination` definition.
The tracker apps use it with their generated query's `runWithResult`, which
shares the existing execution registry with `run` and exposes normalized data
only for an eligible success. The pagination reducer commits domain merging and
cursor advancement together. Tracker `result.pageInfo` remains the snapshot of
the last successful response and seeds hydration; pagination state owns
execution decisions. Consumers must not separately merge generated query success
actions before pagination validates and claims the page.

Both toolkits also expose `validateCursorPage`; the tracker normalizers use it
before publishing query success. Cursor comparison uses `Object.is`, so
object-valued cursors require stable references. Explicit restart and refresh
begin at the first page. There is no hook, automatic fetching or response cache.
The [comparison guide](../docs/prove-the-layers.md#cursor-pagination) documents
the public contract and limitations.

## Test-first implementation stages

1. Resolve the decisions above and record the agreed public contract, state
   shape, outcomes and migration strategy in this plan.
2. Write public-consumer tests against both independent toolkits for initial
   load, cursor advancement, exhaustion, empty pages and typed inputs. Test the
   approved behavior for invalid cursor chains.
3. Test duplicate calls, shared execution, query/source changes, refresh races,
   stale settlements, isolated stores, retries, errors and cancellation. Verify
   exactly when transport runs and that only an eligible success advances state.
4. Implement the reusable mechanics and, if agreed, manual React integration.
   Demonstrate transport independence and app-owned normalized merges without
   coupling either toolkit to tracker code.
5. Migrate the tracker flows in both apps with tests for GraphQL, REST and mixed
   modes, optimistic writes, local data, first-page refresh, SSR hydration and
   navigation. Preserve existing behavior unless a change is explicitly approved.
6. Update documentation and the comparison tables to reflect the final API and
   limitations. Run focused tests first, then workspace lint, type-check, tests
   and production builds.

## Acceptance checklist

- [x] Both toolkits expose usable, typed cursor workflows without requiring React.
- [x] A successful eligible page advances the correct chain; exhaustion prevents
      extra transport calls.
- [x] Initial, empty, final and invalid cursor cases follow the agreed contract.
- [x] Query identities, store instances and source modes remain isolated.
- [x] Duplicate calls, shared reads and request outcomes follow the agreed policy.
- [x] Failures, cancellation, ownership errors and retries are visible and do
      not incorrectly advance the cursor or lose established data.
- [x] Stale page and refresh settlements cannot overwrite the active chain.
- [x] Tracker refresh, retry, filters, source modes and local navigation retain
      their agreed behavior in both apps.
- [x] App-owned normalization, optimistic merges and local records are preserved.
- [x] SSR and hydration do not introduce duplicate initial requests.
- [x] No response cache, automatic fetching or implicit background work is added.
- [x] Public consumer tests and documentation cover
      the implemented contract.
- [x] Workspace lint, type-check, tests and production builds pass.

Verification: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
passed, including 643 tests and both application builds.
