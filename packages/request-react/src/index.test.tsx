// @vitest-environment happy-dom

import { configureStore } from '@reduxjs/toolkit';
import { createStore, type StoreService } from '@repo/effect-store';
import {
  createRequestApi as createEffectApi,
  type RequestActions as EffectRequestActions,
} from '@repo/effect-store-toolkit';
import {
  createRequestApi as createReduxApi,
  type RequestActions as ReduxRequestActions,
} from '@repo/redux-toolkit';
import { Context, Effect, Fiber, Layer, ManagedRuntime } from 'effect';
import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

import { useMutation, useQuery } from '@repo/request-react';

type State = {
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

const initialState = (): State => ({ api: { requests: {}, latest: {} } });

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

function reduxSetup() {
  const api = createReduxApi({
    name: 'test',
    state: (state) => state.api,
    getState: (state: State) => state.api,
    operations: (builder) => ({
      query: builder.query('query', { ...definition, scope: () => 'selection' }),
      mutation: builder.mutation('mutation', definition),
    }),
  });
  const redux = configureStore({
    reducer: (state: State = initialState(), action) => api.reducer(state, action),
  });
  type Action = ReduxRequestActions<typeof api.operations>;
  const service = {
    getState: Effect.sync(redux.getState),
    dispatch: (action: Action) => Effect.sync(() => redux.dispatch(action)),
  };

  return {
    api,
    source: { subscribe: redux.subscribe, getSnapshot: redux.getState },
    service,
    dispose: async () => {},
  };
}

function effectSetup() {
  const api = createEffectApi({
    name: 'test',
    state: (state) => state.api,
    getState: (state: State) => state.api,
    operations: (builder) => ({
      query: builder.query('query', { ...definition, scope: () => 'selection' }),
      mutation: builder.mutation('mutation', definition),
    }),
  });
  type Action = EffectRequestActions<typeof api.operations>;

  class TestStore extends Context.Service<TestStore, StoreService<State, Action, TestStore>>()('test/store') {}

  const runtime = ManagedRuntime.make(Layer.empty);
  const store = createStore({
    service: TestStore,
    runtime,
    initialState: initialState(),
    reducer: ({ state, action }) => api.reducer(state, action),
  });
  const service = {
    getState: Effect.sync(store.getSnapshot),
    dispatch: (action: Action) => Effect.sync(() => store.dispatch(action)),
  };

  return { api, source: store, service, dispose: () => runtime.dispose() };
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

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('useQuery remains idle until manually triggered', async () => {
    // Arrange: mount a query with a controlled transport.
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer() {
      const { request, trigger } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
      });

      expectTypeOf(trigger).returns.toEqualTypeOf<Promise<
        | { readonly status: 'succeeded' | 'skipped' | 'superseded' }
        | { readonly status: 'failed'; readonly error: string }
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
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));

    // Act: run the existing operation outside the hook.
    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
        execute,
      }));
    });

    // Assert: the store's shared metadata drives the hook.
    expect(container.textContent).toBe('succeeded');
    expect(execute).toHaveBeenCalledWith({ id: 'a' }, expect.any(AbortSignal));
    await app.dispose();
  });

  test('useQuery switches keys without starting transport', async () => {
    // Arrange: mount a query and complete a request for its first key.
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer({ id }: Readonly<{ id: string }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id }, execute },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
        execute,
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
    const first = setup();
    const second = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer({ app }: Readonly<{ app: ReturnType<typeof setup> }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<><Consumer app={first} /><Consumer app={second} /></>));

    // Act: run the first store's request.
    await act(async () => {
      await Effect.runPromise(first.api.operations.query.run({
        store: first.service,
        variables: { id: 'a' },
        execute,
      }));
    });

    // Assert: the other store remains idle.
    expect(container.textContent).toBe('succeededidle');
    await first.dispose();
    await second.dispose();
  });

  test('useQuery displays superseded metadata for an older key', async () => {
    // Arrange: start one query in a shared latest-wins scope.
    const app = setup();
    const transport = deferred();

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute: transport.execute },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'a' },
        execute: transport.execute,
      }));
    });

    // Act: a later request claims the same scope with another key.
    await act(async () => {
      await Effect.runPromise(app.api.operations.query.run({
        store: app.service,
        variables: { id: 'b' },
        execute: async () => 'b',
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
    const app = setup();
    const transport = deferred();

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute: transport.execute },
      });

      return <p>{request.status}</p>;
    }

    await act(async () => root.render(<Consumer />));
    const fiber = Effect.runFork(app.api.operations.query.run({
      store: app.service,
      variables: { id: 'a' },
      execute: transport.execute,
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
    const app = setup();
    const transport = deferred();
    const triggers: Array<() => Promise<unknown>> = [];

    function Consumer() {
      const { request, trigger } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute: transport.execute },
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
    const app = setup();
    const transport = deferred();
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useMutation({
        operation: app.api.operations.mutation,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute: transport.execute },
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
    const app = setup();
    const transport = deferred();
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute: transport.execute },
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
    // Arrange: provide a service that does not publish request actions.
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);
    const service = {
      getState: Effect.sync(app.source.getSnapshot),
      dispatch: () => Effect.void,
    };
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: service, variables: { id: 'a' }, execute },
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
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);
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
        input: { store: app.service, variables: { id: 'a' }, execute },
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
    const app = setup();
    const execute = vi.fn(async (): Promise<string> => {
      throw new Error('Rejected');
    });
    let trigger: () => Promise<unknown> = async () => {
      throw new Error('Not mounted');
    };

    function Consumer() {
      const result = useMutation({
        operation: app.api.operations.mutation,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
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
    expect(outcome).toEqual({ status: 'failed', error: 'Rejected' });
    expect(container.textContent).toBe('Rejected');
    await app.dispose();
  });

  test('useQuery reads the request-scoped snapshot during server rendering', async () => {
    // Arrange: create a fresh, unstarted request-scoped store.
    const app = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer() {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
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
    const server = setup();
    const client = setup();
    const execute = vi.fn(async (variables: Variables) => variables.id);

    function Consumer({ app }: Readonly<{ app: ReturnType<typeof setup> }>) {
      const { request } = useQuery({
        operation: app.api.operations.query,
        source: app.source,
        input: { store: app.service, variables: { id: 'a' }, execute },
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
