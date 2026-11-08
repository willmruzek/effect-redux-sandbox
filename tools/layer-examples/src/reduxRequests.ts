import {
  configureStore,
  createSlice,
} from '@reduxjs/toolkit';
import { Effect } from 'effect';

import {
  createEntityTable,
  createOptimisticFieldReducers,
  createRequestApi,
  createRequestLifecycle,
  type RequestActions,
} from '@repo/redux-toolkit';

import {
  decodeItem,
  initialInventory,
  quantityError,
  type InventoryState,
  type Item,
  type QuantityInput,
} from './inventory.js';

export function createReduxRequests({ registerWrites = true } = {}) {
  const items = createEntityTable({ name: 'inventory', key: (item: Item) => item.sku });
  const api = createRequestApi({
    name: 'inventory',
    endpoint: '/inventory',
    state: (state) => state.api,
    getState: (state: InventoryState) => state.api,

    operations: (builder) => ({
      item: builder.query('item', {
        document: 'query Item($sku: ID!) { item(sku: $sku) { sku label quantity } }',
        decode: decodeItem,
        normalize: (item) => items.normalize([item]),
        scope: () => 'item',
      }),
    }),
  });
  const write = createRequestLifecycle<InventoryState, number>()('inventory/quantity', {
    pending: (state, input: QuantityInput) => {
      const pending = state.writes[input.sku];

      return pending?.status === 'saving' ? pending : undefined;
    },
  });
  const read = api.operations.item.reducer({
    onSuccess: (state, { result }) => {
      state.items = items.merge({ current: state.items, incoming: result });
    },
  });
  const slice = createSlice({
    name: 'inventory',
    initialState: initialInventory,
    reducers: {},

    extraReducers: (builder) => {
      if (!registerWrites)
        return;

      const quantity = write.reducers(
        createOptimisticFieldReducers<InventoryState, QuantityInput>()({
          field: 'quantity',
          value: (input) => input.value,
          canStart: (state, input) => quantityError(state, input) === undefined,

          select: (state, input) => {
            const entity = state.items[input.sku];

            return entity ? { entity, writes: state.writes, id: input.sku } : undefined;
          },
        }),
      );

      builder.addCase(write.actions.started, quantity.started);
      builder.addCase(write.actions.confirmed, quantity.confirmed);
      builder.addCase(write.actions.failed, quantity.failed);
    },
  });
  const store = configureStore({
    reducer: (state: InventoryState = initialInventory(), action) =>
      slice.reducer(api.reducer(read(state, action), action), action),
  });
  type Action = RequestActions<typeof api.operations> | RequestActions<{ write: typeof write }>;

  const service = {
    getState: Effect.sync(store.getState),

    dispatch: (action: Action) => Effect.sync(() => store.dispatch(action)),
  };

  return {
    read: api.operations.item,
    write,
    service,
    snapshot: store.getState,
    dispose: async () => {},

    save: (input: QuantityInput, execute: (signal: AbortSignal) => Promise<number>) =>
      Effect.runPromise(Effect.gen(function*() {
        const error = quantityError(yield* service.getState, input);

        if (error)
          return yield* Effect.fail(new Error(error));

        return yield* write.run({ store: service, input, execute });
      })),
  };
}
