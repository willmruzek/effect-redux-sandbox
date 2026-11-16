import { Effect } from 'effect';
import type { Draft } from 'immer';
import { describe, expect, test } from 'vitest';

import { createApiCore } from './engine.js';
import {
  createOptimisticOwnership,
  type OptimisticTarget,
  type RequestActions,
  type RequestApiState,
  type TransportReceipt,
} from './index.js';

type State = {
  readonly api: RequestApiState;
  readonly person: { readonly name: string; readonly role: string };
};

type Variables = {
  readonly field: 'name' | 'role';
  readonly value: string;
};

function harness() {
  const ownership = createOptimisticOwnership();
  const pending: Array<(receipt: TransportReceipt) => void> = [];
  const optimistic = {
    ownership,
    targets: (_state: State, variables: Variables): readonly OptimisticTarget[] => [{
      table: 'people',
      id: 'a',
      incarnation: 'a',
      field: variables.field,
    }],
    read: (state: State, target: OptimisticTarget) => {
      if (target.field === 'name' || target.field === 'role')
        return state.person[target.field];

      return undefined;
    },
    proposed: (_state: State, variables: Variables) => variables.value,
    confirmed: (result: string) => result,
    write: (state: Draft<State>, target: OptimisticTarget, value: unknown) => {
      if ((target.field !== 'name' && target.field !== 'role') || typeof value !== 'string')
        throw new Error('Invalid optimistic field.');

      state.person[target.field] = value;
    },
  };
  const transport = () => new Promise<TransportReceipt>((resolve) => pending.push(resolve));
  const rest = createApiCore({
    name: 'rest',
    state: (state: Draft<State>) => state.api,
    getState: (state: State) => state.api,
    endpoints: (builder) => ({
      update: builder.mutation('update', {
        scope: () => 'person',
        transport,
        decode: (data: unknown): string => {
          if (typeof data !== 'string')
            throw new Error('Invalid response.');
          return data;
        },
        normalize: (value: string) => value,
        optimistic,
      }),
    }),
  });
  const graphql = createApiCore({
    name: 'graphql',
    endpoint: '/graphql',
    state: (state: Draft<State>) => state.api,
    getState: (state: State) => state.api,
    endpoints: (builder) => ({
      update: builder.mutation('update', {
        document: 'mutation Update { update }',
        transport,
        scope: (variables: Variables) => variables.field,
        decode: (data: unknown): string => {
          if (typeof data !== 'string')
            throw new Error('Invalid response.');
          return data;
        },
        normalize: (value: string) => value,
        optimistic,
      }),
    }),
  });
  let state: State = {
    api: { requests: {}, latest: {} },
    person: { name: 'Initial', role: 'Original' },
  };
  const store = {
    getState: Effect.sync(() => state),
    dispatch: (
      action: RequestActions<typeof rest.endpoints> | RequestActions<typeof graphql.endpoints>,
    ) => Effect.sync(() => {
      state = rest.reducer(
        graphql.reducer(
          graphql.endpoints.update.optimisticReducer(
            rest.endpoints.update.optimisticReducer(state, action),
            action,
          ),
          action,
        ),
        action,
      );
    }),
  };

  return {
    rest,
    graphql,
    store,
    snapshot: () => state,
    transportCalls: () => pending.length,
    settle: (index: number, value: string) => {
      const resolve = pending[index];
      if (!resolve)
        throw new Error('Transport not started.');
      resolve({ status: 'received', read: async () => value });
    },
  };
}

describe('cross-factory optimistic ownership', () => {
  test('settles independent fields of the same scoped mutation concurrently', async () => {
    // Arrange: keep two distinct field writes in the same declared scope pending.
    const app = harness();
    const name = Effect.runPromise(app.rest.endpoints.update.run({
      store: app.store,
      variables: { field: 'name', value: 'New name' },
    }));
    const role = Effect.runPromise(app.rest.endpoints.update.run({
      store: app.store,
      variables: { field: 'role', value: 'New role' },
    }));

    // Act: complete both requests.
    app.settle(0, 'Saved name');
    app.settle(1, 'Saved role');
    const outcomes = await Promise.all([name, role]);

    // Assert: neither independent write is superseded or left pending.
    expect(outcomes).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
    expect(app.snapshot().person).toEqual({ name: 'Saved name', role: 'Saved role' });
    expect(app.rest.endpoints.update.selectRequest(app.snapshot(), { field: 'name', value: 'New name' })?.status)
      .toBe('succeeded');
  });

  test('skips a conflicting GraphQL write before transport when REST owns the field', async () => {
    // Arrange: keep a REST write pending.
    const app = harness();
    const rest = Effect.runPromise(app.rest.endpoints.update.run({
      store: app.store,
      variables: { field: 'name', value: 'REST' },
    }));

    // Act: request a GraphQL write to the same field.
    const conflict = await Effect.runPromise(app.graphql.endpoints.update.run({
      store: app.store,
      variables: { field: 'name', value: 'GraphQL' },
    }));

    // Assert: the second write neither changes state nor starts transport.
    expect(conflict).toEqual({ status: 'skipped', reason: 'conflict' });
    expect(app.snapshot().person.name).toBe('REST');
    expect(app.transportCalls()).toBe(1);
    app.settle(0, 'Saved');
    await rest;
  });

  test('confirms independent REST and GraphQL fields without overwriting each other', async () => {
    // Arrange: keep a REST write pending while starting a distinct GraphQL field.
    const app = harness();
    const rest = Effect.runPromise(app.rest.endpoints.update.run({
      store: app.store,
      variables: { field: 'name', value: 'REST' },
    }));
    const graphql = Effect.runPromise(app.graphql.endpoints.update.run({
      store: app.store,
      variables: { field: 'role', value: 'GraphQL' },
    }));

    // Act: settle the writes in reverse order.
    expect(app.snapshot().person).toEqual({ name: 'REST', role: 'GraphQL' });
    app.settle(1, 'Saved role');
    await graphql;
    app.settle(0, 'Saved name');
    await rest;

    // Assert: both transports ran and both confirmed fields survive.
    expect(app.transportCalls()).toBe(2);
    expect(app.snapshot().person).toEqual({ name: 'Saved name', role: 'Saved role' });
  });

  test('allows the same target in independently constructed stores', async () => {
    // Arrange: each store owns its own factory instances and registry.
    const first = harness();
    const second = harness();
    const initial = Effect.runPromise(first.rest.endpoints.update.run({
      store: first.store,
      variables: { field: 'name', value: 'First' },
    }));

    // Act: start the same target in a second store.
    const other = Effect.runPromise(second.graphql.endpoints.update.run({
      store: second.store,
      variables: { field: 'name', value: 'Second' },
    }));

    // Assert: both requests start independently.
    expect(first.transportCalls()).toBe(1);
    expect(second.transportCalls()).toBe(1);
    expect(first.snapshot().person.name).toBe('First');
    expect(second.snapshot().person.name).toBe('Second');
    first.settle(0, 'First saved');
    second.settle(0, 'Second saved');
    expect(await initial).toEqual({ status: 'succeeded' });
    expect(await other).toEqual({ status: 'succeeded' });
  });
});
