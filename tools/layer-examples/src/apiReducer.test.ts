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

import {
  createRequestApi as createReduxApi,
  type RequestActions,
  type RequestApiState,
} from '@repo/redux-toolkit';
import { createRequestApi as createEffectApi } from '@repo/effect-store-toolkit';

type State = {
  readonly api: RequestApiState;
  readonly value: number;
};

for (const [name, create] of [
  ['Redux', createReduxApi],
  ['Effect', createEffectApi],
] satisfies readonly (readonly [string, typeof createReduxApi])[]) {
  describe(`${name} generated API reducer`, () => {
    function setup() {
      const api = create({
        name: 'numbers',
        state: (state) => state.api,
        getState: (state: State) => state.api,
        operations: (builder) => ({
          read: builder.query('read', {
            decode: () => 8,
            normalize: (value: number, variables: { readonly id: string }) => ({ id: variables.id, value }),
            scope: () => 'selection',
          }),
          save: builder.mutation('save', {
            decode: () => 9,
            normalize: (value: number, variables: { readonly id: string }) => ({ id: variables.id, value }),
          }),
        }),
      });
      let state: State = { api: { requests: {}, latest: {} }, value: 0 };
      const store = {
        getState: Effect.sync(() => state),
        dispatch: (action: RequestActions<typeof api.operations>) => Effect.sync(() => {
          state = api.reducer(state, action);
        }),
      };
      return { api, store, snapshot: () => state };
    }

    test.each(['read', 'save'] satisfies readonly ('read' | 'save')[])('manages %s metadata without domain handlers', async (operation) => {
      // Arrange: install only the generated API reducer.
      const { api, store, snapshot } = setup();
      const execute = vi.fn(async () => 8);

      // Act: run without registering any individual action cases.
      const result = await Effect.runPromise(api.operations[operation].run({
        store, variables: { id: 'one' }, execute,
      }));

      // Assert: metadata is managed while domain state is untouched.
      expect(result).toEqual({ status: 'succeeded' });
      expect(Object.values(snapshot().api.requests)[0]?.status).toBe('succeeded');
      expect(snapshot().value).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(api.operations[operation]).not.toHaveProperty('reducers');
    });

    test('preserves snapshot identity for unknown actions', () => {
      // Arrange: an initialized API state.
      const { api, snapshot } = setup();
      const before = snapshot();

      // Act: reduce an unrelated action.
      const after = api.reducer(before, { type: 'unrelated' });

      // Assert: unrelated state is not cloned.
      expect(after).toBe(before);
    });

    test('records transport failure without domain handlers', async () => {
      // Arrange: only metadata handling is installed.
      const { api, store, snapshot } = setup();
      const execute = vi.fn(async (): Promise<number> => {
        throw new Error('Transport failed.');
      });
      const variables = { id: 'one' };

      // Act: run a failing read.
      const result = await Effect.runPromise(api.operations.read.run({ store, variables, execute }));

      // Assert: the generated reducer owns visible failure metadata.
      expect(result).toEqual({ status: 'failed', error: 'Transport failed.' });
      expect(snapshot().api.requests[api.operations.read.key(variables)]).toMatchObject({
        status: 'failed', error: 'Transport failed.',
      });
      expect(snapshot().value).toBe(0);
    });

    test('records cancellation without domain handlers', async () => {
      // Arrange: transport stays pending until its only caller cancels.
      const { api, store, snapshot } = setup();
      const variables = { id: 'one' };
      let aborted = false;
      const execute = vi.fn((received: { readonly id: string }, signal: AbortSignal): Promise<number> =>
        new Promise((_resolve, reject) => {
          expect(received).toEqual(variables);
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('Transport aborted.'));
          }, { once: true });
        }));
      const worker = Effect.runFork(api.operations.read.run({ store, variables, execute }));

      // Act: cancel the only waiter.
      await Effect.runPromise(Fiber.interrupt(worker));

      // Assert: generated metadata releases ownership without domain callbacks.
      expect(aborted).toBe(true);
      expect(snapshot().api.requests[api.operations.read.key(variables)]).toMatchObject({
        status: 'cancelled', error: 'Request interrupted.',
      });
    });

    test('preserves identity for stale settlements in both reducers', () => {
      // Arrange: an old read is replaced in the same latest-wins scope.
      const { api, snapshot } = setup();
      const old = {
        key: api.operations.read.key({ id: 'old' }),
        scope: 'selection',
        requestId: 'old',
        variables: { id: 'old' },
      };
      const current = {
        key: api.operations.read.key({ id: 'new' }),
        scope: 'selection',
        requestId: 'new',
        variables: { id: 'new' },
      };
      const initial = api.reducer(snapshot(), api.operations.read.actions.started(old));
      const before = api.reducer(initial, api.operations.read.actions.started(current));
      const merge = vi.fn();
      const domain = api.operations.read.reducer({ onSuccess: merge });
      const stale = api.operations.read.actions.succeeded({
        ...old, result: { id: 'old', value: 8 },
      });

      // Act: publish a stale domain result and metadata settlement.
      const after = api.reducer(domain(before, stale), stale);

      // Assert: neither reducer changes the current snapshot.
      expect(after).toBe(before);
      expect(merge).not.toHaveBeenCalled();
      expect(before.api.requests[old.key]?.status).toBe('superseded');
      expect(before.api.requests[current.key]?.status).toBe('pending');
    });

    test('skips duplicate starts in both reducers', () => {
      // Arrange: a request already owns the key.
      const { api, snapshot } = setup();
      const request = {
        key: api.operations.read.key({ id: 'one' }),
        scope: 'selection',
        requestId: 'owner',
        variables: { id: 'one' },
      };
      const before = api.reducer(snapshot(), api.operations.read.actions.started(request));
      const onStarted = vi.fn();
      const domain = api.operations.read.reducer({ onStarted, onSuccess: () => {} });
      const duplicate = api.operations.read.actions.started({ ...request, requestId: 'duplicate' });

      // Act: publish another start for the pending key.
      const after = api.reducer(domain(before, duplicate), duplicate);

      // Assert: the existing owner remains untouched.
      expect(after).toBe(before);
      expect(onStarted).not.toHaveBeenCalled();
      expect(after.api.requests[request.key]?.requestId).toBe('owner');
    });

    test('composes separate guarded domain handlers before metadata', async () => {
      // Arrange: app-owned domain behavior and generated metadata are separate.
      const { api } = setup();
      const domain = api.operations.read.reducer({
        onSuccess: (state, { result }) => { state.value = result.value; },
      });
      let state: State = { api: { requests: {}, latest: {} }, value: 0 };
      const store = {
        getState: Effect.sync(() => state),
        dispatch: (action: RequestActions<typeof api.operations>) => Effect.sync(() => {
          state = api.reducer(domain(state, action), action);
        }),
      };

      // Act: execute the normalized read.
      await Effect.runPromise(api.operations.read.run({
        store, variables: { id: 'one' }, execute: async () => 8,
      }));

      // Assert: domain state and metadata settle together.
      expect(state.value).toBe(8);
      expect(Object.values(state.api.requests)[0]?.status).toBe('succeeded');
    });
  });
}
