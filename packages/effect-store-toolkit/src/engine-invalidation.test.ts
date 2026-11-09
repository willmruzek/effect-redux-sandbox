import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  createInvalidationRegistry,
  createRequestApi,
  PostCommitError,
  type InvalidationAction,
  type InvalidationState,
  type RequestActions,
  type RequestApiState,
} from './index.js';

type Variables = { readonly id: string };

type State = {
  readonly value: string;
  readonly api: RequestApiState;
  readonly invalidation: InvalidationState<'Task'>;
};

describe('generated mutation invalidation', () => {
  test('reports an ignored mutation success as a post-commit settlement error', async () => {
    // Arrange: the owner accepts starts but silently drops success actions.
    const api = createRequestApi({
      name: 'trackerApi',
      state: (state: State) => state.api,
      getState: (state) => state.api,
      operations: (builder) => ({
        edit: builder.mutation('edit', {
          decode: () => 'saved',
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const actions: string[] = [];
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.operations>) => Effect.sync(() => {
        actions.push(action.type);
        if (action.type !== api.operations.edit.actions.succeeded.type)
          state = api.reducer(state, action);
      }),
    };

    // Act: the server succeeds, but local publication is ignored.
    const outcome = await Effect.runPromise(Effect.result(api.operations.edit.run({
      store, variables: {}, execute: async () => 'saved',
    })));

    // Assert: the caller is not told the mutation settled successfully.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
    expect(actions).not.toContain(api.operations.edit.actions.failed.type);
    expect(state.value).toBe('original');
  });

  test('does not publish mutation success when the registry reducer runs after the owner', async () => {
    // Arrange: install the mutation and registry in an unsafe order.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createRequestApi({
      name: 'trackerApi',
      state: (state: State) => state.api,
      getState: (state) => state.api,
      operations: (builder) => ({
        edit: builder.mutation('edit', {
          decode: () => 'saved',
          normalize: (value: string) => value,
          invalidation: { registry, tags: (variables: Variables) => [{ type: 'Task', id: variables.id }] },
        }),
      }),
    });
    const edit = api.operations.edit.reducer({ onSuccess: (state, payload) => { state.value = payload.result; } });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    state = registry.reducer(state, registry.actions.seed({
      identity: 'task', tags: [{ type: 'Task', id: 'a' }],
    }));
    const observations: string[] = [];
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.operations> | InvalidationAction<'Task'>) => Effect.sync(() => {
        state = registry.reducer(api.reducer(edit(state, action), action), action);
        observations.push(`${state.value}:${registry.select(state, 'task')}`);
      }),
    };

    // Act: the server accepts the write.
    const outcome = await Effect.runPromise(Effect.result(api.operations.edit.run({
      store, variables: { id: 'a' }, execute: async () => 'saved',
    })));

    // Assert: the invalid ordering fails without publishing a partial confirmation.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
    expect(observations).not.toContain('saved:fresh');
    expect(state.value).toBe('original');
    expect(registry.select(state, 'task')).toBe('fresh');
  });

  test('reports a GraphQL decoding failure after server success as post-commit', async () => {
    // Arrange: the server returns data that the mutation decoder cannot interpret.
    const api = createRequestApi({
      name: 'trackerApi',
      endpoint: '/graphql',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      operations: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          decode: (): string => { throw new Error('Invalid saved task'); },
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const actions: string[] = [];
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.operations>) => Effect.sync(() => {
        actions.push(action.type);
        state = api.reducer(state, action);
      }),
    };

    // Act: receive a successful GraphQL response.
    const outcome = await Effect.runPromise(Effect.result(api.operations.edit.run({
      store,
      variables: {},
      fetcher: async () => new Response(JSON.stringify({ data: { edit: 'saved' } })),
    })));

    // Assert: the caller can distinguish settlement failure from a rejected write.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure') {
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
      expect(outcome.failure.message).toContain('Invalid saved task');
    }
    expect(actions).not.toContain(api.operations.edit.actions.failed.type);
    expect(state.value).toBe('original');
  });

  test('publishes the normalized result and invalidation in one transition', async () => {
    // Arrange: the mutation and an established query share a registry.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createRequestApi({
      name: 'trackerApi',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      operations: (builder) => ({
        edit: builder.mutation('edit', {
          decode: () => 'saved',
          normalize: (value: string) => value,
          invalidation: {
            registry,
            tags: (variables: Variables, result: string) => [
              { type: 'Task', id: `${variables.id}:${result}` },
            ],
          },
        }),
      }),
    });
    const edit = api.operations.edit.reducer({
      onSuccess: (state, payload) => {
        state.value = payload.result;
      },
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    state = registry.reducer(state, registry.actions.seed({
      identity: 'task',
      tags: [{ type: 'Task', id: 'a:saved' }],
    }));
    const observations: { readonly value: string; readonly freshness: string }[] = [];
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.operations> | InvalidationAction<'Task'>) => Effect.sync(() => {
        state = api.reducer(edit(registry.reducer(state, action), action), action);
        observations.push({ value: state.value, freshness: registry.select(state, 'task') });
      }),
    };

    // Act: execute the generated mutation.
    const result = await Effect.runPromise(api.operations.edit.run({
      store,
      variables: { id: 'a' },
      execute: async () => 'saved',
    }));

    // Assert: the saved value is never visible while the query is fresh.
    expect(result).toEqual({ status: 'succeeded' });
    expect(observations).toContainEqual({ value: 'saved', freshness: 'stale' });
    expect(observations).not.toContainEqual({ value: 'saved', freshness: 'fresh' });
  });
});
