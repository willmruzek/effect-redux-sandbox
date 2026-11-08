import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
} from 'effect';

import {
  createStore,
  type StoreService,
} from '@repo/effect-store';
import {
  createEntityTable,
  createOptimisticFieldReducers,
  createRequestApi,
  createRequestLifecycle,
  createSlice,
  type RequestActions,
} from '@repo/effect-store-toolkit';

import {
  decodeItem,
  initialInventory,
  quantityError,
  type InventoryState,
  type Item,
  type QuantityInput,
} from './inventory.js';

export function createEffectRequests({ registerWrites = true } = {}) {
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
    reducers: () => ({}),

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
  type Action = RequestActions<typeof api.operations> | RequestActions<{ write: typeof write }>;

  class InventoryStore extends Context.Service<
    InventoryStore,
    StoreService<InventoryState, Action, InventoryStore>
  >()('examples/InventoryStore') {}

  const runtime = ManagedRuntime.make(Layer.empty);
  const store = createStore({
    runtime,
    service: InventoryStore,
    initialState: slice.getInitialState(),
    reducer: ({ state, action }) =>
      slice.reducer({ state: api.reducer(read(state, action), action), action }),
  });
  const service = {
    getState: Effect.sync(store.getSnapshot),
    dispatch: (action: Action) => Effect.sync(() => store.dispatch(action)),
  };
  const save = Effect.fn('saveQuantity')(function*(
    input: QuantityInput,
    execute: (signal: AbortSignal) => Promise<number>,
  ) {
    const service = yield* InventoryStore;
    const error = quantityError(yield* service.getState, input);

    if (error)
      return yield* Effect.fail(new Error(error));

    return yield* write.run({ store: service, input, execute });
  });

  return {
    read: api.operations.item,
    write,
    service,
    snapshot: store.getSnapshot,
    dispose: () => runtime.dispose(),
    save: (input: QuantityInput, execute: (signal: AbortSignal) => Promise<number>) =>
      store.dispatch(save(input, execute)),
  };
}
