import {
  createStoreWithContext,
  type Store
} from '@repo/effect-store';
import { Context } from 'effect';
import { createLoggerMiddleware } from '@repo/effect-store-logger';
import {
  createInitialState,
  type TrackerState
} from '@repo/project-tracker';

import type { TrackerApiTransportOptions } from './trackerApiDefinition';
import { EffectStore } from './effectStore';
import { createTrackerServices } from './trackerServices';
import {
  TrackerApiStore,
  type TrackerApiStoreId
} from './trackerApiStore';
import {
  type RootState,
  type StoreAction
} from './reducer';

import type { ManagedRuntime } from 'effect';

export type AppStore<R = never> = Store<
  RootState,
  StoreAction,
  EffectStore | TrackerApiStoreId,
  R
>;

export function createAppStore<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  initialState: TrackerState = createInitialState(),
  transportOptions: TrackerApiTransportOptions = {},
): AppStore<R> {
  const services = createTrackerServices(transportOptions);
  return createStoreWithContext({
    service: EffectStore,
    context: (store) => Context.make(TrackerApiStore, store),
    services,
    runtime,
    initialState: services.createInitialState(initialState),
    reducer: services.reducer,
    middleware: import.meta.env.DEV
      ? [createLoggerMiddleware<RootState, StoreAction>()]
      : [],
  });
}
