import {
  createInvalidationRegistry as createReduxInvalidation,
  createRequestApi as createReduxApi,
  type InvalidationState,
  type RequestApiState,
} from '@repo/redux-toolkit';
import {
  createInvalidationRegistry as createEffectInvalidation,
  createRequestApi as createEffectApi,
} from '@repo/effect-store-toolkit';
import { Effect, Fiber } from 'effect';
import { describe, expect, test, vi } from 'vitest';

type State = {
  readonly first: RequestApiState;
  readonly second: RequestApiState;
  readonly invalidation: InvalidationState<'Item'>;
};

type Variables = { readonly id: string };

describe.each([
  ['Redux', createReduxInvalidation, createReduxApi],
  ['Effect', createEffectInvalidation, createEffectApi],
])('%s public invalidation', (_name, createInvalidation, createApi) => {
  function setupMutation() {
    const registry = createInvalidation<State, 'Item'>()({
      name: 'inventory',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createApi({
      name: 'writes',
      state: (state: State) => state.first,
      getState: (state) => state.first,
      operations: (builder) => ({
        save: builder.mutation('save', {
          decode: (data: unknown, variables: Variables) => `${variables.id}:${String(data)}`,
          normalize: (value: string) => value,
          scope: () => 'active',
          invalidation: {
            registry,
            tags: (variables: Variables) => [{ type: 'Item', id: variables.id }],
          },
        }),
      }),
    });
    let state: State = {
      first: { requests: {}, latest: {} },
      second: { requests: {}, latest: {} },
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    state = registry.reducer(state, registry.actions.seed({
      identity: 'item-a', tags: [{ type: 'Item', id: 'a' }],
    }));
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: { readonly type: string }) => Effect.sync(() => {
        state = api.reducer(registry.reducer(state, action), action);
      }),
    };

    return { api, registry, store, snapshot: () => state };
  }

  test('does not invalidate on failed or interrupted writes', async () => {
    // Arrange: an established result depends on the item being written.
    const { api, registry, store, snapshot } = setupMutation();
    const variables = { id: 'a' };

    // Act: reject one write and interrupt a second while transport is pending.
    const failed = await Effect.runPromise(api.operations.save.run({
      store, variables, execute: async () => { throw new Error('Rejected'); },
    }));
    let notifyStarted: () => void = () => { throw new Error('Start signal was not initialized.'); };
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const cancelled = Effect.runFork(api.operations.save.run({
      store,
      variables,
      execute: () => new Promise<string>(() => { notifyStarted(); }),
    }));
    await started;
    await Effect.runPromise(Fiber.interrupt(cancelled));

    // Assert: neither unsuccessful write marks the result stale.
    expect(failed).toEqual({ status: 'failed', error: 'Rejected' });
    expect(snapshot().invalidation.revision).toBe(0);
    expect(registry.select(snapshot(), 'item-a')).toBe('fresh');
  });

  test('does not invalidate for a superseded successful write', async () => {
    // Arrange: an older write waits while a different write takes its scope.
    const { api, registry, store, snapshot } = setupMutation();
    let finish: (value: string) => void = () => { throw new Error('Write did not start.'); };
    let notifyStarted: () => void = () => { throw new Error('Start signal was not initialized.'); };
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const old = Effect.runPromise(api.operations.save.run({
      store,
      variables: { id: 'a' },
      execute: () => new Promise<string>((resolve) => {
        finish = resolve;
        notifyStarted();
      }),
    }));
    await started;
    const newer = await Effect.runPromise(api.operations.save.run({
      store, variables: { id: 'b' }, execute: async () => 'saved',
    }));

    // Act: the superseded server write also succeeds.
    finish('saved');
    const older = await old;

    // Assert: only the owned write invalidates, and item a remains fresh.
    expect(newer).toEqual({ status: 'succeeded' });
    expect(older).toEqual({ status: 'superseded' });
    expect(snapshot().invalidation.revision).toBe(1);
    expect(registry.select(snapshot(), 'item-a')).toBe('fresh');
  });

  test('shares tags across APIs while keeping stores isolated and never refetching', async () => {
    // Arrange: two APIs share one registry definition across two independent stores.
    const registry = createInvalidation<State, 'Item'>()({
      name: 'inventory',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const first = createApi({
      name: 'first',
      state: (state: State) => state.first,
      getState: (state) => state.first,
      operations: (builder) => ({
        item: builder.query('item', {
          decode: (data: unknown, variables: Variables) => `${variables.id}:${String(data)}`,
          normalize: (value: string) => value,
          provides: {
            registry,
            fromVariables: (variables: Variables) => [{ type: 'Item', id: variables.id }],
            fromResult: () => [],
          },
        }),
      }),
    });
    const second = createApi({
      name: 'second',
      state: (state: State) => state.second,
      getState: (state) => state.second,
      operations: (builder) => ({
        item: builder.query('item', {
          decode: (data: unknown, variables: Variables) => `${variables.id}:${String(data)}`,
          normalize: (value: string) => value,
          provides: {
            registry,
            fromVariables: (variables: Variables) => [{ type: 'Item', id: variables.id }],
            fromResult: () => [],
          },
        }),
      }),
    });
    function makeStore() {
      let state: State = {
        first: { requests: {}, latest: {} },
        second: { requests: {}, latest: {} },
        invalidation: { revision: 0, queries: {}, history: [] },
      };

      return {
        getState: Effect.sync(() => state),
        dispatch: (action: { readonly type: string }) => Effect.sync(() => {
          state = second.reducer(first.reducer(registry.reducer(state, action), action), action);
        }),
        snapshot: () => state,
      };
    }
    const left = makeStore();
    const right = makeStore();
    const execute = vi.fn(async () => 'value');
    const variables = { id: 'a' };

    for (const store of [left, right]) {
      await Effect.runPromise(first.operations.item.run({ store, variables, execute }));
      await Effect.runPromise(second.operations.item.run({ store, variables, execute }));
    }

    // Act: invalidate the shared tag in only the left store.
    const outcome = await Effect.runPromise(registry.invalidate({
      store: left, tags: [{ type: 'Item', id: 'a' }],
    }));

    // Assert: both left queries become stale, neither right query does, and no fetch runs.
    expect(outcome).toEqual({ matched: 2 });
    expect(first.operations.item.selectFreshness(left.snapshot(), variables)).toBe('stale');
    expect(second.operations.item.selectFreshness(left.snapshot(), variables)).toBe('stale');
    expect(first.operations.item.selectFreshness(right.snapshot(), variables)).toBe('fresh');
    expect(second.operations.item.selectFreshness(right.snapshot(), variables)).toBe('fresh');
    expect(execute).toHaveBeenCalledTimes(4);

    // Act / Assert: an unmatched event still advances the revision without transport.
    const revision = right.snapshot().invalidation.revision;
    expect(await Effect.runPromise(registry.invalidate({
      store: right, tags: [{ type: 'Item', id: 'missing' }],
    }))).toEqual({ matched: 0 });
    expect(right.snapshot().invalidation.revision).toBe(revision + 1);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
