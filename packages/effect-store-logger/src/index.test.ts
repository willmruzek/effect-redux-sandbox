import {
  createStore,
  type StoreService
} from '@repo/effect-store';

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
  test,
  vi
} from 'vitest';

import { createLoggerMiddleware } from './index.js';

type State = { readonly value: number };

type Action = { readonly type: 'increment' };

class Counter extends Context.Service<Counter, StoreService<State, Action, Counter>>()('logger-test/Counter') { }

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange(reducer: (input: Readonly<{
  state: State;
  action: Action
}>) => State =
  ({ state }) => ({ value: state.value + 1 })) {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => { });
  const log = vi.spyOn(console, 'log').mockImplementation(() => { });
  const end = vi.spyOn(console, 'groupEnd').mockImplementation(() => { });
  const store = createStore({
    service: Counter,
    runtime,
    initialState: { value: 0 },
    reducer,
    middleware: [createLoggerMiddleware<State, Action>()],
  });

  return {
    store,
    group,
    log,
    end
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

describe('plain-action logger', () => {
  test('logs before and after state synchronously', () => {
    // Arrange: observe console groups.
    const {
      store,
      group,
      log,
      end
    } = arrange();

    // Act: dispatch without awaiting.
    const result = store.dispatch({ type: 'increment' });

    // Assert: logging is complete and preserves the action.
    expect(result).toEqual({ type: 'increment' });
    expect(group).toHaveBeenCalledWith(
      expect.stringContaining('increment'),
      expect.any(String)
    );
    expect(log).toHaveBeenCalledWith('%cprev state', expect.any(String), { value: 0 });
    expect(log).toHaveBeenCalledWith(
      '%cinput',
      expect.any(String),
      { type: 'increment' }
    );
    expect(log).toHaveBeenCalledWith('%cnext state', expect.any(String), { value: 1 });
    expect(end).toHaveBeenCalledTimes(1);
  });

  test('does not log Effect programs', async () => {
    // Arrange: a workflow without actions.
    const { store, group } = arrange();

    // Act: execute the workflow.
    const result = await store.dispatch(Effect.succeed(42));

    // Assert: its result is preserved without a store log entry.
    expect(result).toBe(42);
    expect(group).not.toHaveBeenCalled();
  });

  test('does not log unhandled Effect failures', async () => {
    // Arrange: a failing workflow without actions.
    const { store, group } = arrange();
    const error = new Error('workflow failed');

    // Act: dispatch the workflow.
    const result = store.dispatch(Effect.fail(error));

    // Assert: the rejection is not converted into a log action.
    await expect(result).rejects.toBe(error);
    expect(group).not.toHaveBeenCalled();
  });

  test('logs only nested plain actions', async () => {
    // Arrange: an outer workflow composes a child that dispatches one action.
    const {
      store,
      group,
      end
    } = arrange();
    const child = Effect.gen(function*() {
      const store = yield* Counter;

      yield* store.dispatch({ type: 'increment' });
    });
    const parent = Effect.gen(function*() {
      const store = yield* Counter;

      yield* store.dispatch(child);
    });

    // Act: execute the nested workflow.
    await store.dispatch(parent);

    // Assert: neither parent nor child becomes a log entry.
    expect(group).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test('logs reducer defects and rethrows synchronously', () => {
    // Arrange: the action reducer throws a known error.
    const error = new Error('reducer defect');
    const {
      store,
      log,
      end
    } = arrange(() => {
      throw error;
    });

    // Act: dispatch the action.
    expect(() => store.dispatch({ type: 'increment' })).toThrow(error);

    // Assert: failure is visible and its group is closed.
    expect(log).toHaveBeenCalledWith('%cfailure', expect.any(String), error);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
