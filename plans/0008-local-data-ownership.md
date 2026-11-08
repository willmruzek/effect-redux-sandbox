# 0008: Local data in the frontend database

**Status: TO BE IMPLEMENTED**

## Goal

Treat the normalized store as the frontend application's authoritative database,
not merely a container for request results. Support local-only entities and local
attributes of server-backed entities alongside remote data, with TanStack DB
remaining a read-only reactive projection.

Build on [generated API reducers](0007-generated-api-reducers.md). Request
metadata remains a separate concern; local changes require neither transport nor
a remote request lifecycle.

## Data ownership

| Category | Store representation | Write path |
| --- | --- | --- |
| Server-backed entities | Normalized remote tables | App-owned remote workflow with optimism, confirmation and rollback |
| Local-only entities | Normalized local tables | Validated synchronous domain action |
| Local attributes of remote entities | Local companion table keyed by the remote entity ID | Validated synchronous domain action |
| Drafts intended for remote creation | Explicit draft/pending state | Existing remote creation workflow |

Use separate tables rather than mixing local and remote fields in one record.
For example, server-backed `tasks`, local `taskPreferences` keyed by task ID,
and local-only `scratchNotes` can coexist in one store.
Transport responses cannot replace companion records because they update only
their own remote tables.

Local-only means not sent to the server; it does not imply durable persistence,
offline synchronization, private storage or future server ownership.

## Configuration and write boundaries

- Declare local versus remote ownership at the table boundary, separately from
  operation execution. Keep declarations outside reducer state.
- Remote write definitions use explicit typed transport inputs that contain only
  server-owned fields. Do not serialize an entire frontend view or infer
  transport eligibility from arbitrary field values.
- Local writes validate and synchronously dispatch ordinary data actions. Do not
  simulate an HTTP request, pending ownership or successful remote confirmation.
- A user intent affecting both categories separates its local commit from its
  remote workflow. Remote failure rolls back remote optimism only; an independent
  local preference remains committed.
- Preserve app-owned domain policy and separate Redux/Effect implementations.
  Reuse current slices and workflows before introducing new generic helpers.

Before implementation, settle the concrete table declaration API and the
demonstration domain. Any public API change requires an explicit decision; this
plan does not prescribe a new schema DSL or compatibility wrapper.

## TanStack DB integration

- Extend the existing store-to-collection adapter to project local tables along
  with remote tables. TanStack DB does not become another write authority.
- Preserve one source publication for related table changes, following the
  adapter's existing reconciliation pattern.
- Expose local-only records through collections and join local companion
  records to remote entities by ID.
- Use a left join for optional preferences so missing local rows never hide
  remote entities. Defaults belong in the read projection, not remote payloads.
- A local action should update live projections without any fetch or refresh.
- Keep request-local/browser-local stores and collection cleanup isolated.
  Hydration reconstructs projections from the store, not a separate DB snapshot.

## Deletion, retention and hydration

Define these policies explicitly before implementing their behavior:

- Whether authoritative deletion of a remote entity removes its local companion
  record or retains it, and how that differs from temporary query absence.
- What happens to companion records if remote creation replaces a temporary ID.
- Which local data, if any, is serialized into SSR hydration. Browser-only data
  must not leak into server snapshots or other store instances.

Query-result membership, normalized entity retention and local-data retention
are different concerns. Server reads and first-page refresh must not erase local
tables. Future cache eviction must not implicitly delete local records or
entities still referenced by them.

Start with in-memory local data. Durable browser persistence, migrations,
cross-tab synchronization and offline queues require separate plans.

## Test-first implementation stages

1. Agree on the table ownership contract and a small demonstration of a local
   entity plus a local companion record. Resolve deletion and hydration policy.
2. Add focused public-consumer tests for both store approaches before adding
   ownership declarations and local actions.
3. Verify typed remote inputs and merges cannot carry or overwrite local fields.
   Preserve the existing remote request and write lifecycle behavior.
4. Add TanStack DB projection tests for local updates, optional joins and store
   isolation, then wire the agreed application example.
5. Update README, comparison guide and this plan to describe the implemented
   contracts. Validate focused checks before the workspace suite.

## Acceptance checklist

- [ ] Local-only records and remote records coexist in normalized store state.
- [ ] Local writes are synchronous, validated and perform zero transport calls.
- [ ] Server reads, refresh and confirmations preserve local companion data.
- [ ] Failed remote writes do not roll back independent local changes.
- [ ] Typed remote payloads exclude local fields.
- [ ] Optional companion joins retain remote entities when local rows are absent.
- [ ] Local actions update reactive projections without a request.
- [ ] Deletion, temporary-ID and hydration policies are documented and tested.
- [ ] Local data and resources remain isolated between store instances.
- [ ] State and reducer outputs contain only data.
- [ ] Existing shared reads, generated API reducers and remote workflows pass.
- [ ] Workspace lint, type-check, tests and production builds pass.

## Scope exclusions

No endpoint response cache, field-level synchronization engine, automatic
transport routing, durable persistence, authentication, offline synchronization,
new hook layer or implementation of the separate pagination/freshness/refetch/
invalidation roadmap.
