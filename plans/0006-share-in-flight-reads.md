# 0006: Share in-flight reads

**Status: IMPLEMENTED**

## Inherits and adds

Build on [consumer proof](0005-prove-the-layers.md) by replacing duplicate-query
skipping with shared in-flight execution in both independent request toolkits.
This approves only the request-sharing item previously deferred in
[additional layers](0003-additional-layers.md).

## Approved behavior

- Keep `run` lazy and Effect-valued. Callers share one execution and its terminal
  outcome, not necessarily the same external JavaScript Promise object.
- Preserve immediate started-action publication when the receiving service is
  synchronous, including duplicates launched by started-action observers.
- Share queries only for the same operation, stable receiving store service
  object and canonical variable key. The first caller supplies transport options.
- Publish one started action and one settlement lifecycle for that execution.
- Every waiter receives the original success, failure or superseded outcome;
  typed errors and defects propagate through Effect without flattening causes.
- Cancelling any caller stops only its wait. Interrupt transport and release
  pending reducer ownership when the last waiter leaves.
- Release the in-flight entry after every settlement, interruption or defect.
  A later call performs a new read; completed results are not cached.
- Pending query metadata without a local execution fails explicitly rather than
  pretending to share a nonexistent request.
- Mutations retain duplicate-pending skipping. Standalone write lifecycles retain
  their existing duplicate-write rejection.

## Implementation boundaries

Each toolkit owns its own typed, operation-local weak registry keyed by the
receiving store service. A reference-counted worker runs independently of any
single caller and is explicitly interrupted by its final departing waiter.
The worker inherits the first caller's Effect context; it does not create a
runtime. All waiters release their references through finalization.

Reducers remain explicitly registered and data-only. Keep request IDs,
latest-wins settlement guards and cancellation/publication cleanup. Do not add a
cross-store engine, Promise API, compatibility wrapper, completed-result cache,
freshness policy, automatic invalidation or UI subscriptions.

## Test-first acceptance

- Duplicate queries wait for the same outcome with one transport/lifecycle.
- Shared success, transport failure and superseded outcomes remain observable.
- Cancelling the original caller does not stop a remaining waiter.
- Cancelling a duplicate does not stop the original caller.
- Cancelling all waiters aborts transport, releases ownership and permits retry.
- Settlement releases the entry and permits a fresh request.
- Different variable keys and receiving stores never share execution.
- Missing local execution and missing reducer ownership fail before transport.
- Query definitions stay lazy; duplicate mutations remain unshared.
- Synchronous services preserve existing startup timing and reentrant observers
  join the registered execution rather than launching another transport.
- Run focused toolkit/consumer tests, then workspace lint, type-check, tests and
  production builds. Update the guide and current contracts after implementation.

## Completed outcome

- Both independent toolkit engines share normalized query execution and terminal
  outcomes through typed, store-local worker registries outside reducer state.
- Reference-counted cancellation preserves remaining waiters and waits for
  cleanup before a new execution can claim the same key.
- Tests cover shared outcomes and defects, transport-option ownership, isolated
  stores, cancellation races, fresh retries, laziness and synchronous observers.
- The existing Effect API, mutation skipping, standalone write guards and app
  workflows remain unchanged. Immediate startup is preserved for synchronous
  services; no cache or compatibility wrapper was added.
- The [comparison guide](../docs/prove-the-layers.md) and workspace contracts now
  describe shared queries rather than duplicate-query skipping.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed: all 516 tests
  and both production app builds succeeded.
