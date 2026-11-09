import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  createCursorPagination,
  createInvalidationRegistry,
  createRequestApi,
  type CursorPaginationState,
  type InvalidationAction,
  type InvalidationState,
  type InvalidationTag,
  type PaginationAction,
  type RequestApiState,
} from './index.js';

type Page = {
  readonly ids: readonly string[];
  readonly cursor: string | null;
};

type State = {
  readonly ids: readonly string[];
  readonly pagination: CursorPaginationState<string>;
  readonly invalidation: InvalidationState<'Task' | 'TaskList'>;
};

function setup(invalidateBeforeSuccess = false) {
  const registry = createInvalidationRegistry<State, 'Task' | 'TaskList'>()({
    name: 'tracker',
    getState: (state) => state.invalidation,
    setState: (state, invalidation) => ({ ...state, invalidation }),
  });
  const pagination = createCursorPagination<State, string, Page>()({
    name: 'tasks',
    getState: (state) => state.pagination,
    setState: (state, value) => {
      state.pagination = value;
    },
    pageInfo: (page) => ({ cursor: page.cursor, hasNextPage: page.cursor !== null }),
    merge: (state, page, request) => {
      state.ids = request.after === null ? [...page.ids] : [...state.ids, ...page.ids];
    },
    invalidation: {
      registry,
      fromIdentity: () => [{ type: 'TaskList' }],
      fromPage: (page: Page): readonly InvalidationTag<'Task' | 'TaskList'>[] =>
        page.ids.map((id) => ({ type: 'Task', id })),
    },
  });
  let state: State = {
    ids: ['old'],
    pagination: {
      identity: 'filter',
      cursor: 'one',
      exhausted: false,
      pending: null,
      error: null,
    },
    invalidation: { revision: 0, queries: {}, history: [] },
  };
  state = registry.reducer(state, registry.actions.seed({
    identity: pagination.key('filter'),
    tags: [{ type: 'TaskList' }, { type: 'Task', id: 'old' }],
  }));
  const store = {
    getState: Effect.sync(() => state),
    dispatch: (action: PaginationAction<string, Page> | InvalidationAction<'Task' | 'TaskList'>) => Effect.sync(() => {
      if (invalidateBeforeSuccess && action.type === 'tasks/pagination' && action.kind === 'succeeded') {
        state = registry.reducer(state, registry.actions.invalidate({
          tags: [{ type: 'Task', id: 'new' }],
        }));
      }

      state = pagination.reducer(registry.reducer(state, action), action);
    }),
  };

  return { pagination, registry, store, snapshot: () => state };
}

describe('cursor chain invalidation', () => {
  test('fences generated query success against invalidation since the pagination chain started', async () => {
    // Arrange: pagination and its generated query share a registry and store.
    type QueryState = State & { readonly api: RequestApiState; readonly queryMerges: number };
    const registry = createInvalidationRegistry<QueryState, 'Task' | 'TaskList'>()({
      name: 'tracker',
      getState: (state) => state.invalidation,
      setState: (state, invalidation) => ({ ...state, invalidation }),
    });
    const api = createRequestApi({
      name: 'tracker',
      state: (state: QueryState) => state.api,
      getState: (state) => state.api,
      operations: (builder) => ({
        page: builder.query('page', {
          decode: (data: unknown, variables: { readonly after: string | null }): Page => ({
            ids: data === null || variables.after === null ? [] : [variables.after], cursor: null,
          }),
          normalize: (page: Page) => page,
          provides: {
            registry,
            fromVariables: () => [{ type: 'TaskList' }],
            fromResult: (page: Page): readonly InvalidationTag<'Task' | 'TaskList'>[] =>
              page.ids.map((id) => ({ type: 'Task', id })),
          },
        }),
      }),
    });
    const pageReducer = api.operations.page.reducer({
      onSuccess: (state) => { state.queryMerges += 1; },
    });
    const pagination = createCursorPagination<QueryState, string, Page>()({
      name: 'tasks',
      getState: (state) => state.pagination,
      setState: (state, value) => { state.pagination = value; },
      pageInfo: (page) => ({ cursor: page.cursor, hasNextPage: page.cursor !== null }),
      merge: (state, page) => { state.ids = [...state.ids, ...page.ids]; },
      invalidation: {
        registry,
        fromIdentity: () => [{ type: 'TaskList' }],
        fromPage: (page) => page.ids.map((id) => ({ type: 'Task', id })),
      },
    });
    let state: QueryState = {
      ids: ['old'],
      pagination: { identity: 'filter', cursor: 'one', exhausted: false, pending: null, error: null },
      invalidation: { revision: 0, queries: {}, history: [] },
      api: { requests: {}, latest: {} },
      queryMerges: 0,
    };
    state = registry.reducer(state, registry.actions.seed({
      identity: pagination.key('filter'), tags: [{ type: 'TaskList' }],
    }));
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: { readonly type: string }) => Effect.sync(() => {
        state = pagination.reducer(api.reducer(pageReducer(registry.reducer(state, action), action), action), action);
      }),
    };

    // Act: invalidate after the chain starts but before the query registers.
    const outcome = await Effect.runPromise(pagination.next({
      store,
      identity: 'filter',
      query: (after, request) => Effect.gen(function*() {
        yield* registry.invalidate({ store, tags: [{ type: 'TaskList' }] });
        return yield* api.operations.page.runWithResult({
          store,
          variables: { after },
          fence: { identity: pagination.key(request.identity), requestId: request.requestId },
          execute: async () => ({ ids: ['new'], cursor: 'two' }),
        });
      }),
    }));

    // Assert: neither success handler nor the page commit publishes stale data.
    expect(outcome).toEqual({ status: 'superseded' });
    expect(state.queryMerges).toBe(0);
    expect(state.ids).toEqual(['old']);
    expect(state.pagination.cursor).toBe('one');
    expect(pagination.selectFreshness(state, 'filter')).toBe('stale');
  });

  test('blocks next-page transport when the established chain is stale', async () => {
    // Arrange: a hydrated chain is invalidated after its first page.
    const { pagination, registry, store, snapshot } = setup();
    await Effect.runPromise(registry.invalidate({ store, tags: [{ type: 'TaskList' }] }));
    let executed = false;

    // Act: attempt to append a page to the stale chain.
    const result = await Effect.runPromise(pagination.next({
      store,
      identity: 'filter',
      execute: async () => {
        executed = true;
        return { ids: ['new'], cursor: null };
      },
    }));

    // Assert: no transport or visible-window change occurs.
    expect(result).toEqual({ status: 'stale' });
    expect(executed).toBe(false);
    expect(snapshot().ids).toEqual(['old']);
    expect(snapshot().pagination.cursor).toBe('one');
  });

  test('retains the page and cursor when invalidation occurs before the pagination commit', async () => {
    // Arrange: middleware invalidates a page entity before the pagination reducer.
    const { pagination, store, snapshot } = setup(true);

    // Act: complete a generated-query-style page request.
    const result = await Effect.runPromise(pagination.next({
      store,
      identity: 'filter',
      query: () => Effect.succeed({ status: 'succeeded', result: { ids: ['new'], cursor: 'two' } }),
    }));

    // Assert: the invalidated page cannot advance the cursor or merge its entities.
    expect(result).toEqual({ status: 'superseded' });
    expect(snapshot().ids).toEqual(['old']);
    expect(snapshot().pagination.cursor).toBe('one');
    expect(pagination.selectFreshness(snapshot(), 'filter')).toBe('stale');
  });

  test('accumulates tags from appended pages', async () => {
    // Arrange: a fresh chain has an existing entity.
    const { pagination, registry, store, snapshot } = setup();
    await Effect.runPromise(pagination.next({
      store,
      identity: 'filter',
      execute: async () => ({ ids: ['new'], cursor: 'two' }),
    }));

    // Act: invalidate the newly appended entity.
    const result = await Effect.runPromise(registry.invalidate({
      store,
      tags: [{ type: 'Task', id: 'new' }],
    }));

    // Assert: the chain is registered as dependent on the appended entity.
    expect(result).toEqual({ matched: 1 });
    expect(snapshot().ids).toEqual(['old', 'new']);
    expect(pagination.selectFreshness(snapshot(), 'filter')).toBe('stale');
  });

  test('replaces prior page tags after a successful first-page refresh', async () => {
    // Arrange: the established chain contains an old entity.
    const { pagination, registry, store, snapshot } = setup();
    await Effect.runPromise(pagination.refresh({
      store,
      identity: 'filter',
      execute: async () => ({ ids: ['new'], cursor: 'two' }),
    }));

    // Act: invalidate an entity that is no longer in the refreshed chain.
    const result = await Effect.runPromise(registry.invalidate({
      store,
      tags: [{ type: 'Task', id: 'old' }],
    }));

    // Assert: the replacement remains fresh and contains only the new page.
    expect(result).toEqual({ matched: 0 });
    expect(snapshot().ids).toEqual(['new']);
    expect(pagination.selectFreshness(snapshot(), 'filter')).toBe('fresh');
  });
});
