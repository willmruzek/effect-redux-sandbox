import { describe, expect, test } from 'vitest';
import { Effect } from 'effect';

import {
  createInvalidationRegistry,
  type InvalidationAction,
  type InvalidationState,
} from './invalidation.js';

type State = {
  readonly invalidation: InvalidationState<'Task' | 'TaskList'>;
};

describe('invalidation registry', () => {
  test('fences a child read after its chain is forgotten and releases its tombstone on settlement', () => {
    // Arrange: a generated read inherits a pending pagination chain.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = { invalidation: { revision: 0, queries: {}, history: [] } };
    const chain = registry.reducer(initial, registry.actions.started({
      identity: 'chain', requestId: 'page', tags: [{ type: 'TaskList' }],
    }));
    const child = registry.reducer(chain, registry.actions.started({
      identity: 'query',
      requestId: 'query',
      tags: [],
      fence: { identity: 'chain', requestId: 'page' },
    }));

    // Act: forget and re-register the chain while its child is pending.
    const forgotten = registry.reducer(child, registry.actions.forget({ identity: 'chain' }));
    const reseeded = registry.reducer(forgotten, registry.actions.seed({
      identity: 'chain', tags: [{ type: 'TaskList' }],
    }));

    // Assert: the old child cannot publish through the replacement chain.
    expect(registry.isEligible(reseeded, { identity: 'query', requestId: 'query', tags: [] })).toBe(false);

    // Act: forget the chain again and finish the old child.
    const removed = registry.reducer(reseeded, registry.actions.forget({ identity: 'chain' }));
    const finished = registry.reducer(removed, registry.actions.finished({ identity: 'query', requestId: 'query' }));

    // Assert: no tombstone remains once no pending read references it.
    expect(finished.invalidation.epochs?.chain).toBeUndefined();
  });

  test('marks only queries with exactly matching tags stale', () => {
    // Arrange: two established results depend on different tags.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: {
        revision: 0,
        queries: {},
        history: [],
      },
    };
    const list = registry.reducer(initial, registry.actions.seed({
      identity: 'list',
      tags: [{ type: 'TaskList' }],
    }));
    const seeded = registry.reducer(list, registry.actions.seed({
      identity: 'detail',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: invalidate the task entity.
    const next = registry.reducer(seeded, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the detail is stale and the list remains fresh.
    expect(registry.select(next, 'detail')).toBe('stale');
    expect(registry.select(next, 'list')).toBe('fresh');
  });

  test('records an invalidation when no query matches', () => {
    // Arrange: no query has registered dependencies yet.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };

    // Act: invalidate an entity before a result provides its tag.
    const next = registry.reducer(initial, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the global revision advances even with no registered query.
    expect(next.invalidation.revision).toBe(1);
  });

  test('rejects a result whose newly discovered dependency was invalidated while pending', () => {
    // Arrange: the query starts before its returned entity is known.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'detail',
      requestId: 'request',
      tags: [],
    }));
    const invalidated = registry.reducer(started, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: the result reveals the invalidated dependency.
    const settled = registry.reducer(invalidated, registry.actions.succeeded({
      identity: 'detail',
      requestId: 'request',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the result cannot establish a fresh query.
    expect(registry.select(settled, 'detail')).toBe('stale');
    expect(registry.isEligible(invalidated, {
      identity: 'detail',
      requestId: 'request',
      tags: [{ type: 'Task', id: '42' }],
    })).toBe(false);
  });

  test('does not let a forgotten in-flight query establish freshness', () => {
    // Arrange: a query is pending when the consumer forgets its metadata.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'detail',
      requestId: 'old',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: forget the pending identity.
    const forgotten = registry.reducer(started, registry.actions.forget({ identity: 'detail' }));

    // Assert: the old request cannot publish a fresh result.
    expect(registry.select(forgotten, 'detail')).toBe('uninitialized');
    expect(registry.isEligible(forgotten, {
      identity: 'detail',
      requestId: 'old',
      tags: [{ type: 'Task', id: '42' }],
    })).toBe(false);
  });

  test('retains variable-derived dependencies after a successful result', () => {
    // Arrange: the query starts with a list dependency and returns one entity.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'list',
      requestId: 'request',
      tags: [{ type: 'TaskList' }],
    }));
    const settled = registry.reducer(started, registry.actions.succeeded({
      identity: 'list',
      requestId: 'request',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: invalidate the list dependency.
    const invalidated = registry.reducer(settled, registry.actions.invalidate({
      tags: [{ type: 'TaskList' }],
    }));

    // Assert: the successful result remains dependent on its variable tags.
    expect(registry.select(invalidated, 'list')).toBe('stale');
  });

  test('releases revision history after the last in-flight read ends', () => {
    // Arrange: an invalidation occurs while a query is pending.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'detail',
      requestId: 'request',
      tags: [],
    }));
    const invalidated = registry.reducer(started, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: finish the pending read.
    const settled = registry.reducer(invalidated, registry.actions.succeeded({
      identity: 'detail',
      requestId: 'request',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the stale result remains marked but old history is released.
    expect(registry.select(settled, 'detail')).toBe('stale');
    expect(settled.invalidation.history).toEqual([]);
  });

  test('retains the last good freshness when a later read fails', () => {
    // Arrange: an established result has a pending refresh.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const seeded = registry.reducer(initial, registry.actions.seed({
      identity: 'list',
      tags: [{ type: 'TaskList' }],
    }));
    const started = registry.reducer(seeded, registry.actions.started({
      identity: 'list',
      requestId: 'request',
      tags: [{ type: 'TaskList' }],
    }));
    const invalidated = registry.reducer(started, registry.actions.invalidate({
      tags: [{ type: 'TaskList' }],
    }));

    // Act: the pending refresh fails.
    const failed = registry.reducer(invalidated, registry.actions.finished({
      identity: 'list',
      requestId: 'request',
    }));

    // Assert: stale state is retained and history is released.
    expect(registry.select(failed, 'list')).toBe('stale');
    expect(failed.invalidation.history).toEqual([]);
  });

  test('reports zero matches while recording an explicit invalidation', async () => {
    // Arrange: the registry is installed in a store with no queries.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    let state: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: InvalidationAction<'Task' | 'TaskList'>) => Effect.sync(() => {
        state = registry.reducer(state, action);
      }),
    };

    // Act: invalidate an entity with no registered dependents.
    const result = await Effect.runPromise(registry.invalidate({
      store,
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the revision advances and reports no current matches.
    expect(result).toEqual({ matched: 0 });
    expect(state.invalidation.revision).toBe(1);
  });

  test('reports missing registry ownership rather than a zero-match success', async () => {
    // Arrange: the dispatch deliberately does not install the registry reducer.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const state: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };

    // Act and assert: an undispatched registry action is an explicit failure.
    await expect(Effect.runPromise(registry.invalidate({
      store: {
        getState: Effect.succeed(state),
        dispatch: () => Effect.void,
      },
      tags: [{ type: 'Task', id: '42' }],
    }))).rejects.toThrow('Could not publish tracker invalidation.');
  });

  test('retains invalidation history while an older read remains in flight', () => {
    // Arrange: a new sharing generation starts while the original read is pending.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'detail',
      requestId: 'old',
      tags: [],
    }));
    const invalidated = registry.reducer(started, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));
    const newer = registry.reducer(invalidated, registry.actions.started({
      identity: 'detail',
      requestId: 'new',
      tags: [],
    }));

    // Act: the old result reveals the invalidated task.
    const settled = registry.reducer(newer, registry.actions.succeeded({
      identity: 'detail',
      requestId: 'old',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the discovery marks the identity stale without disqualifying the new read.
    expect(registry.select(settled, 'detail')).toBe('stale');
    expect(registry.isEligible(settled, {
      identity: 'detail',
      requestId: 'new',
      tags: [{ type: 'Task', id: '42' }],
    })).toBe(true);
  });

  test('does not make a newer successful result stale when an older read finishes', () => {
    // Arrange: the new generation observes the invalidation and succeeds first.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const initial: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    const started = registry.reducer(initial, registry.actions.started({
      identity: 'detail', requestId: 'old', tags: [],
    }));
    const invalidated = registry.reducer(started, registry.actions.invalidate({
      tags: [{ type: 'Task', id: '42' }],
    }));
    const newer = registry.reducer(invalidated, registry.actions.started({
      identity: 'detail', requestId: 'new', tags: [],
    }));
    const refreshed = registry.reducer(newer, registry.actions.succeeded({
      identity: 'detail', requestId: 'new', tags: [{ type: 'Task', id: '42' }],
    }));

    // Act: the earlier result discovers the same task after the refresh.
    const settled = registry.reducer(refreshed, registry.actions.succeeded({
      identity: 'detail', requestId: 'old', tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the eligible newer result remains fresh and history is released.
    expect(registry.select(settled, 'detail')).toBe('fresh');
    expect(settled.invalidation.history).toEqual([]);
  });
});
