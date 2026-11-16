import type {
  Dispatch,
  Middleware,
  UnknownAction
} from '@reduxjs/toolkit';
import {
  Context,
  Effect,
  type ManagedRuntime
} from 'effect';

import type { RootState } from './reducer';
import type { TrackerServices } from './trackerServices';
import {
  ReduxStore,
  type DispatchableEffect,
  type EffectDispatch,
  type StoreEffectDispatch
} from './reduxStore';
import { TrackerApiStore } from './trackerApiStore';

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
  services,
}: Readonly<{
  runtime: ManagedRuntime.ManagedRuntime<R, ER>;
  getDispatch: () => Dispatch<UnknownAction>;
  services: TrackerServices;
}>): Middleware<EffectDispatch<R>, RootState> {
  return (api) => {
    function dispatch<Action extends UnknownAction>(action: Action): Effect.Effect<Action>;

    function dispatch<A, E, Requirements>(
      program: Effect.Effect<A, E, Requirements>,
    ): Effect.Effect<A, E, Exclude<Requirements, ReduxStore | TrackerApiStore>>;

    function dispatch<A, E, Requirements>(
      input: UnknownAction | Effect.Effect<A, E, Requirements>,
    ): Effect.Effect<UnknownAction | A, E, Exclude<Requirements, ReduxStore | TrackerApiStore>> {
      return Effect.isEffect(input)
        ? provideStores(input)
        : Effect.sync(() => getDispatch()(input));
    }

    const service: ReduxStore['Service'] = Object.assign({}, services, {
      getState: Effect.sync(api.getState),
      dispatch: dispatch satisfies StoreEffectDispatch,
    });

    const apiStore: TrackerApiStore['Service'] = {
      getState: Effect.sync(api.getState),
      dispatch: (action) => Effect.sync(() => getDispatch()(action)),
    };

    function provideStores<A, E, Requirements>(
      program: Effect.Effect<A, E, Requirements>,
    ): Effect.Effect<A, E, Exclude<Requirements, ReduxStore | TrackerApiStore>> {
      const context = Context.merge(
        Context.make(ReduxStore, service),
        Context.make(TrackerApiStore, apiStore),
      );

      return Effect.provideContext(program, context);
    }

    return (next) => (action) => isDispatchableEffect<R>(action)
      ? runtime.runPromise(provideStores(action))
      : next(action);
  };
}
