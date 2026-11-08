import { configureStore } from '@reduxjs/toolkit';
import { Effect } from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi
} from 'vitest';

import {
  createRequestApi,
  createEntityTable,
  type RequestApiState,
  type RequestActions
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

function setup() {
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
  const definition = createRequestApi({
    name: 'peopleApi',
    endpoint: '/graphql',

    state: (state) => state.api,

    getState: (state: State) => state.api,

    operations: (api) => ({
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
  const person = definition.operations.person.reducer(callbacks);
  const rename = definition.operations.rename.reducer(callbacks);
  const api = {
    ...definition,
    reducer: ({ state = { api: { requests: {}, latest: {} }, people: {} }, action }: Readonly<{
      state: State | undefined;
      action: { readonly type: string };
    }>) => definition.reducer(rename(person(state, action), action), action),
  };
  const actions: RequestActions<typeof api.operations>[] = [];
  const redux = configureStore({
    reducer: (state: State | undefined, action) => api.reducer({ state, action }),
  });
  const store = {
    getState: Effect.sync(redux.getState),

    dispatch: (action: RequestActions<typeof api.operations>) => Effect.sync(() => {
      actions.push(action);

      return redux.dispatch(action);
    }),
  };
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ data: { person: { id: '1', name: 'Pat' } } }));

  return {
    api,
    redux,
    store,
    actions,
    fetcher
  };
}

describe('Redux createRequestApi', () => {
  test('does not install reducers or execute unowned requests', async () => {
    // Arrange: definitions alone and a store with no registered handlers.
    const api = createRequestApi({
      name: 'unregistered',
      getState: (state: State) => state.api,
      state: (state) => state.api,

      operations: (builder) => ({
        person: builder.query('person', {
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
    const execute = vi.fn(async () => ({ id: '1', name: 'Pat' }));

    // Act: dispatch cannot establish ownership without registered reducers.
    await expect(Effect.runPromise(api.operations.person.run({
      store: {
        getState: Effect.succeed(state),
        dispatch: () => Effect.void,
      },
      variables: { id: '1' },
      execute,
    }))).rejects.toThrow('Could not claim person request.');

    // Assert: definitions cannot silently install reducers or perform untracked I/O.
    expect(api.reducer).toBeTypeOf('function');
    expect(api).not.toHaveProperty('getInitialState');
    expect(execute).not.toHaveBeenCalled();
    expect(state.api.requests).toEqual({});
  });

  test('rejects duplicate operation keys before action types can collide', () => {
    // Arrange: query and mutation definitions attempt to use the same key.
    const define = () => createRequestApi({
      name: 'duplicate',
      getState: (state: State) => state.api,
      state: (state) => state.api,

      operations: (builder) => ({
        first: builder.query('person', {
          decode: () => 'saved',
          normalize: (value: string) => value,
        }),
        second: builder.mutation('person', {
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
      actions,
      fetcher
    } = setup();
    const previous = redux.getState();

    // Act: execute via the store's Effect bridge.
    await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher
    }));

    // Assert: only shared entities and request metadata are retained.
    expect(actions.map((action) => action.type)).toEqual([
      'peopleApi/person/started', 'peopleApi/person/succeeded',
    ]);
    expect(redux.getState().people).toEqual({ '1': { id: '1', name: 'Pat' } });
    expect(previous.people).toEqual({});
    expect(Object.values(redux.getState().api.requests)[0]).toMatchObject({ status: 'succeeded' });
    expect(Object.keys(redux.getState())).toEqual(['api', 'people']);
    expectTypeOf(api.operations.person.actions.started.type).toEqualTypeOf<'peopleApi/person/started'>();
    expectTypeOf<Parameters<typeof api.operations.person.run>[0]['variables']>().toEqualTypeOf<Variables>();
  });

  test('normalizes mutations into the same tables as queries', async () => {
    // Arrange: two operations share one datastore.
    const {
      api,
      redux,
      store,
      fetcher
    } = setup();

    await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher
    }));

    // Act: mutate the previously fetched entity.
    await Effect.runPromise(api.operations.rename.run({
      variables: { id: '1' },
      store,

      fetcher: async () => Response.json({ data: { person: { id: '1', name: 'Updated' } } }),
    }));

    // Assert: there is still one entity, not one document per operation.
    expect(redux.getState().people).toEqual({ '1': { id: '1', name: 'Updated' } });
  });

  test('keeps duplicate mutations unshared', async () => {
    // Arrange: a mutation already owns this key.
    const { api, store, fetcher } = setup();
    let resolve: (response: Response) => void = () => {
      throw new Error('Mutation has not started.');
    };
    const pending = vi.fn(() => new Promise<Response>((complete) => {
      resolve = complete;
    }));
    const input = { store, variables: { id: '1' }, fetcher: pending };
    const first = Effect.runPromise(api.operations.rename.run(input));

    // Act: repeat the mutation before the first response.
    const result = await Effect.runPromise(api.operations.rename.run(input));
    resolve(await fetcher('/graphql', {}));
    await first;

    // Assert: query sharing does not replay or join mutations.
    expect(result).toEqual({ status: 'skipped' });
    expect(pending).toHaveBeenCalledTimes(1);
  });

  test('shares the original outcome for duplicate in-flight queries', async () => {
    // Arrange: a query is waiting for its HTTP response.
    const {
      api,
      store,
      fetcher
    } = setup();
    let resolve: (response: Response) => void = () => {
      throw new Error('Request not started');
    };
    const pending = vi.fn(() => new Promise<Response>((complete) => {
      resolve = complete;
    }));
    const first = Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher: pending
    }));

    // Act: dispatch an identical request before finishing the first.
    const duplicate = Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher: pending
    }));

    await Effect.runPromise(Effect.yieldNow);
    resolve(await fetcher('/graphql', {}));
    await first;

    // Assert: only one network request was issued.
    expect(await duplicate).toEqual({ status: 'succeeded' });
    expect(pending).toHaveBeenCalledTimes(1);
  });

  test(
    'ignores a superseded response without changing Redux snapshot identity',
    async () => {
      // Arrange: two variable keys address the same latest-wins scope.
      const {
        api,
        store,
        redux,
        fetcher
      } = setup();
      let resolve: (response: Response) => void = () => {
        throw new Error('Request not started');
      };
      const old = Effect.runPromise(api.operations.person.run({
        variables: { id: 'old' },
        store,

        fetcher: () => new Promise<Response>((complete) => {
          resolve = complete;
        }),
      }));

      await Effect.runPromise(api.operations.person.run({
        variables: { id: '1' },
        store,
        fetcher
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

    await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher
    }));

    // Act: fail a reload with partial data, then explicitly retry.
    const failed = await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,

      fetcher: async () => Response.json({
        data: { person: { id: '1', name: 'Partial' } },
        errors: [{ message: 'Denied' }]
      }),
    }));
    const afterFailure = redux.getState();

    await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher
    }));

    // Assert: error state is visible and partial results never enter the table.
    expect(failed).toEqual({ status: 'failed', error: 'Denied' });
    expect(afterFailure.people['1']?.name).toBe('Pat');
    expect(Object.values(afterFailure.api.requests)[0]?.status).toBe('failed');
    expect(Object.values(redux.getState().api.requests)[0]?.status).toBe('succeeded');
  });

  test('does not share in-flight state across Redux stores', async () => {
    // Arrange: two Redux stores use the exact same API definition.
    const first = setup();
    const second = configureStore({
      reducer: (state: State | undefined, action) => first.api.reducer({ state, action }),
    });
    const secondService = {
      getState: Effect.sync(second.getState),

      dispatch: (action: RequestActions<typeof first.api.operations>) => Effect.sync(() => second.dispatch(action)),
    };
    let resolve: (response: Response) => void = () => {
      throw new Error('Request not started');
    };
    const pending = Effect.runPromise(first.api.operations.person.run({
      variables: { id: '1' },
      store: first.store,

      fetcher: () => new Promise<Response>((complete) => {
        resolve = complete;
      }),
    }));

    // Act: load the same variable key independently in the second store.
    const result = await Effect.runPromise(first.api.operations.person.run({
      variables: { id: '1' },
      store: secondService,
      fetcher: first.fetcher,
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
    const {
      api,
      redux,
      store,
      actions,
      fetcher
    } = setup();
    let notifyStarted: () => void = () => {
      throw new Error('Waiter not initialized');
    };
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let aborted = false;
    const cancel = Effect.runCallback(api.operations.person.run({
      variables: { id: '1' },
      store,

      fetcher: async (url, init) => {
        expect(url).toBe('/graphql');
        init.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        notifyStarted();

        return new Promise(() => { });
      },
    }));

    await started;

    // Act: interrupt, then explicitly retry the same variables.
    cancel();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const afterCancellation = redux.getState();
    const retried = await Effect.runPromise(api.operations.person.run({
      variables: { id: '1' },
      store,
      fetcher
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
