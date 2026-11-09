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

  test('reports matching queries and advances the revision on explicit invalidation', async () => {
    // Arrange: install the registry and seed a fresh task query.
    const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    let state: State = {
      invalidation: { revision: 0, queries: {}, history: [] },
    };
    state = registry.reducer(state, registry.actions.seed({
      identity: 'detail',
      tags: [{ type: 'Task', id: '42' }],
    }));
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: InvalidationAction<'Task' | 'TaskList'>) => Effect.sync(() => {
        state = registry.reducer(state, action);
      }),
    };

    // Act: invalidate the task entity.
    const result = await Effect.runPromise(registry.invalidate({
      store,
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the one matching query becomes stale.
    expect(result).toEqual({ matched: 1 });
    expect(registry.select(state, 'detail')).toBe('stale');
    expect(state.invalidation.revision).toBe(1);
  });

  test('marks a result stale when its discovered tag was invalidated while pending', () => {
    // Arrange: the request starts without knowing the returned task ID.
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

    // Act: the result reveals the invalidated task.
    const settled = registry.reducer(invalidated, registry.actions.succeeded({
      identity: 'detail',
      requestId: 'request',
      tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the query is stale, not fresh.
    expect(registry.select(settled, 'detail')).toBe('stale');
  });

  test('retains invalidation history across overlapping read generations', () => {
    // Arrange: a second read begins after an unknown result tag was invalidated.
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

    // Act: the earlier result discovers the invalidated task.
    const settled = registry.reducer(newer, registry.actions.succeeded({
      identity: 'detail', requestId: 'old', tags: [{ type: 'Task', id: '42' }],
    }));

    // Assert: the discovery is retained without disqualifying the new generation.
    expect(registry.select(settled, 'detail')).toBe('stale');
    expect(registry.isEligible(settled, {
      identity: 'detail', requestId: 'new', tags: [{ type: 'Task', id: '42' }],
    })).toBe(true);
  });

  test('keeps the newer successful generation fresh when an older read finishes', () => {
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

    // Assert: the eligible result stays fresh and retained history is released.
    expect(registry.select(settled, 'detail')).toBe('fresh');
    expect(settled.invalidation.history).toEqual([]);
  });
});
