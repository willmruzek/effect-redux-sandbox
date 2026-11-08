import {
  createCursorPagination as createReduxPagination,
  createRequestApi as createReduxApi,
  type RequestApiState,
} from '@repo/redux-toolkit';
import {
  createCursorPagination as createEffectPagination,
  createRequestApi as createEffectApi,
} from '@repo/effect-store-toolkit';
import { Effect, Fiber } from 'effect';
import { describe, expect, test, vi } from 'vitest';

type Page = {
  readonly ids: readonly string[];
  readonly next: string | null;
};

type Pagination = {
  readonly identity: string;
  readonly cursor: string | null;
  readonly exhausted: boolean;
  readonly pending: null | {
    readonly requestId: string;
    readonly identity: string;
    readonly after: string | null;
    readonly mode: 'next' | 'refresh';
  };
  readonly error: null | {
    readonly identity: string;
    readonly after: string | null;
    readonly mode: 'next' | 'refresh';
    readonly message: string;
  };
};

type State = {
  readonly pagination: Pagination;
  readonly ids: readonly string[];
};

const initial = (): State => ({
  pagination: {
    identity: 'a',
    cursor: 'one',
    exhausted: false,
    pending: null,
    error: null,
  },
  ids: ['old'],
});

describe.each([
  ['Redux', createReduxPagination, createReduxApi],
  ['Effect', createEffectPagination, createEffectApi],
])('%s cursor pagination', (_name, createPagination, createApi) => {
  function setup() {
    const pagination = createPagination<State, string, Page>()({
      name: 'items',
      getState: (state) => state.pagination,
      setState: (state, value) => {
        state.pagination = value;
      },
      pageInfo: (page) => ({ cursor: page.next, hasNextPage: page.next !== null }),
      merge: (state, page, request) => {
        state.ids = request.after === null ? [...page.ids] : [...state.ids, ...page.ids];
      },
    });
    let state = initial();
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: Parameters<typeof pagination.reducer>[1]) => Effect.sync(() => {
        state = pagination.reducer(state, action);
      }),
    };

    return { pagination, store, snapshot: () => state };
  }

  test('advances the cursor only after a successful page', async () => {
    // Arrange: the next page has a new cursor.
    const app = setup();
    const execute = vi.fn(async () => ({ ids: ['new'], next: 'two' }));

    // Act: load the next page.
    const outcome = await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute,
    }));

    // Assert: metadata and domain rows advance together.
    expect(outcome).toEqual({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledWith('one', expect.any(AbortSignal));
    expect(app.snapshot().pagination.cursor).toBe('two');
    expect(app.snapshot().ids).toEqual(['old', 'new']);
  });

  test('advances from an Effect-valued result-bearing query', async () => {
    // Arrange: a query returns a normalized page through Effect.
    const app = setup();
    const query = vi.fn(() => Effect.succeed<{ readonly status: 'succeeded'; readonly result: Page }>({
      status: 'succeeded',
      result: { ids: ['new'], next: 'two' },
    }));

    // Act: load through the query execution path.
    const outcome = await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      query,
    }));

    // Assert: the result advances the same store-owned cursor.
    expect(outcome).toEqual({ status: 'succeeded' });
    expect(query).toHaveBeenCalledWith('one', expect.objectContaining({
      after: 'one',
      identity: 'a',
      mode: 'next',
    }));
    expect(app.snapshot().pagination.cursor).toBe('two');
  });

  test('shares generated query execution with an external query caller', async () => {
    // Arrange: install both reducers on one store with one stable service.
    type QueryState = State & { readonly api: RequestApiState };
    const api = createApi({
      name: 'items',
      getState: (state: QueryState) => state.api,
      state: (state) => state.api,
      operations: (builder) => ({
        page: builder.query('page', {
          decode: (_data: unknown, variables: { readonly after: string | null }): Page => ({
            ids: [variables.after ?? 'first'],
            next: null,
          }),
          normalize: (page: Page) => page,
        }),
      }),
    });
    const pagination = createPagination<QueryState, string, Page>()({
      name: 'items',
      getState: (state) => state.pagination,
      setState: (state, value) => {
        state.pagination = value;
      },
      pageInfo: (page) => ({ cursor: page.next, hasNextPage: page.next !== null }),
      merge: (state, page) => {
        state.ids = [...state.ids, ...page.ids];
      },
    });
    let state: QueryState = { ...initial(), api: { requests: {}, latest: {} } };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: { readonly type: string }) => Effect.sync(() => {
        state = api.reducer(pagination.reducer(state, action), action);
      }),
    };
    let finish: (page: Page) => void = () => {
      throw new Error('Request not started.');
    };
    const execute = vi.fn(() => new Promise<Page>((resolve) => {
      finish = resolve;
    }));
    const queryInput = { store, variables: { after: 'one' }, execute };
    const external = Effect.runPromise(api.operations.page.run(queryInput));

    // Act: pagination joins the same generated request.
    const paginated = Effect.runPromise(pagination.next({
      store,
      identity: 'a',
      query: (after) => api.operations.page.runWithResult({
        store,
        variables: { after },
        execute,
      }),
    }));
    finish({ ids: ['new'], next: null });
    const [externalOutcome, paginationOutcome] = await Promise.all([external, paginated]);

    // Assert: both callers share one transport and pagination receives its page.
    expect(externalOutcome).toEqual({ status: 'succeeded' });
    expect(paginationOutcome).toEqual({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.ids).toEqual(['old', 'new']);

    // Act: start pagination first and let a plain query caller join it.
    const first = Effect.runPromise(pagination.refresh({
      store,
      identity: 'a',
      query: (after) => api.operations.page.runWithResult({ store, variables: { after }, execute }),
    }));
    const second = Effect.runPromise(api.operations.page.run({
      store,
      variables: { after: null },
      execute,
    }));
    finish({ ids: ['fresh'], next: null });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    // Assert: both call orders share execution and preserve each outcome shape.
    expect(firstOutcome).toEqual({ status: 'succeeded' });
    expect(secondOutcome).toEqual({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('does not expose failed or superseded generated results as successful pages', async () => {
    // Arrange: different variables compete for one generated query scope.
    type QueryState = { readonly api: RequestApiState };
    const api = createApi({
      name: 'results',
      state: (state: QueryState) => state.api,
      getState: (state) => state.api,
      operations: (builder) => ({
        page: builder.query('page', {
          decode: (_data: unknown, variables: { readonly id: string }): Page => ({
            ids: [variables.id],
            next: null,
          }),
          normalize: (page: Page) => page,
          scope: () => 'active',
        }),
      }),
    });
    let state: QueryState = { api: { requests: {}, latest: {} } };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: { readonly type: string }) => Effect.sync(() => {
        state = api.reducer(state, action);
      }),
    };
    let finish: (page: Page) => void = () => {
      throw new Error('Request not started.');
    };
    const old = Effect.runPromise(api.operations.page.runWithResult({
      store,
      variables: { id: 'old' },
      execute: () => new Promise<Page>((resolve) => { finish = resolve; }),
    }));

    // Act: a newer request fails before the old response arrives.
    const failed = await Effect.runPromise(api.operations.page.runWithResult({
      store,
      variables: { id: 'new' },
      execute: async () => { throw new Error('Offline'); },
    }));
    finish({ ids: ['stale'], next: null });
    const stale = await old;

    // Assert: neither outcome exposes a result.
    expect(failed).toEqual({ status: 'failed', error: 'Offline' });
    expect(stale).toEqual({ status: 'superseded' });
  });

  test('preserves the previous window when a cursor does not advance', async () => {
    // Arrange: the server repeats its previous cursor.
    const app = setup();

    // Act: request the invalid page.
    const outcome = await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute: async () => ({ ids: ['bad'], next: 'one' }),
    }));

    // Assert: the failed page does not commit.
    expect(outcome.status).toBe('failed');
    expect(app.snapshot().pagination.cursor).toBe('one');
    expect(app.snapshot().ids).toEqual(['old']);
  });

  test('refresh supersedes a pending page without allowing its stale merge', async () => {
    // Arrange: keep the current page in flight.
    const app = setup();
    let finish: (page: Page) => void = () => {
      throw new Error('Request not started.');
    };
    const pending = Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute: () => new Promise<Page>((resolve) => {
        finish = resolve;
      }),
    }));

    // Act: replace the page chain before the older response arrives.
    const refresh = await Effect.runPromise(app.pagination.refresh({
      store: app.store,
      identity: 'a',
      execute: async () => ({ ids: ['fresh'], next: 'fresh-cursor' }),
    }));
    finish({ ids: ['stale'], next: null });
    const old = await pending;

    // Assert: only the refreshed window is committed.
    expect(refresh.status).toBe('succeeded');
    expect(old.status).toBe('superseded');
    expect(app.snapshot().ids).toEqual(['fresh']);
    expect(app.snapshot().pagination.cursor).toBe('fresh-cursor');
  });

  test('skips duplicate next-page requests while one is pending', async () => {
    // Arrange: keep one page in flight.
    const app = setup();
    let finish: (page: Page) => void = () => {
      throw new Error('Request not started.');
    };
    const execute = vi.fn(() => new Promise<Page>((resolve) => {
      finish = resolve;
    }));
    const pending = Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));

    // Act: request the same page again.
    const duplicate = await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));

    // Assert: only the first call reaches transport.
    expect(duplicate.status).toBe('skipped');
    expect(execute).toHaveBeenCalledTimes(1);
    finish({ ids: ['new'], next: null });
    await pending;
  });

  test('retries a failed page with its original cursor', async () => {
    // Arrange: the first attempt fails without replacing the existing window.
    const app = setup();
    const fail = async (): Promise<Page> => {
      throw new Error('Offline');
    };
    await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute: fail }));
    const execute = vi.fn(async () => ({ ids: ['new'], next: null }));

    // Act: retry.
    await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));

    // Assert: the original cursor is reused.
    expect(execute).toHaveBeenCalledWith('one', expect.any(AbortSignal));
    expect(app.snapshot().ids).toEqual(['old', 'new']);
  });

  test('does not fetch another page after exhaustion', async () => {
    // Arrange: complete the last page.
    const app = setup();
    await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute: async () => ({ ids: [], next: null }),
    }));
    const execute = vi.fn(async () => ({ ids: [], next: null }));

    // Act: attempt to load another page.
    const outcome = await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));

    // Assert: exhaustion prevents transport.
    expect(outcome.status).toBe('skipped');
    expect(execute).not.toHaveBeenCalled();
  });

  test('retains the previous cursor when the caller is interrupted', async () => {
    // Arrange: start a transport that waits indefinitely.
    const app = setup();
    const fiber = Effect.runFork(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute: () => new Promise<Page>(() => {}),
    }));

    // Act: interrupt the caller.
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Assert: the chain is retryable and the interruption is visible.
    expect(app.snapshot().pagination.cursor).toBe('one');
    expect(app.snapshot().pagination.pending).toBeNull();
    expect(app.snapshot().pagination.error?.message).toBe('Request interrupted.');
  });

  test('rejects before transport when its reducer is not installed', async () => {
    // Arrange: dispatch does not install or run the pagination reducer.
    const app = setup();
    const execute = vi.fn(async () => ({ ids: [], next: null }));
    const store = {
      getState: app.store.getState,
      dispatch: () => Effect.void,
    };

    // Act / Assert: missing ownership is an error, not a successful no-op.
    await expect(Effect.runPromise(app.pagination.next({
      store,
      identity: 'a',
      execute,
    }))).rejects.toThrow('Could not claim items pagination request.');
    expect(execute).not.toHaveBeenCalled();
  });

  test('starts a new identity from the initial cursor', async () => {
    // Arrange: the existing chain has already advanced.
    const app = setup();
    const execute = vi.fn(async () => ({ ids: ['other'], next: null }));

    // Act: load a different query identity.
    await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'b', execute }));

    // Assert: the replacement starts at the beginning.
    expect(execute).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(app.snapshot().ids).toEqual(['other']);
    expect(app.snapshot().pagination.identity).toBe('b');
  });

  test('restarts when returning to the visible identity during a pending replacement', async () => {
    // Arrange: identity b is replacing the visible identity a.
    const app = setup();
    let finish: (page: Page) => void = () => {
      throw new Error('Request not started.');
    };
    const replacement = Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'b',
      execute: () => new Promise<Page>((resolve) => { finish = resolve; }),
    }));
    const execute = vi.fn(async () => ({ ids: ['fresh-a'], next: null }));

    // Act: return to identity a before b finishes.
    await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));
    finish({ ids: ['stale-b'], next: null });
    const stale = await replacement;

    // Assert: the replacement starts at the first page and b cannot merge.
    expect(execute).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(stale.status).toBe('superseded');
    expect(app.snapshot().ids).toEqual(['fresh-a']);
  });

  test('can explicitly restart an exhausted chain', async () => {
    // Arrange: the previous page exhausted identity a.
    const app = setup();
    await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      execute: async () => ({ ids: [], next: null }),
    }));
    const execute = vi.fn(async () => ({ ids: ['fresh'], next: null }));

    // Act: explicitly restart the same identity.
    const outcome = await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'a',
      restart: true,
      execute,
    }));

    // Assert: exhaustion does not prevent an explicit first-page request.
    expect(outcome.status).toBe('succeeded');
    expect(execute).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(app.snapshot().ids).toEqual(['fresh']);
  });

  test('retains the old window when a replacement fails', async () => {
    // Arrange: the replacement query cannot be fetched.
    const app = setup();

    // Act: start a different identity.
    const result = await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'b',
      execute: async () => {
        throw new Error('Offline');
      },
    }));

    // Assert: the old data and cursor remain available.
    expect(result).toEqual({ status: 'failed', error: 'Offline' });
    expect(app.snapshot().ids).toEqual(['old']);
    expect(app.snapshot().pagination.identity).toBe('a');
    expect(app.snapshot().pagination.cursor).toBe('one');
    expect(app.snapshot().pagination.error?.identity).toBe('b');
  });

  test('restarts the visible identity after a different replacement fails', async () => {
    // Arrange: the visible chain is a, but the latest requested identity b failed.
    const app = setup();
    await Effect.runPromise(app.pagination.next({
      store: app.store,
      identity: 'b',
      execute: async () => { throw new Error('Offline'); },
    }));
    const execute = vi.fn(async () => ({ ids: ['fresh-a'], next: null }));

    // Act: return to the visible identity.
    await Effect.runPromise(app.pagination.next({ store: app.store, identity: 'a', execute }));

    // Assert: the switch starts a new window instead of appending to the old one.
    expect(execute).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(app.snapshot().ids).toEqual(['fresh-a']);
  });

  test('preserves the previous window when a merge throws', async () => {
    // Arrange: the consumer's merge rejects a page.
    const pagination = createPagination<State, string, Page>()({
      name: 'merge-failure',
      getState: (state) => state.pagination,
      setState: (state, value) => {
        state.pagination = value;
      },
      pageInfo: (page) => ({ cursor: page.next, hasNextPage: page.next !== null }),
      merge: () => {
        throw new Error('Merge failed');
      },
    });
    let state = initial();
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: Parameters<typeof pagination.reducer>[1]) => Effect.sync(() => {
        state = pagination.reducer(state, action);
      }),
    };

    // Act / Assert: the defect rejects rather than reporting success.
    await expect(Effect.runPromise(pagination.next({
      store,
      identity: 'a',
      execute: async () => ({ ids: ['new'], next: 'two' }),
    }))).rejects.toThrow('Merge failed');
    expect(state.ids).toEqual(['old']);
    expect(state.pagination.cursor).toBe('one');
    expect(state.pagination.pending).toBeNull();
    expect(state.pagination.error?.message).toContain('Merge failed');
  });
});
