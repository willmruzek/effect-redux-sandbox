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
  type StoreMiddleware,
  type StoreService
} from './index.js';

type State = { readonly value: number };

type Action = { readonly type: 'increment' };

class Counter extends Context.Service<Counter, StoreService<State, Action, Counter>>()('middleware-test/Counter') { }

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange(middleware: readonly StoreMiddleware<State, Action>[]) {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  return createStore({
    service: Counter,
    runtime,
    initialState: { value: 0 },

    reducer: ({ state }) => ({ value: state.value + 1 }),

    middleware,
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('synchronous action middleware', () => {
  test('wraps reducers in registration order', () => {
    // Arrange: record the state around each synchronous handler.
    const seen: string[] = [];
    const record = (name: string): StoreMiddleware<State, Action> => ({ getState, next }) => {
      seen.push(`${name}:before:${getState().value}`);

      const result = next();

      seen.push(`${name}:after:${getState().value}`);

      return result;
    };
    const store = arrange([record('first'), record('second')]);

    // Act: dispatch synchronously through both handlers.
    const result = store.dispatch({ type: 'increment' });

    // Assert: the complete pipeline finishes before returning.
    expectTypeOf(result).toEqualTypeOf<Action>();
    expect(seen).toEqual(['first:before:0', 'second:before:0', 'second:after:1', 'first:after:1']);
  });

  test('intercepts only the actions dispatched by an Effect', async () => {
    // Arrange: record every middleware input.
    const seen: string[] = [];
    const store = arrange([({ action, next }) => {
      seen.push(action.type);

      return next();
    }]);
    const program = Effect.gen(function*() {
      const store = yield* Counter;

      yield* store.dispatch({ type: 'increment' });

      return 42;
    });

    // Act: run a workflow containing one action.
    const result = await store.dispatch(program);

    // Assert: Effect execution itself is not an intercepted action.
    expect(result).toBe(42);
    expect(seen).toEqual(['increment']);
  });

  test('supports synchronous nested action dispatch', () => {
    // Arrange: only the first action triggers a nested action.
    let nested = false;
    const store = arrange([({ dispatch, next }) => {
      if (!nested) {
        nested = true;
        dispatch({ type: 'increment' });
      }

      return next();
    }]);

    // Act: complete both updates without a queue or Promise.
    store.dispatch({ type: 'increment' });

    // Assert: both actions have already committed.
    expect(store.getSnapshot().value).toBe(2);
  });

  test('can stop an action before its reducer', () => {
    // Arrange: middleware does not call next.
    const store = arrange([({ action }) => action]);

    // Act: dispatch the intercepted action.
    store.dispatch({ type: 'increment' });

    // Assert: state is unchanged.
    expect(store.getSnapshot().value).toBe(0);
  });
});
