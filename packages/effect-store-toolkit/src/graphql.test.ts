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
  readonly people: Readonly<Record<string, Person>>;
  readonly selected: string | null;
};

class ApiStore extends Context.Service<ApiStore, Store<State, { readonly type: string }>>()('test/graphql/ApiStore') {}

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

function decode(data: unknown): Person {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('person' in data) ||
    typeof data.person !== 'object' ||
    data.person === null ||
    !('id' in data.person) ||
    typeof data.person.id !== 'string' ||
    !('name' in data.person) ||
    typeof data.person.name !== 'string'
  ) {
    throw new Error('Invalid person response.');
  }

  return { id: data.person.id, name: data.person.name };
}

function setup({
  failPublication = false,
  endpoint = '/graphql',
  headers,
  fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ data: { person: { id: '1', name: 'Pat' } } })),
}: {
  readonly failPublication?: boolean;
  readonly endpoint?: string;
  readonly headers?: HeadersInit;
  readonly fetcher?: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
} = {}) {
  const people = createEntityTable({
    name: 'people',

    key: (person: Person) => person.id
  });
  const definition = createGraphqlApi({
    name: 'peopleApi',
    endpoint,
    fetcher,
    storeService: ApiStore,
    ...(headers ? { headers } : {}),

    state: (state) => state.api,

    getState: (state: State) => state.api,

    endpoints: (api) => ({
      person: api.query('person', {
        document: 'query Person($id: ID!) { person(id: $id) { id name } }',
        operationName: 'Person',
        decode,

        normalize: (person, variables: Variables) => {
          if (person.id !== variables.id)
            throw new Error('Response does not match the requested person.');

          return people.normalize([person]);
        },

        scope: () => 'selection',
      }),
      rename: api.mutation('rename', {
        document: 'mutation Rename($id: ID!) { person: rename(id: $id) { id name } }',
        decode,

        normalize: (person, variables: Variables) => {
          if (person.id !== variables.id)
            throw new Error('Response does not match the requested person.');

          return people.normalize([person]);
        },
      }),
    }),
  });
  const person = definition.endpoints.person.reducer({
    onSuccess: (state, { result, variables }) => {
      if (failPublication)
        throw new Error('Entity merge failed');

      state.people = people.merge({ current: state.people, incoming: result });
      state.selected = variables.id;
    },
  });
  const rename = definition.endpoints.rename.reducer({
    onSuccess: (state, { result }) => {
      state.people = people.merge({ current: state.people, incoming: result });
    },
  });

  const api = {
    ...definition,
    getInitialState: (): State => ({ api: { requests: {}, latest: {} }, people: {}, selected: null }),
    reducer: ({ state, action }: Readonly<{ state: State; action: { readonly type: string } }>) =>
      definition.reducer(rename(person(state, action), action), action),
  };
  let state = api.getInitialState();
  const actions: RequestActions<typeof api.endpoints>[] = [];
  const store: ApiStore['Service'] = {
    getState: Effect.sync(() => state),

    dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
      actions.push(action);
      state = api.reducer({ state, action });
    }),
  };
  return {
    api,
    store,
    actions,
    fetcher,

    snapshot: () => state
  };
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error('Request not started');
  };
  const fetcher = vi.fn(() => new Promise<Response>((complete) => {
    resolve = complete;
  }));

  return {
    fetcher,

    resolve: (response: Response) => resolve(response)
  };
}

describe('GraphQL API', () => {
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
          decode,
          normalize: (person: Person, variables: Variables) => ({ ...person, id: variables.id }),
        }),
      }),
    });
    const state: State = {
      api: { requests: {}, latest: {} },
      people: {},
      selected: null,
    };

    // Act: dispatch cannot establish ownership without registered reducers.
    await expect(Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      store: {
        getState: Effect.succeed(state),
        dispatch: () => Effect.void,
      },
      variables: { id: '1' },
    }))).rejects.toThrow('Could not claim person request.');

    // Assert: definition and execution cannot silently install state behavior.
    expect(api.reducer).toBeTypeOf('function');
    expect(api).not.toHaveProperty('getInitialState');
    expect(execute).not.toHaveBeenCalled();
    expect(state.api.requests).toEqual({});
  });

  test(
    'dispatches normalized query lifecycle through the receiving store',
    async () => {
      // Arrange: a typed query returns one complete entity.
      const {
        api,
        store,
        actions,
        fetcher,
        snapshot
      } = setup();

      // Act: run the query as an Effect using that store's service.
      const outcome = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
        variables: { id: '1' },
        store
      }));

      // Assert: normalization and lifecycle state publish through actions.
      expect(outcome.status).toBe('succeeded');
      expect(snapshot().people).toEqual({ '1': { id: '1', name: 'Pat' } });
      expect(snapshot().selected).toBe('1');
      expect(actions.map((action) => action.type)).toEqual([
        'peopleApi/person/started', 'peopleApi/person/succeeded',
      ]);
      expect(Object.values(snapshot().api.requests)[0]).toMatchObject({ status: 'succeeded' });
      expect(fetcher).toHaveBeenCalledWith('/graphql', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'query Person($id: ID!) { person(id: $id) { id name } }',
          operationName: 'Person',
          variables: { id: '1' },
        }),
      }));
      expectTypeOf<Parameters<typeof api.endpoints.person.initiate>[0]>().toEqualTypeOf<Variables>();
      expectTypeOf(api.endpoints.person.actions.succeeded.type).toEqualTypeOf<'peopleApi/person/succeeded'>();
      expectTypeOf<Parameters<typeof api.endpoints.person.actions.succeeded>[0]['result']>()
        .toEqualTypeOf<Readonly<Record<string, Person>>>();
    }
  );

  test('normalizes mutation responses into the same entity table', async () => {
    // Arrange: mutations use the same definitions as query responses.
    const {
      api,
      store,
      snapshot
    } = setup();

    // Act: dispatch a mutation.
    await Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: no mutation-specific entity cache is created.
    expect(snapshot().people['1']).toEqual({ id: '1', name: 'Pat' });
    expect(api.endpoints.rename.kind).toBe('mutation');
  });

  test(
    'allows independent variable keys to complete concurrently by default',
    async () => {
      // Arrange: mutations have no shared latest-wins scope by default.
      const pending = deferredResponse();
      const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        .mockImplementationOnce(pending.fetcher)
        .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
      const { api, store, snapshot } = setup({ fetcher });
      const old = Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
        variables: { id: 'old' },
        store,
      }));

      // Act: complete the newer key before the older one.
      await Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
        variables: { id: '1' },
        store
      }));
      pending.resolve(Response.json({ data: { person: { id: 'old', name: 'Earlier' } } }));

      const outcome = await old;

      // Assert: both normalized entities survive independent requests.
      expect(outcome.status).toBe('succeeded');
      expect(snapshot().people).toEqual({
        '1': { id: '1', name: 'Pat' },
        old: { id: 'old', name: 'Earlier' },
      });
    }
  );

  test('keeps duplicate mutations unshared', async () => {
    // Arrange: a mutation already owns this key.
    const pending = deferredResponse();
    const { api, store } = setup({ fetcher: pending.fetcher });
    const input = { store, variables: { id: '1' } };
    const first = Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, input));

    // Act: repeat the mutation before the first response.
    const result = await Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, input));
    pending.resolve(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    await first;

    // Assert: query sharing does not replay or join mutations.
    expect(result).toEqual({ status: 'skipped' });
    expect(pending.fetcher).toHaveBeenCalledTimes(1);
  });

  test('shares the original outcome for duplicate in-flight queries', async () => {
    // Arrange: the first HTTP request has not resolved.
    const pending = deferredResponse();
    const { api, store } = setup({ fetcher: pending.fetcher });
    const first = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Act: dispatch another identical query.
    const second = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    await Effect.runPromise(Effect.yieldNow);
    pending.resolve(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    await first;

    // Assert: the duplicate does not issue another HTTP request.
    expect(await second).toEqual({
      status: 'succeeded',
      result: { '1': { id: '1', name: 'Pat' } },
    });
    expect(pending.fetcher).toHaveBeenCalledTimes(1);
  });

  test('ignores a late response from a superseded scope', async () => {
    // Arrange: two variable keys address the same selected-result scope.
    const pending = deferredResponse();
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(pending.fetcher)
      .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    const { api, store, snapshot } = setup({ fetcher });
    const first = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: 'old' },
      store
    }));

    // Act: the newer query succeeds before the older response arrives.
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    const before = snapshot();

    pending.resolve(Response.json({ data: { person: { id: 'old', name: 'Stale' } } }));

    const old = await first;

    // Assert: neither the normalized records nor selection regresses.
    expect(old.status).toBe('superseded');
    expect(snapshot()).toBe(before);
    expect(snapshot().people.old).toBeUndefined();
  });

  test.each([
    {
      response: () => Response.json({ errors: [{ message: 'Denied' }] }),

      error: 'Denied'
    },
    {
      response: () => Response.json({
        data: { person: { id: '1', name: 'Partial' } },
        errors: [{ message: 'Partial failure' }]
      }),

      error: 'Partial failure'
    },
    {
      response: () => new Response('Unavailable', { status: 503 }),

      error: 'GraphQL request failed (503).'
    },
    {
      response: () => Response.json({ data: { person: { id: '1' } } }),

      error: 'Invalid person response.'
    },
    {
      response: () => Response.json({ errors: ['malformed'] }),

      error: 'Invalid GraphQL errors response.'
    },
    {
      response: () => Response.json({}),

      error: 'Invalid GraphQL response: missing data.'
    },
  ])('publishes an explicit failure for $error', async ({ response, error }) => {
    // Arrange: HTTP or GraphQL supplies unusable data.
    const {
      api,
      store,
      snapshot,
      actions
    } = setup({ fetcher: vi.fn(async () => response()) });

    // Act: run the operation against the failing boundary.
    const outcome = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    // Assert: failed responses never populate normalized tables.
    expect(outcome).toMatchObject({ status: 'failed', error });
    expect(snapshot().people).toEqual({});
    expect(Object.values(snapshot().api.requests)[0]).toMatchObject({ status: 'failed', error });
    expect(actions.at(-1)?.type).toBe('peopleApi/person/failed');
  });

  test('allows explicit retry after failure', async () => {
    // Arrange: a failed request retains its variable-key state.
    const {
      api,
      store,
      fetcher,
      snapshot
    } = setup();

    fetcher.mockRejectedValueOnce(new Error('Offline'));
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    // Act: dispatch again after the caller chooses to retry.
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: retry succeeds without an automatic timer or refetch.
    expect(Object.keys(snapshot().api.requests)).toHaveLength(1);
    expect(Object.values(snapshot().api.requests)[0]?.status).toBe('succeeded');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('does not share request state between independent stores', async () => {
    // Arrange: two stores use the same API definition.
    const first = setup();
    const second = setup();

    // Act: only the first store dispatches a query.
    await Effect.runPromise(runEndpoint(first.api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store: first.store,
    }));

    // Assert: there is no module-level request cache.
    expect(second.snapshot().api.requests).toEqual({});
    expect(second.snapshot().people).toEqual({});
  });

  test('uses the same API definition concurrently in independent stores', async () => {
    // Arrange: one API definition is shared, but ownership belongs to each store.
    const pending = deferredResponse();
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(pending.fetcher)
      .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    const first = setup({ fetcher });
    const second = setup();
    const running = Effect.runPromise(runEndpoint(first.api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store: first.store,
    }));

    // Act: the second store requests the same variable key independently.
    await Effect.runPromise(runEndpoint(first.api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store: second.store,
    }));
    pending.resolve(Response.json({ data: { person: { id: '1', name: 'First store' } } }));
    await running;

    // Assert: request deduplication never crosses store/SSR boundaries.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.snapshot().people['1']?.name).toBe('First store');
    expect(second.snapshot().people['1']?.name).toBe('Pat');
  });

  test('ignores a late failure from a superseded scope', async () => {
    // Arrange: the old request will fail after the replacement finishes.
    const pending = deferredResponse();
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(pending.fetcher)
      .mockResolvedValueOnce(Response.json({ data: { person: { id: '1', name: 'Pat' } } }));
    const { api, store, snapshot } = setup({ fetcher });
    const first = Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: 'old' },
      store,
    }));

    // Act: replace the old request, then receive its GraphQL error.
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    const current = snapshot();

    pending.resolve(Response.json({ errors: [{ message: 'Old failure' }] }));

    const outcome = await first;

    // Assert: stale failures cannot replace newer success state.
    expect(outcome.status).toBe('superseded');
    expect(snapshot()).toBe(current);
  });

  test('publishes normalization failures without merging entities', async () => {
    // Arrange: the server returns a decoded entity for the wrong requested ID.
    const {
      api,
      store,
      snapshot
    } = setup();

    // Act: normalization rejects the response.
    const outcome = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: 'wrong' },
      store,
    }));

    // Assert: a failed mapping is visible in request state, not partial entities.
    expect(outcome).toEqual({ status: 'failed', error: 'Response does not match the requested person.' });
    expect(snapshot().people).toEqual({});
  });

  test('aborts HTTP and releases request ownership when interrupted', async () => {
    // Arrange: the transport waits indefinitely until its signal is aborted.
    let started: () => void = () => {
      throw new Error('Waiter not initialized');
    };
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const waiting = (url: string, init: RequestInit): Promise<Response> => {
      expect(url).toBe('/graphql');
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      started();

      return new Promise(() => { });
    };
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ data: { person: { id: '1', name: 'Pat' } } }))
      .mockImplementationOnce(waiting);
    const { api, store, snapshot, actions } = setup({ fetcher });
    const cancel = Effect.runCallback(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    await ready;

    // Act: interrupt the dispatched operation, then explicitly retry.
    cancel();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const cancelled = Object.values(snapshot().api.requests)[0];
    const retry = await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store
    }));

    // Assert: cancellation is logged and cannot leave a permanent in-flight lock.
    expect(aborted).toBe(true);
    expect(cancelled?.status).toBe('cancelled');
    expect(actions.map((action) => action.type)).toContain('peopleApi/person/cancelled');
    expect(retry.status).toBe('succeeded');
  });

  test('uses canonical variable keys instead of object insertion order', () => {
    // Arrange: two objects contain identical variables in different orders.
    const { api } = setup();
    const first = { id: '1', extra: { a: 1, b: 2 } };
    const second = { extra: { b: 2, a: 1 }, id: '1' };

    // Act: compute both request identities.
    const keys = [api.endpoints.person.key(first), api.endpoints.person.key(second)];

    // Assert: GraphQL object field order does not create duplicate state.
    expect(keys[0]).toBe(keys[1]);
  });

  test('rejects cyclic variables before starting a request', () => {
    // Arrange: variables cannot be serialized as GraphQL JSON.
    const { api } = setup();
    const variables: {
      id: string;
      self?: object
    } = { id: '1' };

    variables.self = variables;

    // Act / Assert: report invalid input instead of producing an ambiguous key.
    expect(() => api.endpoints.person.key(variables)).toThrow('GraphQL variables must be acyclic JSON values.');
  });

  test('uses the factory endpoint and headers with the GraphQL media type', async () => {
    // Arrange: define endpoint and tenant metadata when creating the API.
    const {
      api,
      store,
      fetcher
    } = setup({ endpoint: '/tenant/graphql', headers: { 'x-demo-tenant': 'demo' } });

    // Act: execute the centrally configured operation.
    await Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }));

    // Assert: transport customization does not break JSON GraphQL requests.
    const call = fetcher.mock.calls[0];

    if (!call)
      throw new Error('Transport not called');

    const headers = new Headers(call[1].headers);

    expect(call[0]).toBe('/tenant/graphql');
    expect(headers.get('x-demo-tenant')).toBe('demo');
    expect(headers.get('content-type')).toBe('application/json');
  });

  test('releases pending ownership when a success reducer throws', async () => {
    // Arrange: application publication fails after a valid normalized response.
    const {
      api,
      store,
      snapshot
    } = setup({ failPublication: true });

    // Act / Assert: preserve the defect, but do not leave the request locked.
    await expect(Effect.runPromise(runEndpoint(api.endpoints.person, ApiStore, {
      variables: { id: '1' },
      store,
    }))).rejects.toThrow('Entity merge failed');
    expect(snapshot().people).toEqual({});
    expect(Object.values(snapshot().api.requests)[0]?.status).toBe('failed');
  });
});
