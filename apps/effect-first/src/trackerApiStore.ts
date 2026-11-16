import { Context } from 'effect';

import type { Store } from '@repo/effect-store-toolkit';

import type { TrackerApiState } from './trackerApiState';

export class TrackerApiStore extends Context.Service<
  TrackerApiStore,
  Store<TrackerApiState, never>
>()('@repo/effect-first/trackerApiStore/TrackerApiStore') { }

export type TrackerApiStoreId = Context.Service.Identifier<typeof TrackerApiStore>;
