# 0005: Prove the layers

**Status: IMPLEMENTED**

## Inherits and adds

Inherit the core stores, base CRUD contract, optional layers and ergonomics
established by 0001 through 0004. Add executable consumer evidence and a
side-by-side implementation guide, without expanding tracker features.

## 1. Prove package independence

- Exercise plain Redux and the Effect core without slice or request helpers.
- Exercise optional slices without request APIs.
- Exercise normalized reads and optimistic writes through public toolkit exports.
- Use a headless consumer under `tools/`, not imports from app implementation.
- Verify dependency boundaries: core packages must not depend on toolkits,
  tracker packages or applications.
- Assert synchronous actions, subscriptions, typed snapshots and store isolation.

## 2. Explain the comparison

- Trace one tracker read from workflow to request actions, registered reducers,
  normalized entities, relational projection and shared UI.
- Trace one optimistic tracker write from domain validation through execution,
  confirmation/rollback and explicit refresh.
- Explain the intentional Redux middleware versus Effect core execution split.
- Link runnable examples and distinguish domain policy from generic mechanics.

## 3. Exercise public API ergonomics in a second domain

- Use a small inventory domain with numeric quantities, not tracker tasks.
- Demonstrate validated normalized reads and optimistic quantity writes.
- Cover authoritative results, visible rollback, duplicate ownership,
  stale settlements and missing reducer registration.
- Record concrete API friction and trade-offs, not speculative abstractions.
- Do not change public APIs or add compatibility shims without a separate decision.

## Acceptance

- Examples run through a documented package command without a dev server.
- Tests use public package exports and independent fixtures.
- Both store approaches satisfy the same observable inventory contracts.
- Package boundaries, runtime tests, type-check, lint and builds pass.
- Documentation records verified outcomes and remaining API trade-offs.

## Scope exclusions

No additional UI, cache, automatic invalidation, request sharing, deployment,
new generic cross-store engine or changes to existing app ownership.

## Completed outcome

- [Headless inventory consumers](../tools/layer-examples/src/) exercise core
  stores, optional slices and public request APIs with no tracker/app imports.
- 36 consumer and boundary tests cover both store approaches, including typed
  numeric results, decoding failures, optimism, rollback, duplicate requests,
  stale ownership, missing write registration and instance isolation.
- The [side-by-side guide](../docs/prove-the-layers.md) traces tracker reads and
  writes, documents runnable commands and records concrete API trade-offs.
- No public package API changes were needed. Explicit registration, typed state
  annotations and distinct slice/dispatch conventions remain intentional.
- Workspace lint, type-check, all 490 tests and production builds passed.

This proves public-export use inside the workspace, not independently published
artifact installation or bundle-size isolation. The guide records that boundary
and the inventory example's intentionally limited concurrent-read merge policy.

The completed outcome above records this stage.
[0006](0006-share-in-flight-reads.md) subsequently adds query sharing, and
[0007](0007-generated-api-reducers.md) replaces normalized per-action registration
with a generated API reducer and separate domain reducers. The consumers now
exercise those revised public contracts.
