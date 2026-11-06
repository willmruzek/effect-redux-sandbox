import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { counterActions, createAppStore, type AppDispatch } from './store';

describe('createAppStore', () => {
  test('runs a dispatched Effect and returns its success value', async () => {
    // Arrange: create a fresh store and a dependency-free Effect.
    const store = createAppStore();
    const effect = Effect.succeed('completed');

    // Act: dispatch the Effect and await the middleware result.
    const result = await store.dispatch(effect);

    // Assert: dispatch resolves with the Effect's successful value.
    expect(result).toBe('completed');
  });

  test('rejects when a dispatched Effect fails', async () => {
    // Arrange: create a fresh store and a failing Effect.
    const store = createAppStore();
    const effect = Effect.fail(new Error('effect failed'));

    // Act: dispatch the Effect.
    const result = store.dispatch(effect);

    // Assert: the Effect failure remains visible to the caller.
    await expect(result).rejects.toThrow('effect failed');
  });

  test('forwards ordinary actions to the reducer', () => {
    // Arrange: create a fresh store.
    const store = createAppStore();

    // Act: dispatch a normal Redux action.
    store.dispatch(counterActions.incremented());

    // Assert: the reducer updates the counter state.
    expect(store.getState().counter.value).toBe(1);
  });

  test('creates an independent store for each client app instance', () => {
    // Arrange: create two stores with independent state.
    const firstStore = createAppStore();
    const secondStore = createAppStore();

    // Act: update only the first store.
    firstStore.dispatch(counterActions.incremented());

    // Assert: the second store remains unchanged.
    expect(firstStore.getState().counter.value).toBe(1);
    expect(secondStore.getState().counter.value).toBe(0);
  });

  test('executes async Redux Thunks and returns their result', async () => {
    // Arrange: create a fresh store and a thunk action.
    const store = createAppStore();
    const incrementWithThunk = () => async (dispatch: AppDispatch) => {
      await Promise.resolve();
      dispatch(counterActions.incremented());
      return 'thunk completed';
    };

    // Act: dispatch and await the thunk.
    const result = await store.dispatch(incrementWithThunk());

    // Assert: the thunk returns its value and can dispatch Redux actions.
    expect(result).toBe('thunk completed');
    expect(store.getState().counter.value).toBe(1);
  });
});
