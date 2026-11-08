import {
  Layer,
  ManagedRuntime,
} from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';

import {
  createEffectInventory,
  createReduxInventory,
  type Stock,
  type StockAction,
} from './core.js';
import {
  createEffectSliceInventory,
  createReduxSliceInventory,
} from './slices.js';

describe('core-only consumers', () => {
  test('Redux commits actions synchronously without toolkit helpers', () => {
    // Arrange: an inventory store uses only plain Redux.
    const store = createReduxInventory({ quantity: 2 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const action: StockAction = { type: 'stock/received', quantity: 3 };

    // Act: dispatch without awaiting any work.
    const result = store.dispatch(action);

    // Assert: state, notification and action return are immediately available.
    expect(result).toBe(action);
    expect(store.getState()).toEqual({ quantity: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expectTypeOf(store.getState()).toEqualTypeOf<Stock>();
    unsubscribe();
  });

  test('Effect core commits actions synchronously without toolkit helpers', async () => {
    // Arrange: the consumer owns its runtime and subscription.
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const { store } = createEffectInventory(runtime, { quantity: 2 });
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      const action: StockAction = { type: 'stock/received', quantity: 3 };

      // Act: ordinary actions do not enter the runtime.
      const result = store.dispatch(action);

      // Assert: snapshots and notifications are synchronous.
      expect(result).toBe(action);
      expect(store.getSnapshot()).toEqual({ quantity: 5 });
      expect(listener).toHaveBeenCalledTimes(1);
      expectTypeOf(store.getSnapshot()).toEqualTypeOf<Stock>();
      unsubscribe();
    } finally {
      await runtime.dispose();
    }
  });

  test('Effect core supplies the receiving store to a dispatched program', async () => {
    // Arrange: two independent stores share an application-owned runtime.
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const first = createEffectInventory(runtime, { quantity: 2 });
      const second = createEffectInventory(runtime, { quantity: 10 });

      // Act: execute a service-dependent workflow in only the first store.
      const result = first.store.dispatch(first.receive(3));

      // Assert: external dispatch is typed and the other store stays isolated.
      expectTypeOf(result).toEqualTypeOf<Promise<number>>();
      expect(await result).toBe(5);
      expect(second.store.getSnapshot()).toEqual({ quantity: 10 });
    } finally {
      await runtime.dispose();
    }
  });
});

describe('slice-only consumers', () => {
  test('Redux slices require no request API', () => {
    // Arrange: opt into official slice helpers only.
    const inventory = createReduxSliceInventory({ quantity: 2 });

    // Act: dispatch the inferred slice action.
    inventory.store.dispatch(inventory.actions.received(3));

    // Assert: no request metadata is needed.
    expect(inventory.store.getState()).toEqual({ quantity: 5 });
    expectTypeOf(inventory.actions.received(3).payload).toEqualTypeOf<number>();
  });

  test('Effect slices require no request API', async () => {
    // Arrange: compose an optional slice with the core store.
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const inventory = createEffectSliceInventory(runtime, { quantity: 2 });

      // Act: dispatch the inferred slice action.
      inventory.store.dispatch(inventory.actions.received(3));

      // Assert: only inventory data is stored.
      expect(inventory.store.getSnapshot()).toEqual({ quantity: 5 });
      expectTypeOf(inventory.actions.received(3).payload).toEqualTypeOf<number>();
    } finally {
      await runtime.dispose();
    }
  });
});
