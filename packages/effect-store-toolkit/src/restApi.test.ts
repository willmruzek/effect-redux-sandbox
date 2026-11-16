import { Context, Effect } from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';

import {
  createRestApi,
  type RequestActions,
  type RequestApiState,
  type Store,
  type TransportReceipt,
} from './index.js';

type State = {
  readonly api: RequestApiState;
  readonly value: string;
};

class ApiStore extends Context.Service<ApiStore, Store<State, never>>()('test/restApi/ApiStore') { }

describe('REST API factory', () => {
  test('exposes the explicit custom transport receipt contract', () => {
    // Arrange: derive the successful and failed transport receipt variants.
    type Received = Extract<TransportReceipt, { status: 'received' }>;
    type Failed = Extract<TransportReceipt, { status: 'failed' }>;

    // Act / Assert: consumers can type deferred reading and commit uncertainty.
    expectTypeOf<Received>().toHaveProperty('read');
    expectTypeOf<Failed>().toHaveProperty('serverMayHaveCommitted');
  });

  test('does not mark a request-construction failure as a possible server commit', async () => {
    // Arrange: constructing the request fails before fetch can be called.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const api = createRestApi({
      name: 'people',
      basePath: '/api',
      fetcher,
      storeService: ApiStore,
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        update: builder.mutation('update', {
          request: (): { readonly path: string; readonly method: string; readonly response: 'json' } => {
            throw new Error('Invalid request.');
          },
          decode: (): string => 'saved',
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = { api: { requests: {}, latest: {} }, value: 'initial' };
    const store: ApiStore['Service'] = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(state, action);
      }),
    };

    // Act: initiate the mutation through its configured store service.
    const outcome = await Effect.runPromise(
      Effect.provideService(
        api.endpoints.update.initiate({}),
        ApiStore,
        store,
      ),
    );

    // Assert: the failure is definite and the network was never reached.
    expect(outcome).toEqual({ status: 'failed', error: 'Invalid request.' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('runs a centrally defined query without per-call transport configuration', async () => {
    // Arrange: define a REST query and install its reducer in a fresh store.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => Response.json({ name: 'Pat' }),
    );
    const api = createRestApi({
      name: 'people',
      basePath: '/api',
      fetcher,
      storeService: ApiStore,
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        person: builder.query('person', {
          request: (variables: { readonly id: string }) => ({
            path: `/people/${variables.id}`,
            method: 'GET',
            response: 'json',
          }),
          decode: (data: unknown): string => {
            if (typeof data !== 'object' || data === null || !('name' in data) || typeof data.name !== 'string')
              throw new Error('Invalid person.');

            return data.name;
          },
          normalize: (value: string) => value,
        }),
      }),
    });
    const reducer = api.endpoints.person.reducer({
      onSuccess: (state, { result }) => { state.value = result; },
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store: ApiStore['Service'] = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(reducer(state, action), action);
      }),
    };

    // Act: initiate the endpoint through its configured store service.
    const outcome = await Effect.runPromise(
      Effect.provideService(
        api.endpoints.person.initiate({ id: '1' }),
        ApiStore,
        store,
      ),
    );

    // Assert: the centrally defined request published its decoded result.
    expect(outcome).toEqual({ status: 'succeeded', result: 'Pat' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/people/1');
    expect(state.value).toBe('Pat');
    expect(api.endpoints.person.select({ id: '1' })(state)).toMatchObject({ status: 'succeeded' });
    expectTypeOf<Parameters<typeof api.endpoints.person.initiate>[0]>().toEqualTypeOf<{
      readonly id: string;
    }>();
  });
});
