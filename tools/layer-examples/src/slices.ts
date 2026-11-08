import {
  configureStore,
  createSlice as createReduxSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';
import {
  Context,
  type ManagedRuntime,
} from 'effect';

import {
  createStore,
  type StoreService,
} from '@repo/effect-store';
import { createSlice } from '@repo/effect-store-toolkit';

import type { Stock } from './core.js';

export function createReduxSliceInventory(initial: Stock) {
  const slice = createReduxSlice({
    name: 'stock',
    initialState: initial,
    reducers: {
      received: (state, action: PayloadAction<number>) => {
        state.quantity += action.payload;
      },
    },
  });
  const store = configureStore({ reducer: slice.reducer });

  return { store, actions: slice.actions };
}

export function createEffectSliceInventory(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  initial: Stock,
) {
  const slice = createSlice({
    name: 'stock',
    initialState: initial,

    reducers: (builder) => ({
      received: builder.reducer('received', (state, action: { readonly payload: number }) => {
        state.quantity += action.payload;
      }),
    }),
  });
  type Action = ReturnType<typeof slice.actions.received>;

  class SliceStock extends Context.Service<
    SliceStock,
    StoreService<Stock, Action, SliceStock>
  >()('examples/SliceStock') {}

  const store = createStore({
    runtime,
    service: SliceStock,
    initialState: slice.getInitialState(),
    reducer: slice.reducer,
  });

  return { store, actions: slice.actions };
}
