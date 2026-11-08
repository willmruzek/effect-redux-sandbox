import {
  Context,
  Effect,
  type ManagedRuntime,
} from 'effect';
import { createStore as createReduxStore } from 'redux';

import {
  createStore,
  type StoreService,
} from '@repo/effect-store';

export type Stock = { readonly quantity: number };

export type StockAction = {
  readonly type: 'stock/received';
  readonly quantity: number;
};

class StockStore extends Context.Service<
  StockStore,
  StoreService<Stock, StockAction, StockStore>
>()('examples/StockStore') {}

export function createReduxInventory(initial: Stock) {
  return createReduxStore((state: Stock = initial, action: StockAction): Stock =>
    action.type === 'stock/received'
      ? { quantity: state.quantity + action.quantity }
      : state,
  );
}

export function createEffectInventory(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  initial: Stock,
) {
  const store = createStore({
    runtime,
    service: StockStore,
    initialState: initial,

    reducer: ({ state, action }: Readonly<{ state: Stock; action: StockAction }>): Stock =>
      ({ quantity: state.quantity + action.quantity }),
  });

  const receive = Effect.fn('receiveStock')(function*(quantity: number) {
    const service = yield* StockStore;

    yield* service.dispatch({ type: 'stock/received', quantity });

    return (yield* service.getState).quantity;
  });

  return { store, receive };
}
