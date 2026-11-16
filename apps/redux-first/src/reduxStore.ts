import type {
  Dispatch,
  ThunkDispatch,
  UnknownAction
} from '@reduxjs/toolkit';
import {
  Context,
  type Effect
} from 'effect';

import type { RootState } from './reducer';
import type { TrackerApiStoreId } from './trackerApiStore';
import type { TrackerServices } from './trackerServices';

export type DispatchableEffect<A = unknown, E = unknown, R = never> = Effect.Effect<
  A,
  E,
  ReduxStore | TrackerApiStoreId | R
>;

export type EffectDispatch<R = never> = <A, E>(
  effect: DispatchableEffect<A, E, R>,
) => Promise<A>;

export type ReduxDispatch<R = never> = Dispatch<UnknownAction> &
  ThunkDispatch<RootState, undefined, UnknownAction> &
  EffectDispatch<R>;

export type StoreEffectDispatch = {
  <Action extends UnknownAction>(action: Action): Effect.Effect<Action>;
  <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, ReduxStore | TrackerApiStoreId>>;
};

export class ReduxStore extends Context.Service<
  ReduxStore,
  {
    readonly getState: Effect.Effect<RootState>;
    readonly dispatch: StoreEffectDispatch;
  } & TrackerServices
>()('@repo/redux-first/reduxStore/ReduxStore') { }
