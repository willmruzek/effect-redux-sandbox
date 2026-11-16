// @vitest-environment happy-dom

import { configureStore } from '@reduxjs/toolkit';
import { createStore, type StoreService } from '@repo/effect-store';
import {
  createGraphqlApi as createEffectApi,
  createInvalidationRegistry as createEffectInvalidationRegistry,
  type InvalidationAction as EffectInvalidationAction,
  type RequestActions as EffectRequestActions,
} from '@repo/effect-store-toolkit';
import {
  createGraphqlApi as createReduxApi,
  createInvalidationRegistry as createReduxInvalidationRegistry,
  type InvalidationAction as ReduxInvalidationAction,
  type InvalidationState,
  type InvalidationTag,
  type RequestActions as ReduxRequestActions,
} from '@repo/redux-toolkit';
import { Context, Effect, Fiber, Layer, ManagedRuntime } from 'effect';
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

import {
  useMutation,
  useQuery,
  type IncompleteRollback,
  type RequestOutcome,
  type RequestStatus,
} from '@repo/request-react';

type State = {
  readonly invalidation: InvalidationState<'Item'>;
  readonly api: {
    readonly requests: Readonly<Record<string, {
      readonly status: 'pending' | 'succeeded' | 'superseded';
      readonly requestId: string;
    } | {
      readonly status: 'failed' | 'cancelled';
      readonly requestId: string;
      readonly error: string;
    }>>;
    readonly latest: Readonly<Record<string, {
      readonly key: string;
      readonly requestId: string;
    }>>;
  };
};

type Variables = { readonly id: string };
type Execute = (variables: Variables, signal: AbortSignal) => Promise<string>;

function makeTransport(execute: Execute) {
  return async (variables: Variables, signal: AbortSignal) => {
    const value = await execute(variables, signal);
    return { status: 'received', read: async () => value } satisfies {
      readonly status: 'received';
      readonly read: () => Promise<unknown>;
    };
  };
}

const initialState = (): State => ({
  api: { requests: {}, latest: {} },
  invalidation: { revision: 0, queries: {}, history: [] },
});

const definition = {
  decode: (_data: unknown, variables: Variables) => variables.id,
  normalize: (value: string) => value,
};

function deferred() {
  let resolve: (value: string) => void = () => {
    throw new Error('Request not started');
  };
  const execute = vi.fn(() => new Promise<string>((done) => {
    resolve = done;
  }));

  return { execute, resolve: (value: string) => resolve(value) };
}

function reduxSetup(execute: Execute = async (variables) => variables.id) {
  const transport = makeTransport(execute);
  const registry = createReduxInvalidationRegistry<State, 'Item'>()({
    name: 'test',
    getState: (state) => state.invalidation,
    setState: (state, invalidation) => ({ ...state, invalidation }),
  });
  const api = createReduxApi({
    name: 'test',
    endpoint: '/graphql',
    state: (state) => state.api,
    getState: (state: State) => state.api,
    operations: (builder) => ({
      query: builder.query('query', {
        ...definition,
        document: 'query Item { item }',
        transport,
        scope: () => 'selection',
        provides: {
          registry,
          fromVariables: (variables: Variables): readonly InvalidationTag<'Item'>[] =>
            [{ type: 'Item', id: variables.id }],
          fromResult: () => [],
        },
      }),
      mutation: builder.mutation('mutation', {
        ...definition,
        document: 'mutation Item { item }',
        transport,
      }),
    }),
  });
  const redux = configureStore({
    reducer: (state: State = initialState(), action) => api.reducer(registry.reducer(state, action), action),
  });
  type Action = ReduxRequestActions<typeof api.operations> | ReduxInvalidationAction<'Item'>;
  const service = {
    getState: Effect.sync(redux.getState),
    dispatch: (action: Action) => Effect.sync(() => redux.dispatch(action)),
  };

  return {
    api,
    registry,
    source: { subscribe: redux.subscribe, getSnapshot: redux.getState },
    service,
    dispose: async () => {},
  };
}

function effectSetup(execute: Execute = async (variables) => variables.id) {
  const transport = makeTransport(execute);
  const registry = createEffectInvalidationRegistry<State, 'Item'>()({
    name: 'test',
    getState: (state) => state.invalidation,
    setState: (state, invalidation) => ({ ...state, invalidation }),
  });
  const api = createEffectApi({
    name: 'test',
    endpoint: '/graphql',
    state: (state) => state.api,
    getState: (state: State) => state.api,
    operations: (builder) => ({
      query: builder.query('query', {
        ...definition,
        document: 'query Item { item }',
        transport,
        scope: () => 'selection',
        provides: {
          registry,
          fromVariables: (variables: Variables): readonly InvalidationTag<'Item'>[] =>
            [{ type: 'Item', id: variables.id }],
          fromResult: () => [],
        },
      }),
      mutation: builder.mutation('mutation', {
        ...definition,
        document: 'mutation Item { item }',
        transport,
      }),
    }),
  });
  type Action = EffectRequestActions<typeof api.operations> | EffectInvalidationAction<'Item'>;

  class TestStore extends Context.Service<TestStore, StoreService<State, Action, TestStore>>()('test/store') {}

  const runtime = ManagedRuntime.make(Layer.empty);
  const store = createStore({
    service: TestStore,
    runtime,
    initialState: initialState(),
    reducer: ({ state, action }) => api.reducer(registry.reducer(state, action), action),
  });
  const service = {
    getState: Effect.sync(store.getSnapshot),
    dispatch: (action: Action) => Effect.sync(() => store.dispatch(action)),
  };

  return { api, registry, source: store, service, dispose: () => runtime.dispose() };
}

describe.each([
  ['Redux', reduxSetup],
  ['Effect', effectSetup],
])('%s manual request hooks', (_name, setup) => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  describe('mutation uncertainty types', () => {
    test('exposes possible server commits on failure outcomes and metadata', () => {
      // Arrange: derive the failed public outcome and observable status types.
      type FailedOutcome = Extract<RequestOutcome, { status: 'failed' }>;
      type FailedStatus = Extract<RequestStatus, { status: 'failed' | 'cancelled' }>;

      // Act / Assert: callers can inspect the same marker on both surfaces.
      expectTypeOf<FailedOutcome>().toHaveProperty('serverMayHaveCommitted');
      expectTypeOf<FailedStatus>().toHaveProperty('serverMayHaveCommitted');
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('useQuery observes freshness without starting a fetch', async () => {
    // Arrange: observe an uninitialized query with a manually controlled transport.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);

    function Consumer() {
      const { freshness } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{freshness}</p>;
    }

    await act(async () => root.render(<Consumer />));
    expect(container.textContent).toBe('uninitialized');
    expect(execute).not.toHaveBeenCalled();

    // Act: complete the query and invalidate its registered dependency.
    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
      }));
    });
    expect(container.textContent).toBe('fresh');
    await act(async () => {
      await Effect.runPromise(app.registry.invalidate({
        store: app.service,
        tags: [{ type: 'Item', id: 'a' }],
      }));
    });

    // Assert: invalidation updates the hook without fetching again.
    expect(container.textContent).toBe('stale');
    expect(execute).toHaveBeenCalledTimes(1);
    await app.dispose();
  });

  test('useQuery remains idle until manually triggered', async () => {
    // Arrange: mount a query with a controlled transport.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);

    function Consumer() {
      const { request, trigger } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      expectTypeOf(trigger).returns.toEqualTypeOf<Promise<
        | { readonly status: 'succeeded' | 'superseded' }
        | { readonly status: 'skipped'; readonly reason?: 'conflict' }
        | {
          readonly status: 'failed';
          readonly error: string;
          readonly serverMayHaveCommitted?: true;
          readonly rollback?: IncompleteRollback;
        }
      >>();

      return <button onClick={() => void trigger()}>{request.status}</button>;
    }

    // Act: render without invoking the trigger.
    await act(async () => root.render(<Consumer />));

    // Assert: rendering does not start transport.
    expect(container.textContent).toBe('idle');
    expect(execute).not.toHaveBeenCalled();
    await app.dispose();
  });

  test('useQuery reports externally started requests for its bound key', async () => {
    // Arrange: mount a query observing one key.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));

    // Act: run the existing operation outside the hook.
    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
      }));
    });

    // Assert: the store's shared metadata drives the hook.
    expect(container.textContent).toBe('succeeded');
    expect(execute).toHaveBeenCalledWith({ id: 'a' }, expect.any(AbortSignal));
    await app.dispose();
  });

  test('useQuery switches keys without starting transport', async () => {
    // Arrange: mount a query and complete a request for its first key.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);

    function Consumer({ id }: Readonly<{ id: string }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
      }));
      root.render(<Consumer id="a" />);
    });

    // Act: observe a different key.
    await act(async () => root.render(<Consumer id="b" />));

    // Assert: the new key is idle and did not trigger a request.
    expect(container.textContent).toBe('idle');
    expect(execute).toHaveBeenCalledTimes(1);
    await app.dispose();
  });

  test('useQuery isolates metadata between stores', async () => {
    // Arrange: observe the same key in two separate store instances.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const first = setup(execute);
    const second = setup(execute);

    function Consumer({ app }: Readonly<{ app: ReturnType<typeof setup> }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<><Consumer app={first} /><Consumer app={second} /></>));

    // Act: run the first store's request.
    await act(async () => {
      await Effect.runPromise(first.api.operations.query.run({
        store: first.service,
        variables: { id: 'a' },
      }));
    });

    // Assert: the other store remains idle.
    expect(container.textContent).toBe('succeededidle');
    await first.dispose();
    await second.dispose();
  });

  test('useQuery displays superseded metadata for an older key', async () => {
    // Arrange: start one query in a shared latest-wins scope.
    const transport = deferred();
    const app = setup((variables) => variables.id === 'b' ? Promise.resolve('b') : transport.execute());

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
      }));
    });

    // Act: a later request claims the same scope with another key.
    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'b' },
      }));
    });

    // Assert: the original key shows superseded rather than success.
    expect(container.textContent).toBe('superseded');
    transport.resolve('a');
    await expect(first).resolves.toEqual({ status: 'superseded' });
    await app.dispose();
  });

  test('useQuery observes cancellation initiated outside the hook', async () => {
    // Arrange: observe an external query whose transport is pending.
    const transport = deferred();
    const app = setup(transport.execute);

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    const fiber = Effect.runFork(app.api.operations.query.run({
      store: app.service,
      variables: { id: 'a' },
    }));
    await act(async () => {});

    // Act: interrupt the external caller.
    await act(async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    });

    // Assert: the hook exposes cancellation from the store.
    expect(container.textContent).toBe('cancelled');
    await app.dispose();
  });

  test('useQuery shares pending execution between manual triggers', async () => {
    // Arrange: mount two observers of the same operation and store service.
    const transport = deferred();
    const app = setup(transport.execute);
    const triggers: Array<() => Promise<unknown>> = [];

    function Consumer() {
      const { request, trigger } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      triggers.push(trigger);
      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<><Consumer /><Consumer /></>));

    // Act: trigger both observers before the transport completes.
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    await act(async () => {
      const [firstTrigger, secondTrigger] = triggers;

      if (!firstTrigger || !secondTrigger)
        throw new Error('Both consumers must mount.');

      first = firstTrigger();
      second = secondTrigger();
    });

    // Assert: one pending request is visible to both observers.
    expect(container.textContent).toBe('pendingpending');
    expect(transport.execute).toHaveBeenCalledTimes(1);
    await act(async () => transport.resolve('a'));
    await expect(first).resolves.toEqual({ status: 'succeeded' });
    await expect(second).resolves.toEqual({ status: 'succeeded' });
    expect(container.textContent).toBe('succeededsucceeded');
    await app.dispose();
  });

  test('useMutation preserves duplicate-pending skipped outcomes', async () => {
    // Arrange: mount a mutation with a transport that remains pending.
    const transport = deferred();
    const app = setup(transport.execute);
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useMutation({
        operation: app.api.operations.mutation,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      trigger = result.trigger;
      return <p>{result.request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = trigger();
    });

    // Act: trigger a duplicate while the first request owns the key.
    let duplicate: unknown;
    await act(async () => {
      duplicate = await trigger();
    });

    // Assert: skipping does not overwrite the pending metadata.
    expect(duplicate).toEqual({ status: 'skipped' });
    expect(container.textContent).toBe('pending');
    expect(transport.execute).toHaveBeenCalledTimes(1);
    await act(async () => transport.resolve('a'));
    await expect(first).resolves.toEqual({ status: 'succeeded' });
    await app.dispose();
  });

  test('useQuery leaves a triggered request running after unmount', async () => {
    // Arrange: start a manual query with a pending transport.
    const transport = deferred();
    const app = setup(transport.execute);
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      trigger = result.trigger;
      return <p>{result.request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    let outcome: Promise<unknown> = Promise.resolve();
    await act(async () => {
      outcome = trigger();
    });

    // Act: unmount the observer while the request is pending.
    await act(async () => root.render(null));

    // Assert: its trigger still receives the completed result.
    transport.resolve('a');
    await expect(outcome).resolves.toEqual({ status: 'succeeded' });
    expect(app.api.operations.query.selectRequest(app.source.getSnapshot(), { id: 'a' })?.status).toBe('succeeded');
    await app.dispose();
  });

  test('useQuery rejects when the receiving service cannot claim a request', async () => {
    // Arrange: install the registry but do not publish request actions.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);
    const service = {
      getState: Effect.sync(app.source.getSnapshot),
      dispatch: (action: Parameters<typeof app.service.dispatch>[0]) =>
        'kind' in action ? app.service.dispatch(action) : Effect.void,
    };
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: service, variables: { id: 'a' } },
      });

      trigger = result.trigger;
      return <p>{result.request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));

    // Act / Assert: failed ownership rejects instead of reporting success.
    await expect(trigger()).rejects.toThrow('Could not claim query request.');
    expect(container.textContent).toBe('idle');
    expect(execute).not.toHaveBeenCalled();
    await app.dispose();
  });

  test('useQuery removes its subscription when unmounted', async () => {
    // Arrange: observe a source that records subscription cleanup.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);
    const unsubscribe = vi.fn();
    const source = {
      getSnapshot: app.source.getSnapshot,
      subscribe: (listener: () => void) => {
        const stop = app.source.subscribe(listener);

        return () => {
          stop();
          unsubscribe();
        };
      },
    };

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));

    // Act: unmount the observer.
    await act(async () => root.render(null));

    // Assert: the store subscription is released.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await app.dispose();
  });

  test('useMutation returns the failure outcome and displays its error', async () => {
    // Arrange: mount a mutation whose transport rejects.
    const execute = vi.fn(async (): Promise<string> => {
      throw new Error('Rejected');
    });
    const app = setup(execute);
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useMutation({
        operation: app.api.operations.mutation,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      trigger = result.trigger;
      return <p>{result.request.status === 'failed' ? result.request.error : result.request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));

    // Act: invoke the mutation explicitly.
    let outcome: unknown;
    await act(async () => {
      outcome = await trigger();
    });

    // Assert: the outcome and shared status retain the failure.
    expect(outcome).toEqual({ status: 'failed', error: 'Rejected', serverMayHaveCommitted: true });
    expect(container.textContent).toBe('Rejected');
    await app.dispose();
  });

  test('useQuery reads the request-scoped snapshot during server rendering', async () => {
    // Arrange: create a fresh, unstarted request-scoped store.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const app = setup(execute);

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    // Act: render without a browser subscription.
    const html = renderToString(<Consumer />);

    // Assert: SSR reads idle state without executing transport.
    expect(html).toBe('<p>idle</p>');
    expect(execute).not.toHaveBeenCalled();
    await app.dispose();
  });

  test('useQuery hydrates the same request-scoped snapshot without transport', async () => {
    // Arrange: render matching server and client stores.
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const server = setup(execute);
    const client = setup(execute);

    function Consumer({ app }: Readonly<{ app: ReturnType<typeof setup> }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' } },
      });

      return <p>{request.status}</p>;
    }

    container.innerHTML = renderToString(<Consumer app={server} />);
    await act(async () => root.unmount());

    // Act: hydrate the serialized server markup with the equivalent client state.
    await act(async () => {
      root = hydrateRoot(container, <Consumer app={client} />);
    });

    // Assert: hydration preserves idle status without fetching.
    expect(container.textContent).toBe('idle');
    expect(execute).not.toHaveBeenCalled();
    await server.dispose();
    await client.dispose();
  });
});
