import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import { createApiCore } from './engine.js';
import {
  createInvalidationRegistry,
  createOptimisticOwnership,
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
  test('does not publish registry probes when an optimistic target is missing', async () => {
    // Arrange: install an invalidation registry for a mutation with a missing target.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          scope: (variables: Variables) => variables.id,
          transport: async () => { throw new Error('Transport must not start.'); },
          decode: (): string => 'saved',
          normalize: (value: string) => value,
          invalidation: { registry, tags: () => [{ type: 'Task' }] },
          optimistic: {
            ownership: createOptimisticOwnership(),
            targets: (_state, variables) => [{ table: 'tasks', id: variables.id, incarnation: variables.id, field: 'name' }],
            read: () => undefined,
            proposed: () => 'new',
            confirmed: (result) => result,
            write: () => {},
          },
        }),
      }),
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const before = state;
    const actions: string[] = [];
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
        actions.push(action.type);
        state = api.reducer(registry.reducer(state, action), action);
      }),
    };

    // Act: attempt the invalid write.
    const result = await Effect.runPromise(api.endpoints.edit.run({ store, variables: { id: 'missing' } }));

    // Assert: preflight failure causes no store transition or transport.
    expect(result).toEqual({ status: 'failed', error: 'Missing optimistic target for edit.' });
    expect(actions).toEqual([]);
    expect(state).toBe(before);
  });

  test('releases optimistic claims when the invalidation reducer is missing', async () => {
    // Arrange: omit the registry reducer while retaining request metadata.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const ownership = createOptimisticOwnership();
    const target = { table: 'tasks', id: 'a', incarnation: 'a', field: 'name' };
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => { throw new Error('Transport must not start.'); },
          decode: (): string => 'saved',
          normalize: (value: string) => value,
          invalidation: { registry, tags: () => [{ type: 'Task' }] },
          optimistic: {
            ownership,
            targets: () => [target],
            read: (state) => state.value,
            proposed: () => 'new',
            confirmed: (result) => result,
            write: (state, _target, value) => {
              if (typeof value !== 'string')
                throw new Error('Invalid value.');
              state.value = value;
            },
          },
        }),
      }),
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
        state = api.reducer(api.endpoints.edit.optimisticReducer(state, action), action);
      }),
    };

    // Act: attempt the write without registry ownership.
    const result = await Effect.runPromise(Effect.result(api.endpoints.edit.run({ store, variables: {} })));

    // Assert: the missing composition fails before transport and frees the claim.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toContain('Could not find tracker invalidation registry.');
    expect(state.value).toBe('original');
    expect(ownership.claim({ requestId: 'retry', targets: [target] })).toEqual({ status: 'claimed' });
  });

  test('records a post-commit error when invalidation acknowledgement fails after confirmation', async () => {
    // Arrange: confirmation is published but receipt acknowledgement fails.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => ({ status: 'received', read: async () => 'saved' }),
          decode: (): string => 'saved',
          normalize: (value: string) => value,
          invalidation: { registry, tags: () => [{ type: 'Task' }] },
        }),
      }),
    });
    let state: State = {
      value: 'original',
      api: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
        if ('kind' in action && action.kind === 'acknowledged' && action.receipt.startsWith('mutation:'))
          throw new Error('Acknowledgement failed.');
        state = api.reducer(registry.reducer(state, action), action);
      }),
    };

    // Act: complete the server operation.
    const result = await Effect.runPromise(Effect.result(api.endpoints.edit.run({ store, variables: {} })));

    // Assert: both the error channel and request metadata report settlement failure.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure).toBeInstanceOf(PostCommitError);
    expect(api.endpoints.edit.selectRequest(state, {})).toMatchObject({
      status: 'postCommitError',
      serverMayHaveCommitted: true,
    });
  });

  test('reports an ignored mutation success as a post-commit settlement error', async () => {
    // Arrange: the owner accepts starts but silently drops success actions.
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      state: (state) => state.api,
      getState: (state: State) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => ({ status: 'received', read: async () => 'saved' }),
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
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        actions.push(action.type);
        if (action.type !== api.endpoints.edit.actions.succeeded.type)
          state = api.reducer(state, action);
      }),
    };

    // Act: the server succeeds, but local publication is ignored.
    const outcome = await Effect.runPromise(Effect.result(api.endpoints.edit.run({
      store, variables: {},
    })));

    // Assert: the caller is not told the mutation settled successfully.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
    expect(actions).not.toContain(api.endpoints.edit.actions.failed.type);
    expect(state.value).toBe('original');
  });

  test('does not publish mutation success when the registry reducer runs after the owner', async () => {
    // Arrange: install the mutation and registry in an unsafe order.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      state: (state) => state.api,
      getState: (state: State) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => ({ status: 'received', read: async () => 'saved' }),
          decode: () => 'saved',
          normalize: (value: string) => value,
          invalidation: { registry, tags: (variables: Variables) => [{ type: 'Task', id: variables.id }] },
        }),
      }),
    });
    const edit = api.endpoints.edit.reducer({ onSuccess: (state, payload) => { state.value = payload.result; } });
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
      dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
        state = registry.reducer(api.reducer(edit(state, action), action), action);
        observations.push(`${state.value}:${registry.select(state, 'task')}`);
      }),
    };

    // Act: the server accepts the write.
    const outcome = await Effect.runPromise(Effect.result(api.endpoints.edit.run({
      store, variables: { id: 'a' },
    })));

    // Assert: the invalid ordering fails without publishing a partial confirmation.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
    expect(observations).not.toContain('saved:fresh');
    expect(state.value).toBe('original');
    expect(registry.select(state, 'task')).toBe('fresh');
  });

  test('marks a GraphQL decoding failure after receipt as an uncertain failure', async () => {
    // Arrange: the server returns data that the mutation decoder cannot interpret.
    const api = createApiCore({
      name: 'trackerApi',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => ({
            status: 'received',
            read: async () => ({ edit: 'saved' }),
          }),
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
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        actions.push(action.type);
        state = api.reducer(state, action);
      }),
    };

    // Act: receive a successful GraphQL response.
    const outcome = await Effect.runPromise(api.endpoints.edit.run({
      store,
      variables: {},
    }));

    // Assert: the caller can distinguish settlement failure from a rejected write.
    expect(outcome).toEqual({
      status: 'failed',
      error: 'Invalid saved task',
      serverMayHaveCommitted: true,
    });
    expect(actions).toContain(api.endpoints.edit.actions.failed.type);
    expect(state.value).toBe('original');
  });

  test('publishes the normalized result and invalidation in one transition', async () => {
    // Arrange: the mutation and an established query share a registry.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createApiCore({
      name: 'trackerApi',
      endpoint: '/graphql',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        edit: builder.mutation('edit', {
          document: 'mutation Edit { edit }',
          transport: async () => ({ status: 'received', read: async () => 'saved' }),
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
    const edit = api.endpoints.edit.reducer({
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
      dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
        state = api.reducer(edit(registry.reducer(state, action), action), action);
        observations.push({ value: state.value, freshness: registry.select(state, 'task') });
      }),
    };

    // Act: execute the generated mutation.
    const result = await Effect.runPromise(api.endpoints.edit.run({
      store,
      variables: { id: 'a' },
    }));

    // Assert: the saved value is never visible while the query is fresh.
    expect(result).toEqual({ status: 'succeeded' });
    expect(observations).toContainEqual({ value: 'saved', freshness: 'stale' });
    expect(observations).not.toContainEqual({ value: 'saved', freshness: 'fresh' });
  });
});
