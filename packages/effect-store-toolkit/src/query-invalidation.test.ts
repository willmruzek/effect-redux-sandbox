import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  createInvalidationRegistry,
  createRequestApi,
  type InvalidationAction,
  type InvalidationState,
  type RequestActions,
  type RequestApiState,
} from './index.js';

type Variables = { readonly id: string };
type Result = { readonly id: string; readonly value: string };

type State = {
  readonly value: string;
  readonly api: RequestApiState;
  readonly invalidation: InvalidationState<'Task'>;
};

function setup(invalidateBeforeSuccess = false, invalidateAfterStart = false) {
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
      detail: builder.query('detail', {
        decode: (): Result => ({ id: 'a', value: 'decoded' }),
        normalize: (value: Result) => value,
        provides: {
          registry,
          fromVariables: (variables: Variables) => [{ type: 'Task', id: `selection:${variables.id}` }],
          fromResult: (result: Result) => [{ type: 'Task', id: result.id }],
        },
      }),
    }),
  });
  const detail = api.operations.detail.reducer({
    onSuccess: (state, payload) => {
      state.value = payload.result.value;
    },
  });
  let state: State = {
    value: 'original',
    api: { requests: {}, latest: {} },
    invalidation: { revision: 0, queries: {}, history: [] },
  };
  const store = {
    getState: Effect.sync(() => state),
    dispatch: (action: RequestActions<typeof api.operations> | InvalidationAction<'Task'>) => Effect.sync(() => {
      if (invalidateBeforeSuccess && action.type === api.operations.detail.actions.succeeded.type) {
        state = registry.reducer(state, registry.actions.invalidate({
          tags: [{ type: 'Task', id: 'a' }],
        }));
      }

      state = api.reducer(detail(registry.reducer(state, action), action), action);

      if (invalidateAfterStart && 'kind' in action && action.kind === 'started') {
        state = registry.reducer(state, registry.actions.invalidate({
          tags: [{ type: 'Task', id: 'selection:a' }],
        }));
      }
    }),
  };

  return { api, registry, store, snapshot: () => state };
}

describe('generated query invalidation', () => {
  test('supersedes a read when a result-derived tag was invalidated before it settled', async () => {
    // Arrange: the result reveals a dependency not known when the read starts.
    const { api, registry, store, snapshot } = setup();

    // Act: invalidate the returned task before delivering the result.
    const result = await Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: async () => {
        await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'a' }] }));
        return { id: 'a', value: 'obsolete' };
      },
    }));

    // Assert: stale data is not merged and the query is marked stale.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.operations.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('stale');
  });

  test('supersedes metadata when invalidation occurs at the success publication boundary', async () => {
    // Arrange: middleware invalidates the result just before the success reducer runs.
    const { api, store, snapshot } = setup(true);

    // Act: complete the query.
    const result = await Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: async () => ({ id: 'a', value: 'obsolete' }),
    }));

    // Assert: neither domain state nor metadata records a successful read.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.operations.detail.selectRequest(snapshot(), { id: 'a' })?.status).toBe('superseded');
  });

  test('starts a new worker after invalidation rather than joining the older read', async () => {
    // Arrange: the first worker waits while an unknown result tag is invalidated.
    const { api, registry, store, snapshot } = setup();
    let release: (result: Result) => void = () => {
      throw new Error('Response resolver is not initialized.');
    };
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const old = Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: () => new Promise<Result>((resolve) => {
        release = resolve;
        notifyStarted();
      }),
    }));
    await started;
    await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'a' }] }));
    let newerExecutions = 0;

    // Act: issue the same query after invalidation, then finish the old worker.
    const newer = Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: async () => {
        newerExecutions += 1;
        return { id: 'a', value: 'new' };
      },
    }));
    await Effect.runPromise(Effect.yieldNow);
    release({ id: 'a', value: 'old' });
    const [oldResult, newResult] = await Promise.all([old, newer]);

    // Assert: the newer worker wins and the old worker cannot overwrite it.
    expect(newerExecutions).toBe(1);
    expect(oldResult).toEqual({ status: 'superseded' });
    expect(newResult).toEqual({ status: 'succeeded' });
    expect(snapshot().value).toBe('new');
    expect(api.operations.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('fresh');
  });

  test('supersedes a read invalidated immediately after dependency registration', async () => {
    // Arrange: a subscriber invalidates a variable-derived tag at read start.
    const { api, store, snapshot } = setup(false, true);

    // Act: complete the query after the invalidation.
    const result = await Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: async () => ({ id: 'a', value: 'obsolete' }),
    }));

    // Assert: registration succeeded, but the result cannot be merged.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.operations.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('stale');
  });

  test('accepts a read when only unrelated tags were invalidated', async () => {
    // Arrange: the query starts without an established result.
    const { api, registry, store, snapshot } = setup();
    expect(api.operations.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('uninitialized');

    // Act: invalidate another task before returning this result.
    const result = await Effect.runPromise(api.operations.detail.run({
      store,
      variables: { id: 'a' },
      execute: async () => {
        await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'b' }] }));
        return { id: 'a', value: 'current' };
      },
    }));

    // Assert: unrelated invalidation does not prevent a fresh merge.
    expect(result).toEqual({ status: 'succeeded' });
    expect(snapshot().value).toBe('current');
    expect(api.operations.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('fresh');
  });
});
