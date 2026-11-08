import {
  createStore,
  type Store
} from '@repo/effect-store';
import { createLoggerMiddleware } from '@repo/effect-store-logger';
import {
  createInitialState,
  type TrackerState
} from '@repo/project-tracker';

import { createTrackerApiState } from './api';
import { EffectStore } from './effectStore';
import {
  rootReducer,
  type RootState,
  type StoreAction
} from './reducer';

import type { ManagedRuntime } from 'effect';

export type AppStore<R = never> = Store<RootState, StoreAction, EffectStore, R>;

export function createAppStore<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  initialState: TrackerState = createInitialState(),
): AppStore<R> {
  return createStore({
    service: EffectStore,
    runtime,
    initialState: createTrackerApiState(initialState),
    reducer: rootReducer,
    middleware: import.meta.env.DEV
      ? [createLoggerMiddleware<RootState, StoreAction>()]
      : [],
  });
}
