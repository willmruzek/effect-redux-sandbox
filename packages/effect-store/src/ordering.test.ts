import {
  Context,
  Deferred,
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

import {
  createStore,
  type StoreService
} from './index.js';

type State = { readonly value: string };

type Action = {
  readonly type: 'append';
  readonly value: string
};

class Letters extends Context.Service<Letters, StoreService<State, Action, Letters>>()('ordering-test/Letters') { }

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange(reducer: (input: Readonly<{
  state: State;
  action: Action
}>) => State =
  ({ state, action }) => ({ value: state.value + action.value })) {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  return createStore({
    service: Letters,
    runtime,
    initialState: { value: '' },
    reducer
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('synchronous action ordering', () => {
  test('commits back-to-back actions in call order', () => {
    // Arrange: concatenation makes ordering observable.
    const store = arrange();

    // Act: dispatch without awaiting.
    store.dispatch({ type: 'append', value: 'A' });
    store.dispatch({ type: 'append', value: 'B' });

    // Assert: both commits are immediately visible.
    expect(store.getSnapshot().value).toBe('AB');
  });

  test('continues after a synchronous reducer defect', () => {
    // Arrange: only A throws.
    const error = new Error('A failed');
    const store = arrange(({ state, action }) => {
      if (action.value === 'A')
        throw error;

      return { value: state.value + action.value };
    });

    // Act: dispatch the invalid action, then a valid one.
    expect(() => store.dispatch({ type: 'append', value: 'A' })).toThrow(error);
    store.dispatch({ type: 'append', value: 'B' });

    // Assert: no queue or reducer lock remains poisoned.
    expect(store.getSnapshot().value).toBe('B');
  });

  test('does not block actions behind a pending Effect', async () => {
    // Arrange: pause workflow execution independently of state transitions.
    const gate = Effect.runSync(Deferred.make<void>());
    const store = arrange();
    const waiting = store.dispatch(Deferred.await(gate));

    // Act: dispatch synchronously while the workflow waits.
    store.dispatch({ type: 'append', value: 'B' });

    // Assert: the update is visible before the workflow completes.
    expect(store.getSnapshot().value).toBe('B');
    Effect.runSync(Deferred.succeed(gate, undefined));
    await waiting;
  });

  test('notifies subscribers before dispatch returns', () => {
    // Arrange: a subscriber reads the committed snapshot.
    const store = arrange();
    const listener = vi.fn(() => store.getSnapshot().value);
    const unsubscribe = store.subscribe(listener);

    // Act: dispatch one action.
    store.dispatch({ type: 'append', value: 'A' });

    // Assert: notification is synchronous and includes the new state.
    expect(listener.mock.results[0]?.value).toBe('A');
    unsubscribe();
  });
});
