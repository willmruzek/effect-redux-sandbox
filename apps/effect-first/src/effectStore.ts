import type {
  DispatchableEffect as StoreEffect,
  StoreService,
} from '@repo/effect-store';

import { Context } from 'effect';

import type {
  RootState,
  StoreAction
} from './reducer';
import type { TrackerApiStoreId } from './trackerApiStore';
import type { TrackerServices } from './trackerServices';

export type DispatchableEffect<A = unknown, E = unknown> = StoreEffect<
  EffectStore | TrackerApiStoreId,
  A,
  E
>;

export class EffectStore extends Context.Service<
  EffectStore,
  StoreService<RootState, StoreAction, EffectStore, TrackerServices>
>()('@repo/effect-first/effectStore/EffectStore') { }
