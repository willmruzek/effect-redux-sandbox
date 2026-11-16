import { Effect, Fiber } from 'effect';
import { describe, expect, test } from 'vitest';

import { createApiCore } from './engine.js';
import {
  createInvalidationRegistry,
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

function setup(
  execute: (variables: Variables, signal: AbortSignal) => Promise<Result>,
  invalidateBeforeSuccess = false,
  invalidateAfterStart = false,
) {
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
      detail: builder.query('detail', {
        document: 'query Detail { detail }',
        transport: async (variables: Variables, signal) => {
          const result = await execute(variables, signal);
          return { status: 'received', read: async () => result };
        },
        decode: (data: unknown): Result => {
          if (
            typeof data !== 'object' || data === null ||
            !('id' in data) || typeof data.id !== 'string' ||
            !('value' in data) || typeof data.value !== 'string'
          )
            throw new Error('Invalid result.');

          return { id: data.id, value: data.value };
        },
        normalize: (value: Result) => value,
        provides: {
          registry,
          fromVariables: (variables: Variables) => [{ type: 'Task', id: `selection:${variables.id}` }],
          fromResult: (result: Result) => [{ type: 'Task', id: result.id }],
        },
      }),
    }),
  });
  const detail = api.endpoints.detail.reducer({
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
    dispatch: (action: RequestActions<typeof api.endpoints> | InvalidationAction<'Task'>) => Effect.sync(() => {
      if (invalidateBeforeSuccess && action.type === api.endpoints.detail.actions.succeeded.type) {
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
    // Arrange: the read cannot know the returned task ID until its result arrives.
    let release: (result: Result) => void = () => {
      throw new Error('Response resolver is not initialized.');
    };
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const response = new Promise<Result>((resolve) => {
      release = resolve;
    });
    const { api, registry, store, snapshot } = setup(async () => {
      notifyStarted();
      return response;
    });
    const fiber = Effect.runFork(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));
    await started;
    await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'a' }] }));

    // Act: the earlier response reveals its invalidated dependency.
    release({ id: 'a', value: 'obsolete' });
    const result = await Effect.runPromise(Fiber.join(fiber));

    // Assert: stale data is not merged and the query is marked stale.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.endpoints.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('stale');
  });

  test('supersedes metadata when invalidation occurs at the success publication boundary', async () => {
    // Arrange: middleware invalidates the result just before the success reducer runs.
    const { api, store, snapshot } = setup(async () => ({ id: 'a', value: 'obsolete' }), true);

    // Act: complete the query.
    const result = await Effect.runPromise(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));

    // Assert: neither domain state nor metadata records a successful read.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.endpoints.detail.selectRequest(snapshot(), { id: 'a' })?.status).toBe('superseded');
  });

  test('starts a new worker after invalidation rather than joining the older read', async () => {
    // Arrange: the first worker waits while an unknown result tag is invalidated.
    let release: (result: Result) => void = () => {
      throw new Error('Response resolver is not initialized.');
    };
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let executions = 0;
    const { api, registry, store, snapshot } = setup(async () => {
      executions += 1;
      if (executions > 1)
        return { id: 'a', value: 'new' };

      return new Promise<Result>((resolve) => {
        release = resolve;
        notifyStarted();
      });
    });
    const old = Effect.runPromise(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));
    await started;
    await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'a' }] }));

    // Act: issue the same query after invalidation, then finish the old worker.
    const newer = Effect.runPromise(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));
    await Effect.runPromise(Effect.yieldNow);
    release({ id: 'a', value: 'old' });
    const [oldResult, newResult] = await Promise.all([old, newer]);

    // Assert: the newer worker wins and the old worker cannot overwrite it.
    expect(executions).toBe(2);
    expect(oldResult).toEqual({ status: 'superseded' });
    expect(newResult).toEqual({ status: 'succeeded' });
    expect(snapshot().value).toBe('new');
    expect(api.endpoints.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('fresh');
  });

  test('supersedes a read invalidated immediately after dependency registration', async () => {
    // Arrange: a subscriber invalidates a variable-derived tag at read start.
    const { api, store, snapshot } = setup(async () => ({ id: 'a', value: 'obsolete' }), false, true);

    // Act: complete the query after the invalidation.
    const result = await Effect.runPromise(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));

    // Assert: registration succeeded, but the result cannot be merged.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().value).toBe('original');
    expect(api.endpoints.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('stale');
  });

  test('accepts a read when only unrelated tags were invalidated', async () => {
    // Arrange: the query starts without an established result.
    let invalidate: () => Promise<void> = async () => { throw new Error('Registry is not initialized.'); };
    const { api, registry, store, snapshot } = setup(async () => {
      await invalidate();
      return { id: 'a', value: 'current' };
    });
    invalidate = async () => {
      await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'Task', id: 'b' }] }));
    };
    expect(api.endpoints.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('uninitialized');

    // Act: invalidate another task before returning this result.
    const result = await Effect.runPromise(api.endpoints.detail.run({
      store,
      variables: { id: 'a' },
    }));

    // Assert: unrelated invalidation does not prevent a fresh merge.
    expect(result).toEqual({ status: 'succeeded' });
    expect(snapshot().value).toBe('current');
    expect(api.endpoints.detail.selectFreshness(snapshot(), { id: 'a' })).toBe('fresh');
  });
});
