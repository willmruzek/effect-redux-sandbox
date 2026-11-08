import type {
  Dispatch,
  Middleware,
  UnknownAction
} from '@reduxjs/toolkit';
import {
  Effect,
  type ManagedRuntime
} from 'effect';

import type { RootState } from './reducer';
import {
  ReduxStore,
  type DispatchableEffect,
  type EffectDispatch,
  type StoreEffectDispatch
} from './reduxStore';

function isDispatchableEffect<R>(value: unknown): value is DispatchableEffect<unknown, unknown, R> {
  return Effect.isEffect(value);
}

/**
 * Only external dispatch enters the application runtime. Service dispatch stays
 * lazy and preserves the caller's dependencies, scopes and interruption.
 */
export function createEffectMiddleware<R, ER>({
  runtime,
  getDispatch,
}: Readonly<{
  runtime: ManagedRuntime.ManagedRuntime<R, ER>;
  getDispatch: () => Dispatch<UnknownAction>;
}>): Middleware<EffectDispatch<R>, RootState> {
  return (api) => {
    function dispatch<Action extends UnknownAction>(action: Action): Effect.Effect<Action>;

    function dispatch<A, E, Requirements>(
      program: Effect.Effect<A, E, Requirements>,
    ): Effect.Effect<A, E, Exclude<Requirements, ReduxStore>>;

    function dispatch<A, E, Requirements>(
      input: UnknownAction | Effect.Effect<A, E, Requirements>,
    ): Effect.Effect<UnknownAction | A, E, Exclude<Requirements, ReduxStore>> {
      return Effect.isEffect(input)
        ? Effect.provideService(input, ReduxStore, service)
        : Effect.sync(() => getDispatch()(input));
    }

    const service: ReduxStore['Service'] = {
      getState: Effect.sync(api.getState),
      dispatch: dispatch satisfies StoreEffectDispatch,
    };

    return (next) => (action) => isDispatchableEffect<R>(action)
      ? runtime.runPromise(Effect.provideService(action, ReduxStore, service))
      : next(action);
  };
}
