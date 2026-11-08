# Manual request hooks

`@repo/request-react` is an optional React integration for generated operations
from either `@repo/redux-toolkit` or `@repo/effect-store-toolkit`. It does not
install reducers or replace app-owned workflows.

Both `useQuery` and `useMutation` accept an operation, a subscription source and
the operation's typed run input:

```tsx
const { request, trigger } = useQuery({
  operation: api.operations.person,
  source: { subscribe: store.subscribe, getSnapshot: store.getState },
  input: {
    store: service,
    variables: { id },
    execute: fetchPerson,
  },
});
```

For an Effect store, use its `subscribe` and `getSnapshot` as the source.
The source and `input.store` must represent the same store. Construct and retain
the Effect-facing service outside React rendering: query sharing depends on
the *same service object*, operation definition and canonical key, not merely
on equivalent service wrappers. A pending query owned by a different service
cannot join the existing execution and fails explicitly. In particular, if an
application keeps its workflow service private, a new wrapper cannot share
that workflow's in-flight query; arranging a common service remains app-owned.

`request` is `idle` before the bound key has metadata; otherwise it is the
store-owned `pending`, `succeeded`, `failed`, `cancelled` or `superseded`
record, including its request ID and, for failures and cancellations, its error.
It tracks that key even when another caller starts the request. Changing
variables switches observation without fetching. For a mutation, the status
is keyed by variables too, not the most recent call from a component.

`trigger()` runs the operation with the current input and returns a Promise of
its existing outcome. Expected transport failures resolve to a `failed` outcome;
execution errors and defects reject. Handle both. Duplicate pending mutations
resolve to `skipped`, while matching queries share the first caller's
execution and outcome. The hook runs the operation with `Effect.runPromise`;
it does not supply an application-specific Effect context or managed runtime.

Mounting, rendering and subscribing do not start requests. Unmounting or
changing variables does not cancel a trigger already started; the hook does not
provide a cancellation handle. Requests started elsewhere can still be
cancelled through their own execution mechanism and the hook observes their
resulting metadata. SSR callers must provide request-scoped stores and hydrate
from equivalent initial snapshots.

These hooks do not return normalized entities, execute standalone write
lifecycles, bind arbitrary domain workflows or fetch automatically. Select data
using the application's existing store selectors or TanStack DB projections.
