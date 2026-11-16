import { Context, Effect } from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';

import {
  createGraphqlApi,
  type RequestActions,
  type RequestApiState,
  type Store,
} from './index.js';

type State = {
  readonly api: RequestApiState;
  readonly value: string;
};

type Variables = { readonly id: string };

class ApiStore extends Context.Service<ApiStore, Store<State, never>>()('test/graphqlApi/ApiStore') { }

describe('GraphQL API factory', () => {
  test('runs a centrally defined query without per-call transport configuration', async () => {
    // Arrange: define a GraphQL query and install its reducer in a fresh store.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => Response.json({ data: { name: 'Pat' } }),
    );
    const api = createGraphqlApi({
      name: 'people',
      endpoint: '/graphql',
      fetcher,
      storeService: ApiStore,
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        person: builder.query('person', {
          document: 'query Person($id: ID!) { name(id: $id) }',
          operationName: 'Person',
          scope: (variables: { readonly id: string }) => variables.id,
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
    expect(fetcher.mock.calls[0]?.[0]).toBe('/graphql');
    expect(state.value).toBe('Pat');
    expect(api.endpoints.person.select({ id: '1' })(state)).toMatchObject({ status: 'succeeded' });
    expectTypeOf<Parameters<typeof api.endpoints.person.initiate>[0]>().toEqualTypeOf<Variables>();
  });
});
