# 0009: Manual query and mutation hooks

**Status: IMPLEMENTED**

## Goal

Give React components typed query and mutation hooks that provide an explicit
trigger and reactive request status and error metadata, without requiring
components to know the store's request-metadata layout.

Build on [local data ownership](0008-local-data-ownership.md) and the existing
request APIs.

## Existing boundaries

- Both independent request toolkits define query and mutation operations through
  `createRequestApi`. Operations expose canonical variable keys and lazy
  Effect-valued `run` methods; the installed API reducer owns keyed metadata.
- A query shares in-flight execution for the same operation, receiving store
  service and canonical key. A duplicate pending mutation is skipped. Existing
  outcomes include success, failure, skipped and superseded; execution can also
  fail or be interrupted through Effect.
- Tracker workflows add app-owned policy around request operations. Several
  writes instead use standalone lifecycles and app-owned pending/error state,
  rather than the generated API metadata.
- Normalized data belongs to the store and is exposed through existing
  selectors and read-only TanStack DB projections. Request metadata is not a
  second entity or response cache.

## Scope

- Provide query and mutation hooks for both Redux-first and Effect-first
  consumers, using their respective existing stores and request implementations.
  Keep React integration optional for headless consumers.
- Each hook exposes a typed manual trigger and status/error metadata. Mounting,
  rendering, changing arguments or subscribing must not itself start a request.
  Preserve inference for operation variables and trigger outcomes.
- Observe the authoritative store metadata rather than copying request state
  into independent component state. An unstarted key is distinguishable from a
  pending, succeeded, failed, cancelled or superseded request.
- Use the operation's canonical key and the receiving store's metadata; do not
  invent a second request identity. Different keys and stores stay isolated,
  while components observing the same key see the same lifecycle, including
  requests started outside a hook.
- Trigger the existing execution path and preserve typed outcomes, observable
  execution errors, query sharing, duplicate-mutation behavior, cancellation
  and reducer ownership checks. Never turn defects or skipped/superseded
  outcomes into success.
- Keep runtime and store ownership explicit; do not create an Effect runtime
  per render or place functions, Effects or resources in reducer state.
  Respect request-scoped SSR stores and consistent hydration snapshots.
- Read entity data separately through existing selectors or projections. Do not
  add automatic fetching, response caching, retries, freshness, invalidation,
  pagination, persistence or offline synchronization in this stage.

## Agreed contract

- One optional `@repo/request-react` package supports generated operations from
  both toolkits. Standalone write lifecycles and arbitrary workflow binding are
  outside this stage; the tracker workflows remain unchanged.
- Both hooks bind variables through the supplied operation input. Changing the
  input changes the observed canonical key without starting a request.
  `request` is an idle value or the existing keyed record, including its
  request ID and error where applicable; it is not the individual outcome.
- `trigger()` returns a Promise of the operation outcome. Expected request
  failure is a failed outcome; execution errors and defects reject. There is no
  hook-level cancellation, and unmounting or changing keys does not cancel
  previously triggered work.
- The hook uses `Effect.runPromise` for the supplied operation and does not
  provide a managed runtime or additional Effect services. The subscription
  source and operation service must represent the same store. Sharing requires
  the exact same receiving service as other callers; a separately constructed
  wrapper cannot join a private workflow service's pending request.
- SSR and hydration use equivalent request-scoped store snapshots. The package
  README documents integration and the service-identity limitation.

## Test-first implementation stages

1. Write public-consumer React tests for both store approaches before
   implementation. Establish manual-only behavior, inference, idle state,
   keyed subscription, stable snapshots and independent store instances.
2. Test requests started both inside and outside hooks; cover success, failure,
   cancellation, superseded and skipped outcomes, shared query waiters and
   duplicate mutations. Verify error propagation and no extra network calls.
3. Implement optional React integration without changing existing request
   mechanics or bypassing app policy. Add an agreed end-to-end example and
   verify SSR/hydration and subscription cleanup.
4. Update README and the comparison guide to describe the final contract and
   its limits. Run focused tests, then workspace lint, type-check, tests and
   production builds.

## Acceptance checklist

- [x] Query and mutation hooks expose typed manual triggers and status/errors.
- [x] Mount, render, subscription and argument changes do not start requests.
- [x] Metadata is store-owned, keyed consistently and observable across consumers.
- [x] Different stores and keys remain isolated; idle and terminal states are clear.
- [x] Trigger outcomes, errors, cancellation and existing request guards remain visible.
- [x] Shared reads and duplicate mutations retain their existing semantics.
- [x] App-owned workflow policy and standalone lifecycles are not bypassed or
      misrepresented.
- [x] Entity data remains normalized and separately selected; no response cache
      or automatic fetching is introduced.
- [x] SSR, hydration, resource ownership and subscription cleanup are tested.
- [x] Both public consumer paths, existing workflows and headless use are tested.
- [x] Documentation reflects the implemented API and remaining limitations.
- [x] Workspace lint, type-check, tests and production builds pass.

## Completed outcome

The optional React package exposes `useQuery` and `useMutation` for generated
request operations. Both independent request toolkits provide an operation-owned
metadata selector, while their execution and reducer mechanics remain separate.
React consumer tests exercise both real implementations via public exports.
Existing tracker workflows and standalone lifecycle writes remain unchanged.
`pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed: 591 tests and
both production app builds succeeded.
