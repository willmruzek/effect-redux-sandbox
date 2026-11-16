import { configureStore } from '@reduxjs/toolkit';
import {
  Context,
  Effect,
} from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi
} from 'vitest';

import {
  createGraphqlApi,
  createEntityTable,
  type RequestApiState,
  type RequestActions,
  type Store,
} from './index.js';

type Person = {
  readonly id: string;
  readonly name: string
};

type Variables = { readonly id: string };

type State = {
  readonly api: RequestApiState;
  readonly people: Readonly<Record<string, Person>>
};

class ApiStore extends Context.Service<ApiStore, Store<State, { readonly type: string }>>()('test/index/ApiStore') {}

type Fence = Readonly<{ identity: string; requestId: string }>;

function runEndpoint<StoreId, StoreShape, Variables extends object, Result>(
  endpoint: {
    readonly initiate: (
      variables: Variables,
      options?: Readonly<{ fence?: Fence }>,
    ) => Effect.Effect<Result, Error, StoreId>;
  },
  storeService: Context.Service<StoreId, StoreShape>,
  input: {
    readonly store: StoreShape;
    readonly variables: Variables;
    readonly fence?: Fence;
  },
): Effect.Effect<Result, Error> {
  return Effect.provideService(
    endpoint.initiate(
      input.variables,
      input.fence ? { fence: input.fence } : undefined,
    ),
    storeService,
    input.store,
  );
}

function setup(fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
  Response.json({ data: { person: { id: '1', name: 'Pat' } } }))) {
  const people = createEntityTable({
    name: 'people',

    key: (person: Person) => person.id
  });
  const operation = {
    document: 'query Person($id: ID!) { person(id: $id) { id name } }',

    decode: (data: unknown, variables: Variables): Person => {
      if (
        typeof data !== 'object' ||
        data === null ||
        !('person' in data) ||
        typeof data.person !== 'object' ||
        data.person === null ||
        !('id' in data.person) ||
        data.person.id !== variables.id ||
        !('name' in data.person) ||
        typeof data.person.name !== 'string'
      ) {
        throw new Error('Invalid person response.');
      }

      return { id: variables.id, name: data.person.name };
    },

    normalize: (person: Person) => people.normalize([person]),
  };
  const definition = createGraphqlApi({
    name: 'peopleApi',
    endpoint: '/graphql',
    fetcher,
    storeService: ApiStore,

    state: (state) => state.api,

    getState: (state: State) => state.api,

    endpoints: (api) => ({
      person: api.query('person', {
        ...operation,

        scope: () => 'selection'
      }),
      rename: api.mutation(
        'rename',
        { ...operation, document: 'mutation Rename { rename { id name } }' }
      ),
    }),
  });
  const callbacks = {
    onSuccess: (
      state: { people: Record<string, Person> },
      { result }: {
        result: Readonly<Record<string, Person>>;
      }
    ) => {
      state.people = { ...state.people, ...result };
    }
  };
  const person = definition.endpoints.person.reducer(callbacks);
  const rename = definition.endpoints.rename.reducer(callbacks);
  const api = {
    ...definition,
    reducer: ({ state = { api: { requests: {}, latest: {} }, people: {} }, action }: Readonly<{
      state: State | undefined;
      action: { readonly type: string };
    }>) => definition.reducer(rename(person(state, action), action), action),
  };
  const actions: RequestActions<typeof api.endpoints>[] = [];
  const redux = configureStore({
    reducer: (state: State | undefined, action) => api.reducer({ state, action }),
  });
  const store: ApiStore['Service'] = {
    getState: Effect.sync(redux.getState),

    dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
      actions.push(action);

      return redux.dispatch(action);
    }),
  };
  return {
    api,
    redux,
    store,
    actions,
    fetcher
  };
}

describe('Redux GraphQL API', () => {
  test('returns the normalized result through result-bearing query execution', async () => {
    // Arrange: use a generated query with a typed normalized response.
    const { api, store } = setup();

    // Act: execute the result-bearing query.
    const result = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      store,
      variables: { id: '1' },
    }));

    // Assert: the successful result is available without reading store metadata.
    expect(result).toEqual({ status: 'succeeded', result: { '1': { id: '1', name: 'Pat' } } });
  });

  test('does not install reducers or execute unowned requests', async () => {
    // Arrange: definitions alone and a store with no registered handlers.
    const execute = vi.fn(async () => ({ id: '1', name: 'Pat' }));
    const api = createGraphqlApi({
      name: 'unregistered',
      endpoint: '/graphql',
      storeService: ApiStore,
      getState: (state: State) => state.api,
      state: (state) => state.api,

      endpoints: (builder) => ({
        person: builder.query('person', {
          document: 'query Person { person }',
          transport: async () => ({ status: 'received', read: execute }),
          decode: (data: unknown, variables: Variables): Person => {
            if (typeof data !== 'object' || data === null || !('name' in data) || typeof data.name !== 'string')
              throw new Error('Invalid person response.');

            return { id: variables.id, name: data.name };
          },
          normalize: (person: Person) => person,
        }),
      }),
    });
    const state: State = { api: { requests: {}, latest: {} }, people: {} };

    // Act: dispatch cannot establish ownership without registered reducers.
    await expect(Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      store: {
        getState: Effect.succeed(state),
        dispatch: () => Effect.void,
      },
      variables: { id: '1' },
    }))).rejects.toThrow('Could not claim person request.');

    // Assert: definitions cannot silently install reducers or perform untracked I/O.
    expect(api.reducer).toBeTypeOf('function');
    expect(api).not.toHaveProperty('getInitialState');
    expect(execute).not.toHaveBeenCalled();
    expect(state.api.requests).toEqual({});
  });

  test('rejects duplicate operation keys before action types can collide', () => {
    // Arrange: query and mutation definitions attempt to use the same key.
    const define = () => createGraphqlApi({
      name: 'duplicate',
      endpoint: '/graphql',
      storeService: ApiStore,
      getState: (state: State) => state.api,
      state: (state) => state.api,

      endpoints: (builder) => ({
        first: builder.query('person', {
          document: 'query Person { person }',
          decode: () => 'saved',
          normalize: (value: string) => value,
        }),
        second: builder.mutation('person', {
          document: 'mutation Person { person }',
          decode: () => 'saved',
          normalize: (value: string) => value,
        }),
      }),
    });

    // Act / Assert: duplicate action families are rejected without slice registration.
    expect(define).toThrow('Duplicate operation: person');
  });

  test('publishes normalized entities through generated RTK actions', async () => {
    // Arrange: one operation and a real Redux store.
    const {
      api,
      redux,
      store,
      actions
    } = setup();
    const previous = redux.getState();

    // Act: execute via the store's Effect bridge.
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: only shared entities and request metadata are retained.
    expect(actions.map((action) => action.type)).toEqual([
      'peopleApi/person/started', 'peopleApi/person/succeeded',
    ]);
    expect(redux.getState().people).toEqual({ '1': { id: '1', name: 'Pat' } });
    expect(previous.people).toEqual({});
    expect(Object.values(redux.getState().api.requests)[0]).toMatchObject({ status: 'succeeded' });
    expect(Object.keys(redux.getState())).toEqual(['api', 'people']);
    expectTypeOf(api.endpoints.person.actions.started.type).toEqualTypeOf<'peopleApi/person/started'>();
    expectTypeOf<Parameters<typeof api.endpoints.person.initiate>[0]>().toEqualTypeOf<Variables>();
  });

  test('normalizes mutations into the same tables as queries', async () => {
    // Arrange: two operations share one datastore.
    const {
      api,
      redux,
      store,
      fetcher
    } = setup();

    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Act: mutate the previously fetched entity.
    fetcher.mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Updated' } } }));
    await Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    // Assert: there is still one entity, not one document per operation.
    expect(redux.getState().people).toEqual({ '1': { id: '1', name: 'Updated' } });
  });

  test('keeps duplicate mutations unshared', async () => {
    // Arrange: a mutation already owns this key.
    let resolve: (response: Response) => void = () => {
      throw new Error('Mutation has not started.');
    };
    const pending = vi.fn(() => new Promise<Response>((complete) => {
      resolve = complete;
    }));
    const { api, store } = setup(pending);
    const input = { store, variables: { id: '1' } };
    const first = Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, input));

    // Act: repeat the mutation before the first response.
    const result = await Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, input));
    resolve(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    await first;

    // Assert: query sharing does not replay or join mutations.
    expect(result).toEqual({ status: 'skipped' });
    expect(pending).toHaveBeenCalledTimes(1);
  });

  test('shares the original outcome for duplicate in-flight queries', async () => {
    // Arrange: a query is waiting for its HTTP response.
    let resolve: (response: Response) => void = () => {
      throw new Error('Request not started');
    };
    const pending = vi.fn(() => new Promise<Response>((complete) => {
      resolve = complete;
    }));
    const { api, store } = setup(pending);
    const first = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Act: dispatch an identical request before finishing the first.
    const duplicate = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    await Effect.runPromise(Effect.yieldNow);
    resolve(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    await first;

    // Assert: only one network request was issued.
    expect(await duplicate).toEqual({
      status: 'succeeded',
      result: { '1': { id: '1', name: 'Pat' } },
    });
    expect(pending).toHaveBeenCalledTimes(1);
  });

  test(
    'ignores a superseded response without changing Redux snapshot identity',
    async () => {
      // Arrange: two variable keys address the same latest-wins scope.
      let resolve: (response: Response) => void = () => {
        throw new Error('Request not started');
      };
      const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        .mockImplementationOnce(() => new Promise<Response>((complete) => { resolve = complete; }))
        .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
      const { api, store, redux } = setup(fetcher);
      const old = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
        variables: { id: 'old' },
        store,
      }));

      await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
        variables: { id: '1' },
        store
      }));

      const current = redux.getState();

      // Act: the previous request finishes late.
      resolve(Response.json({ data: { person: { id: 'old', name: 'Stale' } } }));

      const outcome = await old;

      // Assert: stale publication cannot merge entities or cause a false update.
      expect(outcome.status).toBe('superseded');
      expect(redux.getState()).toBe(current);
    }
  );

  test('preserves entities on GraphQL failure until explicit retry', async () => {
    // Arrange: a valid entity already exists.
    const {
      api,
      store,
      redux,
      fetcher
    } = setup();

    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Act: fail a reload with partial data, then explicitly retry.
    fetcher.mockResolvedValueOnce(Response.json({
      data: { person: { id: '1', name: 'Partial' } },
      errors: [{ message: 'Denied' }],
    }));
    const failed = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));
    const afterFailure = redux.getState();

    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: error state is visible and partial results never enter the table.
    expect(failed).toEqual({ status: 'failed', error: 'Denied' });
    expect(afterFailure.people['1']?.name).toBe('Pat');
    expect(Object.values(afterFailure.api.requests)[0]?.status).toBe('failed');
    expect(Object.values(redux.getState().api.requests)[0]?.status).toBe('succeeded');
  });

  test('does not share in-flight state across Redux stores', async () => {
    // Arrange: two Redux stores use the exact same API definition.
    let resolve: (response: Response) => void = () => {
      throw new Error('Request not started');
    };
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => new Promise<Response>((complete) => { resolve = complete; }))
      .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    const first = setup(fetcher);
    const second = configureStore({
      reducer: (state: State | undefined, action) => first.api.reducer({ state, action }),
    });
    const secondService = {
      getState: Effect.sync(second.getState),

      dispatch: (action: RequestActions<typeof first.api.endpoints>) => Effect.sync(() => second.dispatch(action)),
    };
    const pending = Effect.runPromise(runEndpoint(first.api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store: first.store,
    }));

    // Act: load the same variable key independently in the second store.
    const result = await Effect.runPromise(runEndpoint(first.api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store: secondService,
    }));

    resolve(Response.json({ data: { person: { id: '1', name: 'First' } } }));
    await pending;

    // Assert: definitions hold no shared response or request cache.
    expect(result.status).toBe('succeeded');
    expect(first.redux.getState().people['1']?.name).toBe('First');
    expect(second.getState().people['1']?.name).toBe('Pat');
  });

  test('releases pending Redux ownership after Effect interruption', async () => {
    // Arrange: keep HTTP pending until its AbortSignal is cancelled.
    let notifyStarted: () => void = () => {
      throw new Error('Waiter not initialized');
    };
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let aborted = false;
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async (url, init) => {
        expect(url).toBe('/graphql');
        init.signal?.addEventListener('abort', () => { aborted = true; });
        notifyStarted();
        return new Promise(() => {});
      })
      .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    const { api, redux, store, actions } = setup(fetcher);
    const cancel = Effect.runCallback(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    await started;

    // Act: interrupt, then explicitly retry the same variables.
    cancel();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const afterCancellation = redux.getState();
    const retried = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: no permanent request lock survives cancellation.
    expect(aborted).toBe(true);
    expect(Object.values(afterCancellation.api.requests)[0]?.status).toBe('cancelled');
    expect(actions.map((action) => action.type)).toContain('peopleApi/person/cancelled');
    expect(retried.status).toBe('succeeded');
  });

  test('preserves Redux identity for unknown actions', () => {
    // Arrange: a stable store snapshot.
    const { redux } = setup();
    const before = redux.getState();

    // Act: another slice's action passes through.
    redux.dispatch({ type: 'unrelated/updated' });

    // Assert: an API slice does not publish spurious entity changes.
    expect(redux.getState()).toBe(before);
  });
});
