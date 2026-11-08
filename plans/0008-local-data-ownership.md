# 0008: Local data in the frontend database

**Status: IMPLEMENTED**

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

## Approved demonstration

Both tracker apps use the shared UI to demonstrate:

- A star toggle on each task, backed by a local companion record containing
  the task ID and a `starred` boolean. Missing records read as unstarred.
  Once toggled, retain an explicit record even when `starred` is false.
- A local scratch-note list with generated IDs and trimmed, non-empty text.
  Support adding and deleting notes, but not editing or an arbitrary length
  limit. Reject invalid additions and deletion of unknown notes visibly.

Local actions are synchronous and do not start requests. Validation failures
return an explicit typed success/error result to the caller, which displays
the error in the relevant UI; invalid writes do not change store state.
Generate note IDs outside reducers and keep state and actions data-only.

## Configuration and write boundaries

- Use typed app-owned table declarations to describe local versus remote
  ownership, separately from operation execution and outside reducer state.
  Declarations do not automatically route writes or enforce ownership.
- Remote write definitions use explicit typed transport inputs that contain only
  server-owned fields, constructed explicitly at the transport boundary.
  Type annotations alone do not remove extra runtime properties; do not
  serialize an entire frontend view or infer transport eligibility from
  arbitrary field values.
- Local writes validate and synchronously dispatch ordinary data actions. Do not
  simulate an HTTP request, pending ownership or successful remote confirmation.
- A user intent affecting both categories separates its local commit from its
  remote workflow. Remote failure rolls back remote optimism only; an independent
  local preference remains committed.
- Preserve app-owned domain policy and separate Redux/Effect implementations.
  Reuse current slices and workflows before introducing new generic helpers.

Use explicit app-owned write paths rather than a new schema DSL or automatic
transport routing. Adding tables changes the tracker state shape: migrate all
in-repository constructors and consumers together rather than accepting old
snapshots through compatibility shims.

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

- Confirmed task deletion removes its local preference. Pending or failed
  deletion, filtering and absence from a query page do not remove it.
  Reject preference changes while deletion is pending and reject changes for
  nonexistent tasks.
- Allow preferences on temporary tasks, including failed creation drafts.
  On successful creation, move the temporary preference to the server ID and
  remove the temporary record. If the server ID already has a preference, that
  existing record wins, including an explicit unstarred value. Discarding a
  draft removes its preference.
- Start both local tables empty during SSR and hydration. Browser changes remain
  in the in-memory store until reload; do not restore or persist them in this
  plan. Keep stores isolated across requests and browser instances.

Query-result membership, normalized entity retention and local-data retention
are different concerns. Server reads and first-page refresh must not erase local
tables. Future cache eviction must not implicitly delete local records or
entities still referenced by them.

Start with in-memory local data. Durable browser persistence, migrations,
cross-tab synchronization and offline queues require separate plans.

## Test-first implementation stages

1. Add focused tests for both store approaches before adding the app-owned
   ownership declarations, local actions and approved tracker UI.
2. Cover validation, empty SSR/hydration state, deletion, draft ID remapping
   and collision handling, including explicit false preferences.
3. Verify typed remote inputs and merges cannot carry or overwrite local fields.
   Verify actual serialized payloads exclude local fields. Test local and
   remote write independence without adding a combined UI workflow; preserve
   existing remote request and write lifecycle behavior.
4. Add TanStack DB projection tests for local updates, optional joins and store
   isolation, then wire the agreed application example.
5. Update README, comparison guide and this plan to describe the implemented
   contracts. Validate focused checks before the workspace suite.

## Acceptance checklist

- [x] Local-only records and remote records coexist in normalized store state.
- [x] Local writes are synchronous, validated and perform zero transport calls.
- [x] Both apps expose task stars and scratch-note add/delete in the shared UI.
- [x] Invalid local writes return explicit errors, display them and leave state unchanged.
- [x] Missing preferences default to unstarred; explicit false records are retained.
- [x] Server reads, refresh and confirmations preserve local companion data.
- [x] Failed remote writes do not roll back independent local changes.
- [x] Explicitly constructed and serialized remote payloads exclude local fields.
- [x] Optional companion joins retain remote entities when local rows are absent.
- [x] Local actions update reactive projections without a request.
- [x] Confirmed deletion, draft discard, ID remapping and collision policies are tested.
- [x] Pending/failed deletion and query absence preserve preferences.
- [x] Local tables start empty on SSR and hydration and are not persisted.
- [x] Local data and resources remain isolated between store instances.
- [x] State and reducer outputs contain only data.
- [x] Existing shared reads, generated API reducers and remote workflows pass.
- [x] Workspace lint, type-check, tests and production builds pass.

## Completed outcome

The shared tracker owns the table declarations, local validation and read-only
projection; each app composes the local actions and retains its own remote
workflow and lifecycle reducers. Task preferences use `{ taskId, starred }`;
scratch notes use `{ id, text }`. The UI exposes both local data types, and
GraphQL and REST creation inputs are explicitly constructed from remote fields.

The full workspace passed lint, type-check, 563 tests and both production builds.
The behavior is in-memory only; the separate offline-first roadmap is unchanged.

## Scope exclusions

No endpoint response cache, field-level synchronization engine, automatic
transport routing, durable persistence, authentication, offline synchronization,
new hook layer or implementation of the separate pagination/freshness/refetch/
invalidation roadmap.
