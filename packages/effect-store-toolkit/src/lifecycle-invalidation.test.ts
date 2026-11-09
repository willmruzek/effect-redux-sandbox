import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  createInvalidationRegistry,
  createRequestLifecycle,
  createSlice,
  PostCommitError,
  type InvalidationAction,
  type InvalidationState,
  type RequestActions,
} from './index.js';

type Input = {
  readonly id: string;
  readonly value: string;
};

type State = {
  readonly value: string;
  readonly pending: { readonly requestId: string } | null;
  readonly invalidation: InvalidationState<'Task'>;
};

function setup(failTags = false, registryFirst = true) {
  const registry = createInvalidationRegistry<State, 'Task'>()({
    name: 'tracker',
    getState: (state) => state.invalidation,
    setState: (state, invalidation) => ({ ...state, invalidation }),
  });
  const edit = createRequestLifecycle<State, string>()('edit', {
    pending: (state, input: Input) => input.id === 'a' ? state.pending ?? undefined : undefined,
    invalidation: {
      registry,
      tags: (input: Input, result: string) => {
        if (failTags)
          throw new Error('Tag calculation failed');

        return [{ type: 'Task', id: `${input.id}:${result}` }];
      },
    },
  });
  const handlers = edit.reducers({
    onStarted: (state, payload) => {
      state.pending = { requestId: payload.requestId };
    },
    onConfirmed: (state, _payload, result) => {
      state.value = result;
      state.pending = null;
    },
    onFailed: (state) => {
      state.pending = null;
    },
  });
  const owner = createSlice({
    name: 'owner',
    initialState: (): State => ({
      value: 'original',
      pending: null,
      invalidation: { revision: 0, queries: {}, history: [] },
    }),
    reducers: () => ({}),
    extraReducers: (builder) => {
      builder.addCase(edit.actions.started, handlers.started);
      builder.addCase(edit.actions.confirmed, handlers.confirmed);
      builder.addCase(edit.actions.failed, handlers.failed);
    },
  });
  let state = registry.reducer(owner.getInitialState(), registry.actions.seed({
    identity: 'task',
    tags: [{ type: 'Task', id: 'a:saved' }],
  }));
  const observations: { readonly value: string; readonly freshness: string }[] = [];
  const actions: string[] = [];
  const store = {
    getState: Effect.sync(() => state),
    dispatch: (action: RequestActions<{ edit: typeof edit }> | InvalidationAction<'Task'>) => Effect.sync(() => {
      state = registryFirst
        ? owner.reducer({ state: registry.reducer(state, action), action })
        : registry.reducer(owner.reducer({ state, action }), action);
      actions.push(action.type);
      observations.push({ value: state.value, freshness: registry.select(state, 'task') });
    }),
  };

  return { edit, registry, store, observations, actions, snapshot: () => state };
}

describe('lifecycle invalidation', () => {
  test('does not publish confirmation when the registry reducer is installed after the owner', async () => {
    // Arrange: both reducers are installed, but their order is unsafe.
    const { edit, store, observations, snapshot, registry } = setup(false, false);

    // Act: the server accepts the write.
    const outcome = await Effect.runPromise(Effect.result(edit.run({
      store,
      input: { id: 'a', value: 'draft' },
      execute: async () => 'saved',
    })));

    // Assert: misconfiguration cannot expose confirmed data without staleness.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure).toBeInstanceOf(PostCommitError);
    expect(observations).not.toContainEqual({ value: 'saved', freshness: 'fresh' });
    expect(snapshot().value).toBe('original');
    expect(registry.select(snapshot(), 'task')).toBe('fresh');
  });

  test('publishes the confirmed value and invalidation in one transition', async () => {
    // Arrange: the lifecycle and a previously loaded query share a registry.
    const { edit, store, observations } = setup();
    // Act: save the task through the standalone lifecycle.
    const result = await Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'draft' },
      execute: async () => 'saved',
    }));

    // Assert: no observer sees the saved value while the query remains fresh.
    expect(result).toEqual({ status: 'succeeded' });
    expect(observations).toContainEqual({ value: 'saved', freshness: 'stale' });
    expect(observations).not.toContainEqual({ value: 'saved', freshness: 'fresh' });
  });

  test('reports tag calculation failure after server success without confirming or rolling back', async () => {
    // Arrange: the server succeeds, but deriving tags throws.
    const { edit, store, actions, snapshot, registry } = setup(true);

    // Act: attempt to publish confirmation and invalidation.
    const result = await Effect.runPromise(Effect.result(edit.run({
      store,
      input: { id: 'a', value: 'draft' },
      execute: async () => 'saved',
    })));

    // Assert: no part of the confirmation transition commits.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(PostCommitError);
      expect(result.failure.message).toContain('Tag calculation failed');
    }
    expect(actions).not.toContain(edit.actions.failed.type);
    expect(snapshot().value).toBe('original');
    expect(snapshot().pending).not.toBeNull();
    expect(registry.select(snapshot(), 'task')).toBe('fresh');
  });

  test('does not invalidate when transport rejects the write', async () => {
    // Arrange: a previously loaded query depends on the task.
    const { edit, store, snapshot, registry } = setup();

    // Act: the server rejects the request.
    const result = await Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'draft' },
      execute: async () => {
        throw new Error('Rejected');
      },
    }));

    // Assert: the request fails without changing query freshness.
    expect(result).toEqual({ status: 'failed', error: 'Rejected' });
    expect(registry.select(snapshot(), 'task')).toBe('fresh');
    expect(snapshot().invalidation.revision).toBe(0);
  });

  test('does not execute a write when the registry reducer is missing', async () => {
    // Arrange: the lifecycle references a registry that the store does not install.
    const registry = createInvalidationRegistry<State, 'Task'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const edit = createRequestLifecycle<State, string>()('edit', {
      pending: (state, input: Input) => input.id === 'a' ? state.pending ?? undefined : undefined,
      invalidation: {
        registry,
        tags: (input: Input) => [{ type: 'Task', id: input.id }],
      },
    });
    const state: State = {
      value: 'original',
      pending: null,
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    let executed = false;

    // Act: attempt the write without registry ownership.
    await expect(Effect.runPromise(edit.run({
      store: {
        getState: Effect.succeed(state),
        dispatch: () => Effect.void,
      },
      input: { id: 'a', value: 'draft' },
      execute: async () => {
        executed = true;
        return 'saved';
      },
    }))).rejects.toThrow('Could not find tracker invalidation registry.');

    // Assert: the remote write is not attempted.
    expect(executed).toBe(false);
  });
});
