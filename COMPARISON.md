# Redux-first and Effect-first comparison

Both apps implement the same tracker with independent store and request
implementations. This document describes their shared contracts, differences,
and the behavior of the demo. For step-by-step read and write traces and
headless consumer examples, see [Prove the layers](docs/prove-the-layers.md).
For the concise query-library comparison and roadmap, see the
[README](README.md).

## Workspace ownership

| Location | Responsibility |
| --- | --- |
| `apps/redux-first/` | Redux store composition, Effect middleware, workflows and runtime |
| `apps/effect-first/` | Custom store composition, workflows and runtime |
| `packages/redux-toolkit/` | Redux-backed request and lifecycle utilities |
| `packages/effect-store/` | Custom store and Effect-facing service |
| `packages/effect-store-toolkit/` | Slices, requests and lifecycles for the custom store |
| `packages/effect-store-react/` | React binding for custom stores |
| `packages/effect-store-logger/` | Plain-action console logger |
| `packages/request-react/` | Optional manual query and mutation hooks |
| `packages/project-tracker/` | Shared UI, domain data and read-only projections |
| `packages/tracker-graphql/` | Demo backend, GraphQL and REST clients, and response validation |
| `packages/gql-api/` | Transport, canonical variable keys and entity utilities |
| `tools/layer-examples/` | Headless consumers and dependency-boundary tests |
| `tools/` | Shared lint and TypeScript configuration |

## Dispatch design

Both stores follow the same behavioral contract:

| Operation | Behavior |
| --- | --- |
| External `dispatch(action)` | Synchronously runs action middleware, reducer and subscriptions; returns the action |
| External `dispatch(effect)` | Uses the supplied application runtime; returns `Promise<A>` |
| Internal service `dispatch(action)` | Returns a lazy Effect; executing it synchronously commits the action |
| Internal service `dispatch(effect)` | Composes in the caller's execution; returns an Effect, not a Promise |
| Internal service `getState` | Effect-valued live state read |

There are no dispatch queues or asynchronous plain-action middleware. Workflows
perform asynchronous work before/after synchronous state transitions. An Effect
block containing multiple dispatches is not a transaction.
Reducers only transition data: state and reducer outputs never contain
functions, Effects, Promises, fibers, or callbacks. Asynchronous work and other
behavior remain in workflows outside the reducer state.

Nested Effect dispatch supplies only the receiving store service. It preserves
the other requirements, typed errors, caller context and interruption. It does
not start a separate runtime or intercept programs through an Effect-specific
middleware pipeline. Ordinary actions still pass through action middleware.

External dispatch accepts only Effects whose remaining requirements the supplied
runtime can provide. Its Promise retains the success type, but JavaScript Promise
rejections do not encode the typed error channel. Inside Effect composition,
expected error types remain available for recovery.

### Redux example

```ts
import { Effect, Layer, ManagedRuntime } from 'effect';
import { createAppStore, trackerActions } from './apps/redux-first/src/store';
import { ReduxStore } from './apps/redux-first/src/reduxStore';

const runtime = ManagedRuntime.make(Layer.empty);
const store = createAppStore(runtime);

// Plain actions are synchronous.
store.dispatch(trackerActions.projectSelected('atlas'));

const child = Effect.gen(function*() {
  const store = yield* ReduxStore;
  yield* store.dispatch(trackerActions.projectSelected('studio'));
  return (yield* store.getState).selectedProjectId;
});

const parent = Effect.gen(function*() {
  const store = yield* ReduxStore;
  return yield* store.dispatch(child);
});

// Only this external boundary executes through the application runtime.
const selected = await store.dispatch(parent);

// The application, not the store, owns shutdown.
await runtime.dispose();
```

The Redux app retains Redux Toolkit's default middleware, including thunk
support on the external Redux dispatch. Its Effect service exposes plain actions
and composable Effects, not a thunk/Promise bridge. State is owned by RTK slices,
and plain actions remain visible in Redux DevTools.

### Custom-store implementation

The Effect-first app has no Redux, Redux Toolkit or React Redux dependency.
Its app-local store uses immutable snapshots and synchronous subscriptions,
without `SubscriptionRef`, semaphores, or detached subscription fibers.
Reducers cannot read or dispatch through the store while they are executing.

Its `EffectStore` service has the same dispatch behavior described above, but
uses its own action types and implementation. Domain fetch/save workflows are
separate from the Redux app's workflows.

The local `createSlice` uses Immer and a cast-free registration builder:

```ts
import { createSlice, type PayloadAction } from '@repo/effect-store-toolkit';

const slice = createSlice({
  name: 'counter',
  initialState: { count: 0 },
  reducers: (slice) => ({
    added: slice.reducer('added', (state, action: PayloadAction<number>) => {
      state.count += action.payload;
    }),
  }),
});
```

Generated creators retain namespaced action types and payload inference.
Reducers support Immer drafts or replacement state, structural sharing and
frozen snapshots. Duplicate or late registrations throw explicit errors.

### Runtime and resource lifetimes

Both `createAppStore` functions require an application-supplied `ManagedRuntime`
as their first argument, with optional initial tracker state as the second.
Stores neither create nor dispose that runtime.

The demos own their runtime in app-local `runtime.ts`. Layers are initialized
lazily, not during React render. Real unmount disposes the runtime and interrupts
its owned work. Microtask-deferred disposal allows React Strict Mode's
setup/cleanup replay to reclaim the committed runtime.
Initial loaders own separate request-local runtimes and dispose them in `finally`.
There are no module-level store or runtime singletons.

Dispatch never automatically creates or closes a resource scope. A program
requiring `Scope` keeps that requirement until the caller supplies it, for example
with `Effect.scoped` or an explicitly owned scope. Merely finishing a dispatch
does not close a caller-owned scope.

External cancellation is not part of the initial dispatch API. Workflows can
compose child fibers and cancellation using normal Effect primitives. Runtime
shutdown belongs to the application. Cancellation does not roll back committed
actions or guarantee that a server mutation stopped.

### Failures and logging

Workflows own their started/succeeded/failed actions. Unhandled errors and defects
reject the external Promise; dispatch does not invent generic failure actions.
Plain-action reducer failures throw synchronously.

Store logs contain plain actions only. The custom store's development logger
records before/after state, duration and synchronous action failures in closed
console groups. It never logs Effect programs. Redux DevTools likewise receives
the ordinary actions forwarded through Redux.

## Transport-neutral request lifecycles

Each app composes a separate `createRequestApi` implementation. The reusable
engines and their tests live in `@repo/redux-toolkit` and
`@repo/effect-store-toolkit`. Both independently generate Immer request metadata
reducers; standalone write cases use their respective slice builders.
Only HTTP transport, variable identities and entity utilities are shared
between the two engines.

Normalized query/mutation operations define variables, decoding, normalization
and request scopes. GraphQL uses a document and endpoint; REST or other transports
supply an `execute` callback instead. `createRequestApi` returns definitions,
action creators and a generated `reducer(state, action)`, with no domain
initial-state factory. Its `getState`
accessor supplies the application state type; `state` locates request metadata
within an Immer draft.

The generated API reducer manages `requests` and `latest` metadata for every
defined operation. Install it once in the receiving store's reducer composition;
no per-action registration or domain callbacks are needed for execution.

Each operation's optional `reducer({ onStarted, onSuccess, onFailure })` returns a
separate guarded domain reducer. Compose domain reducers before the generated
API reducer so both inspect pre-transition ownership.

For tracker pages, the domain handler records loading and errors, while
`createCursorPagination` owns the page merge and cursor advancement together.
The workflow calls the generated query's `runWithResult`; its success handler
does not merge the page early. See the
[cursor contract](docs/prove-the-layers.md#cursor-pagination) for why this
ordering matters.

Both apps keep task-page decoding and normalization in `trackerApiDefinition.ts`
and domain reducers plus API reducer composition in `trackerApiReducers.ts`.
The app, not the API definition, owns initial domain state. API creation installs
nothing in a store; execution fails explicitly if the generated reducer is
omitted and its started action cannot claim ownership.
Duplicate pending queries share the original execution and outcome;
duplicate pending mutations still return a skipped outcome.

CRUD writes and people reads instead use standalone
`createRequestLifecycle<State, Result>()(prefix, { pending })` definitions.
Constructing a lifecycle generates started/confirmed/failed action creators and
an Effect-valued runner, but installs no reducers and requires no `state.api`
metadata. Each run takes `store`, `input` and an abort-aware `execute(signal)`
returning only saved domain data. The runner constructs request IDs and failure
messages.

State and saved-result types are declared once when defining the lifecycle.
Input is inferred from the pending accessor, and pending records from its return
type. Reducer callbacks and action creators inherit those types:

- Started payloads contain the input plus `requestId`.
- Confirmed payloads retain that input and ID, with saved data in `result`.
- Failed payloads retain that input and ID, with the failure message in `error`.

The app registers reducers separately with `createSlice`'s
`extraReducers.addCase`. Optional `operation.reducers({ onStarted, onConfirmed,
onFailed })` helpers return guarded case reducers, not a registered slice.
Each case must still be registered explicitly against its generated action.
Consumers can also write handlers directly or register additional observers
without using the ownership helpers.

`onConfirmed(state, payload, result, pending)` receives saved data separately
from the original input. This lets optimistic values differ from server values
without rebuilding request metadata. Each app keeps definitions in
`trackerOperations.ts` and its transitions and registrations in
`trackerOperationReducers.ts`.

For status, priority and assignee, the optional
`createOptimisticFieldReducers<State, Input>()` helper supplies those value
transitions. The app selects the mutable field and its write table, extracts
the optimistic value and supplies an explicit `canStart` rule. The helper
captures the original before applying optimism, accepts the saved result on
confirmation and restores the original with a visible error on failure.
It neither claims ownership nor registers cases; the lifecycle guards still
wrap its callbacks. Start eligibility does not block settlement of an existing
write. Creation, deletion and detail merging do not use this field helper.

Operation inputs reuse named domain contracts. Status, priority and assignee
all use `{ taskId, value }` through `TaskFieldInput<Value>`; assignee values may
be null. Results remain typed domain entities or field values, not reconstructed
lifecycle payloads.

### Domain validation pattern

Shared business rules live in `packages/project-tracker/src/taskValidation.ts`,
not in the store toolkits or normalized read API definitions.
`validateTaskEdit(state, input)` checks task existence, creation drafts, pending
deletions and the selected field's pending save. Assignee edits also require an
existing person unless the value is null. `validateTaskDeletion(state, input)`
rejects drafts and conflicts with pending field or detail saves.
Failed writes do not block retries; saves of independent fields remain independent.

These pure functions take a read-only domain snapshot and return either
`{ status: 'valid', task }` or `{ status: 'invalid', error }`. They do not mutate
state, dispatch actions, execute Effects or perform transport I/O.
Both apps call them before starting a lifecycle and explicitly convert invalid
results into their existing `Effect.fail(new Error(error))` failure path.
Operation-specific error messages and their precedence remain stable.

The pattern has three distinct responsibilities:

| Layer | Responsibility |
| --- | --- |
| Shared domain | Decide whether the requested task operation is allowed |
| App workflow | Obtain state, surface validation failures, choose transport and refresh after success |
| Optional toolkit | Claim request ownership, reject duplicates and guard stale settlements |

Snapshot validation is a preflight check, not a replacement for lifecycle
ownership or reducer start guards. Reducer registration and optimistic
transitions remain explicit. Backend input validation remains authoritative
and separate: client state cannot establish what is currently valid on the
server. Creation retry and person rename rules remain in their existing workflows.

### Request execution

The runner rejects duplicate pending claims, guards settlements against stale
owners and cleans up on interruption or publication failure. The app defines
its pending record accessor, optimistic transitions, authoritative merge and
rollback. Independent fields retain independent ownership; reducer state
contains data only. Domain actions such as `tracker/statusStarted` remain
visible in the log. If no started handler claims ownership in the receiving
store, execution fails explicitly rather than performing an untracked write.

This is the same separation of execution/lifecycle generation from reducer
behavior that `createAsyncThunk` provides, using Effect execution for both stores
instead of adding a thunk-specific workflow to the Redux app.

The shared `ProjectTracker` component takes a `TrackerViewState` snapshot.
Source mode, people loading/errors, creation notices and pending deletions are
derived from that state instead of being passed again as separate props.
Callbacks and the relational projection's source remain explicit inputs; each
app still owns its initial-state construction, reducers and runtime.

- Generated lifecycle actions are `trackerApi/tasks/started`, `succeeded`,
  `failed` and `cancelled`, with normalized entity success payloads.
- Store-owned request metadata contains status, request IDs and errors, never a
  second response/document cache.
- Canonical variable keys ignore object property order, preserve array order,
  and reject cycles and non-JSON values.
- Identical pending queries share one execution per operation, stable receiving
  store service object and canonical key. The first caller supplies transport
  options and Effect context. Duplicate callers await the same outcome, not
  necessarily an identical external Promise object.
- Cancelling one query waiter leaves the others running. The last departing
  waiter interrupts the worker and waits for ownership cleanup. A new caller
  arriving during cancellation waits for cleanup before starting a fresh read.
- The operation-local in-flight registry contains fibers outside reducer state.
  Entries are released on settlement, failure, defect and interruption; completed
  results are not cached. Pending query metadata without a local execution fails
  explicitly. Reuse the same API definition and store service for shared reads.
- Duplicate pending normalized mutations still skip. Standalone CRUD write
  lifecycles retain duplicate-write rejection.
- The optional [manual request hooks](packages/request-react/README.md) observe
  generated operation metadata and trigger those operations explicitly. They
  do not bind standalone lifecycles or replace app-owned workflows.
- Latest-wins scopes guard replacement queries. Stale responses cannot overwrite
  a newer request or change its snapshot identity.
- Explicit retry is supported. Task examples can use GraphQL, REST, or mixed
  GraphQL-task/REST-people sources; both apps keep transport workflows local.
- Refresh reloads the first backend page. There is no automatic retry,
  polling, cache eviction, durable persistence or offline outbox.
- GraphQL errors, including partial data with errors, fail before normalization.
  Expected transport failures become failure outcomes and lifecycle actions.
  Reducer defects remain failures; cleanup prevents stuck pending ownership.
- Entity definitions explicitly map keys and relationships. IDs are scoped by
  table; merging replaces incoming records by ID and retains unrelated records.
  Partial-field merge and deletion policy remain application-defined.

## Dataset, pagination and hydration

Both apps expose `POST /graphql` with the same shared GraphQL.js handler and
deterministic dataset: **200 tasks, twelve projects and twenty people**.
The backend performs filters and ordering before cursor pagination, with
twenty tasks per request.

Supported filters are project, status, assignee (including unassigned), and
case-insensitive literal title search. Sorting supports task ID, title A-Z and
priority high-first, with task ID breaking ties. Title search is debounced by
300 ms. Load more uses the current connection's cursor; filter/sort changes
replace visible IDs on success while preserving the old view during loading/error.
Backend totals/status counts are distinguished from cumulative cached aggregates.

The root loader fetches the first twenty tasks plus project/person lookup tables.
Its state initializes the app-owned store at the root, so navigating between the
ledger and detail keeps one normalized cache. Request-local/browser-local
TanStack DB collections are synchronously reconstructed from store state; no DB
snapshot is transported. The root route uses `staleTime: Infinity`, so hydration
does not repeat the initial ledger fetch. Redux supplies its initialized store
snapshot as the Provider's server state.

The endpoint supports GraphQL selection, aliases, variables and operation names:

```sh
curl http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  --data '{"query":"{ tracker(first: 20) { tasks { edges { cursor node { id title } } pageInfo { endCursor hasNextPage } totalCount } } }"}'
```

The connection is
`tracker(first: Int = 20, after: String, query: TaskQuery, fail: Boolean, delayMs: Int)`.
GET returns 405 with `Allow: POST`; invalid transport bodies return 400.
Schema/validation/execution errors use the GraphQL `errors` response shape.
Each app's server-only `backend.ts` owns one in-memory repository, shared by its
SSR API fetches and browser requests. The shared handler factory owns no global
mutable data. Browser refresh retains saved values; server restart restores the
deterministic seed. Browsers using the same app server intentionally share demo
data. There are no sessions, cookies or authentication; this is not a production
multi-user backend. Development hot reload can recreate the server module and
reset its repository.

`updateTask(id: ID!, patch: TaskPatch!, fail: Boolean, delayMs: Int)` validates
titles (1-200 characters after trimming), descriptions (at most 5000 characters),
status, priority and relationship IDs before updating a task. Omitted fields
remain unchanged; null clears the assignee or description. Independent field
writes are ordinary last-write-wins CRUD updates.

Latency is per operation: `delayMs` must be an integer from 0 to 5000, defaulting
to zero. The UI sends 700 ms for writes and exposes independent failure controls.
The read operation retains its deliberate `fail` control.
`resetDemo` restores seed data and rejects delayed mutations started before reset:

```sh
curl http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  --data '{"query":"mutation { resetDemo }"}'
```

Reload the browser after reset to reconstruct its store from the restored data.
Client cancellation does not guarantee a server mutation has stopped.

### REST and mixed-source examples

Both app servers also expose a REST transport backed by the same app-owned
repository as GraphQL:

- `GET /api/tracker` supports `first`, `after`, `projectId`, `status`, `search`,
  `assigneeId`, and `sort` query parameters and returns the shared task-page
  shape.
- `GET /api/tasks/:id`, `POST /api/tasks`, `PATCH /api/tasks/:id`, and
  `DELETE /api/tasks/:id` provide task detail and CRUD with shared validation,
  delay, and failure semantics.
- `GET /api/people` and `PATCH /api/people/:id` provide the REST-owned people
  read and rename operations.
- `POST /api/reset` restores the app's deterministic seed.

Use the **Data example** selector to switch between GraphQL-only, REST-only and
mixed examples without duplicating either app. Mixed mode reads tasks from
GraphQL and people from REST; renames use REST while task reassignment uses
GraphQL. Request IDs keep late responses from the previous source from replacing
the active result. REST errors use an HTTP status and `{ "error": "..." }` body.

### Task detail routes

Select a task title to open its detail page, or visit `/tasks/ATL-01` directly.
The by-ID query can load tasks outside the current ledger page; links preserve
the selected task source in the URL. Both apps keep the same root-owned store
while moving between the list and details;
the route loader hydrates the selected task into the normalized entity rather
than caching a second response copy. Missing tasks have an explicit not-found
view, and detail load failures show a retry action.

The detail form edits the title and description. Description is intentionally
omitted from list payloads: an omitted description is preserved, while an
explicit `null` clears it. Saves use the selected task transport and refresh
the first backend page.

The list/detail routes and source-mode examples are implemented. The current
demo intentionally stops at basic CRUD and request lifecycle behavior.

### Task creation

The task form creates a task through the selected transport. It validates the
title, status, priority, project and optional assignee on the server. A new task
is represented optimistically with a temporary ID, then replaced by the
authoritative server entity on success. Failed creations remain visible for
explicit retry or discard. Retries are ordinary create requests and may create
a duplicate if the original response was lost after the server committed.

The server repository persists committed tasks across browser refreshes and
resets on server restart or explicit reset. Pending local drafts are not
persisted.

### Refresh and deletion

**Refresh tasks** reloads the first backend page for the current query. Additional
pages remain loadable with fresh cursors. The current view stays visible while
refresh is pending or after a failure; **Retry refresh** repeats the first-page
request. Newer queries and source selections supersede older reads.

Each ledger row has a **Delete** action with explicit confirmation. A pending
delete hides the row; failure restores it, and success removes it then refreshes
the first page. There are no revision-conflict receipts or deletion tombstones.

## Store-owned data and read-only TanStack DB

Stores own normalized projects, people and tasks, visible result IDs/query/cursor
metadata, UI selections, pending/error writes, local task preferences and
scratch notes. TanStack DB is only a relational projection: no mutation handlers
or optimistic overlays.

The shared tracker declares table ownership outside state. Its synchronous local
action boundary validates task stars and trimmed scratch-note additions/deletions,
returns explicit results to the UI and never starts transport. The ledger left
joins preferences to tasks; absent preferences mean unstarred. Explicit false
preferences are retained. The app builds remote payloads from server-owned
fields rather than serializing local tables.

Confirmed deletion removes the task preference; a pending or failed deletion
does not. A draft preference follows its confirmed ID unless that ID already has
one, in which case the existing preference wins. Discarding a failed draft also
removes its preference. Local tables start empty in SSR/hydration, remain
store-instance-local, and are lost on reload: there is no persistence or offline
sync in this stage. Remote rollback does not roll back independent local writes.

The shared projection reconciles a snapshot into one tagged entity collection
with a single sync transaction, skipping unchanged row references. Indexed
derived collections expose tasks/projects/people, task preferences and scratch
notes. One source publication keeps
live joins coherent; separate store dispatches remain separate publications.
Use live queries for cross-collection results, not imperative reads from
individual collection-change callbacks.

The ledger inner-joins projects and left-joins people, retaining unassigned tasks.
It joins current result IDs and preserves backend rank rather than reapplying
backend filtering. **Previous / Next** uses indexed five-row DB windows with
`offset`/`limit` and never fetches. Filter/sort changes reset the local page;
deletions clamp it, and empty results show page 1 of 1.
Live aggregates describe cached records and are labeled accordingly.
Search draft and local ledger page are the only view-owned query state.

### Optimistic writes

Status and priority each use started/confirmed/failed plain actions. Their
optimistic intent, confirmation and rollback all pass through the store log.
The GraphQL server delays writes by 700 ms and can fail either field.

Per-field request IDs guard settlement. Repeated edits to the same pending field
are rejected at the workflow boundary as well as disabled in the UI. Independent
fields/tasks may save concurrently. Confirmation and rollback update only the
owning field of the latest task, never an old whole-task snapshot.
Incoming pages preserve pending optimistic fields and retain off-view entities.
Confirmed values persist in the server repository and appear in subsequent reads.
Only the edited field is confirmed locally, preserving other in-flight edits.
Writes can change server result membership, ordering and totals. Use **Refresh
tasks** to reload the first page when those server-ranked results should update.

The shared UI dispatches Effects, never collection mutations. Its DB projection,
subscriptions and dependents clean up on unmount and survive Strict Mode replay.
TanStack React DB is pinned to `1.0.0-rc.1.4`; validate adapter/query changes
against the installed release-candidate types when upgrading.
