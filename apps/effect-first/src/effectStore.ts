import type {
  DispatchableEffect as StoreEffect,
  StoreService,
} from '@repo/effect-store';

import { Context } from 'effect';

import type {
  RootState,
  StoreAction
} from './reducer';

export type DispatchableEffect<A = unknown, E = unknown> = StoreEffect<
  EffectStore,
  A,
  E
>;

export class EffectStore extends Context.Service<
  EffectStore,
  StoreService<RootState, StoreAction, EffectStore>
>()('@repo/effect-first/effectStore/EffectStore') { }
