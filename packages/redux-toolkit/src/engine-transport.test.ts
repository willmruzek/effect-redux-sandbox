import {
  Effect,
  Fiber,
} from 'effect';
import {
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createApiCore } from './engine.js';
import {
  type RequestActions,
  type RequestApiState,
} from './index.js';
import type { TransportReceipt } from './transport.js';

type State = {
  readonly api: RequestApiState;
  readonly value: string;
};

describe('definition-time request transport', () => {
  test('runs the configured transport when a query is triggered', async () => {
    // Arrange: define a query and a store with its generated reducers.
    const transport = vi.fn<(variables: { readonly id: string }, signal: AbortSignal) => Promise<TransportReceipt>>(
      async () => ({
      status: 'received',
      read: async (): Promise<unknown> => 'remote',
    }));
    const api = createApiCore({
      name: 'test',
      endpoint: '/unused',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        item: builder.query('item', {
          document: 'query Item { item }',
          transport,
          decode: (data: unknown): string => {
            if (typeof data !== 'string')
              throw new Error('Invalid item.');

            return data;
          },
          normalize: (value: string) => value,
        }),
      }),
    });
    const reducer = api.endpoints.item.reducer({
      onSuccess: (state, { result }) => { state.value = result; },
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(reducer(state, action), action);
      }),
    };

    // Act: run the query without any per-call transport.
    const outcome = await Effect.runPromise(api.endpoints.item.run({
      store,
      variables: { id: '1' },
    }));

    // Assert: the configured transport ran and its decoded result was published.
    expect(outcome).toEqual({ status: 'succeeded' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toEqual({ id: '1' });
    expect(state.value).toBe('remote');
  });

  test('marks a mutation decoding failure as a possible server commit', async () => {
    // Arrange: the server acknowledges a response the decoder cannot interpret.
    const api = createApiCore({
      name: 'test',
      endpoint: '/unused',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        update: builder.mutation('update', {
          document: 'mutation Update { update }',
          transport: async (): Promise<TransportReceipt> => ({
            status: 'received',
            read: async (): Promise<unknown> => 'invalid',
          }),
          decode: (): string => { throw new Error('Invalid response.'); },
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(state, action);
      }),
    };

    // Act: run the acknowledged mutation.
    const outcome = await Effect.runPromise(api.endpoints.update.run({
      store,
      variables: {},
    }));

    // Assert: the failed outcome and request metadata expose uncertainty.
    expect(outcome).toEqual({
      status: 'failed',
      error: 'Invalid response.',
      serverMayHaveCommitted: true,
    });
    expect(api.endpoints.update.selectRequest(state, {})).toMatchObject({
      status: 'failed',
      error: 'Invalid response.',
      serverMayHaveCommitted: true,
    });
  });

  test('completes mutation settlement when interrupted after response receipt', async () => {
    // Arrange: pause body reading after the server acknowledges the request.
    let beginReading: () => void = () => { throw new Error('Reader did not start.'); };
    const reading = new Promise<void>((resolve) => { beginReading = resolve; });
    let finishReading: (value: unknown) => void = () => { throw new Error('Reader did not start.'); };
    const body = new Promise<unknown>((resolve) => { finishReading = resolve; });
    const api = createApiCore({
      name: 'test',
      endpoint: '/unused',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        update: builder.mutation('update', {
          document: 'mutation Update { update }',
          transport: async (): Promise<TransportReceipt> => ({
            status: 'received',
            read: () => {
              beginReading();
              return body;
            },
          }),
          decode: (data: unknown): string => {
            if (typeof data !== 'string')
              throw new Error('Invalid response.');

            return data;
          },
          normalize: (value: string) => value,
        }),
      }),
    });
    const reducer = api.endpoints.update.reducer({
      onSuccess: (state, { result }) => { state.value = result; },
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(reducer(state, action), action);
      }),
    };

    // Act: interrupt after receipt and then allow the response to finish.
    const fiber = Effect.runFork(api.endpoints.update.run({ store, variables: {} }));
    await reading;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await Promise.resolve();
    finishReading('confirmed');
    await interrupted;

    // Assert: confirmation is published instead of cancellation or rollback.
    expect(state.value).toBe('confirmed');
    expect(api.endpoints.update.selectRequest(state, {})).toMatchObject({ status: 'succeeded' });
  });

  test('marks cancellation during mutation transport as an uncertain commit', async () => {
    // Arrange: keep transport pending after recording its abort signal.
    let started: (signal: AbortSignal) => void = () => { throw new Error('Transport did not start.'); };
    const transportStarted = new Promise<AbortSignal>((resolve) => { started = resolve; });
    const api = createApiCore({
      name: 'test',
      endpoint: '/unused',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        update: builder.mutation('update', {
          document: 'mutation Update { update }',
          transport: (...args: [variables: object, signal: AbortSignal]): Promise<TransportReceipt> => {
            started(args[1]);
            return new Promise(() => {});
          },
          decode: (): string => 'saved',
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(state, action);
      }),
    };

    // Act: interrupt after the request is handed to transport.
    const fiber = Effect.runFork(api.endpoints.update.run({ store, variables: {} }));
    const signal = await transportStarted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Assert: interruption aborts transport and records the uncertain outcome.
    expect(signal.aborted).toBe(true);
    expect(api.endpoints.update.selectRequest(state, {})).toMatchObject({
      status: 'cancelled',
      error: 'Request interrupted.',
      serverMayHaveCommitted: true,
    });
  });

  test('does not mark a transport failure as uncertain when no request was sent', async () => {
    // Arrange: the transport reports a definite pre-send failure.
    const api = createApiCore({
      name: 'test',
      endpoint: '/unused',
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        update: builder.mutation('update', {
          document: 'mutation Update { update }',
          transport: async (): Promise<TransportReceipt> => ({
            status: 'failed',
            error: new Error('Invalid request body.'),
            serverMayHaveCommitted: false,
          }),
          decode: (): string => 'saved',
          normalize: (value: string) => value,
        }),
      }),
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      value: 'initial',
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(state, action);
      }),
    };

    // Act: run the mutation.
    const outcome = await Effect.runPromise(api.endpoints.update.run({ store, variables: {} }));

    // Assert: the failure is observable without a possible-commit marker.
    expect(outcome).toEqual({ status: 'failed', error: 'Invalid request body.' });
    expect(api.endpoints.update.selectRequest(state, {})).toMatchObject({
      status: 'failed',
      error: 'Invalid request body.',
    });
    expect(api.endpoints.update.selectRequest(state, {})).not.toHaveProperty('serverMayHaveCommitted');
  });
});
