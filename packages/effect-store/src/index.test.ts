import {
  Context,
  Effect,
  Layer,
  ManagedRuntime
} from 'effect';
import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import {
  createStore,
  type StoreService
} from './index.js';

type State = { readonly message: string };

type Action = {
  readonly type: 'rename';
  readonly message: string
};

type StoreServices = {
  readonly label: string;
};

class Messages extends Context.Service<
  Messages,
  StoreService<State, Action, Messages, StoreServices>
>()('test/Messages') { }

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function runtime() {
  const value = ManagedRuntime.make(Layer.empty);

  runtimes.push(value);

  return value;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.dispose()));
});

describe('createStore', () => {
  test('provides per-store application services to effects', async () => {
    // Arrange: attach application services to a store-specific context.
    const store = createStore({
      runtime: runtime(),
      service: Messages,
      services: { label: 'first store' },
      initialState: { message: 'initial' },

      reducer: ({ state }: Readonly<{
        state: State;
        action: Action
      }>): State => state,
    });
    const program = Effect.gen(function*() {
      const store = yield* Messages;

      return store.label;
    });

    // Act: read the per-store service from an Effect.
    const result = store.dispatch(program);

    // Assert: the store provides the configured services.
    await expect(result).resolves.toBe('first store');
  });

  test('infers typed snapshots from a non-counter reducer', async () => {
    // Arrange: define a store with a different state and action shape.
    const store = createStore({
      runtime: runtime(),
      service: Messages,
      initialState: { message: 'initial' },

      reducer: ({ action }: Readonly<{
        state: State;
        action: Action
      }>): State => ({
        message: action.message,
      }),
    });

    // Act: dispatch a typed action.
    const result = await store.dispatch({ type: 'rename', message: 'updated' });

    // Assert: public state and action results retain their exact types.
    expectTypeOf(store.getSnapshot()).toEqualTypeOf<State>();
    expectTypeOf(result).toEqualTypeOf<Action>();
    expectTypeOf<{ type: 'unknown' }>().not.toExtend<
      Parameters<typeof store.dispatch>[0]
    >();
    expectTypeOf<{
      type: 'rename';
      message: number
    }>().not.toExtend<
      Parameters<typeof store.dispatch>[0]
    >();
    expect(store.getSnapshot()).toEqual({ message: 'updated' });
  });

  test('provides typed state and nested dispatch to generic flows', async () => {
    // Arrange: create a string-state store and a nested service-dependent flow.
    const store = createStore({
      runtime: runtime(),
      service: Messages,
      initialState: { message: 'initial' },

      reducer: ({ action }: Readonly<{
        state: State;
        action: Action
      }>): State => ({
        message: action.message,
      }),
    });
    const nested = Effect.gen(function*() {
      const store = yield* Messages;
      const state = yield* store.getState;

      expectTypeOf(state).toEqualTypeOf<State>();
      yield* store.dispatch({ type: 'rename', message: `${state.message}!` });

      return (yield* store.getState).message;
    });
    const program = Effect.gen(function*() {
      const store = yield* Messages;

      return yield* store.dispatch(nested);
    });

    // Act: run the generic flow at the Promise boundary.
    const result = store.dispatch(program);

    // Assert: Effect success types remain intact through nested dispatch.
    expectTypeOf(result).toEqualTypeOf<Promise<string>>();
    await expect(result).resolves.toBe('initial!');
  });
});
