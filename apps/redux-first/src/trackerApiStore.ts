import type { UnknownAction } from '@reduxjs/toolkit';
import { Context } from 'effect';

import type { Store } from '@repo/redux-toolkit';

import type { TrackerApiState } from './trackerApiState';

export class TrackerApiStore extends Context.Service<
  TrackerApiStore,
  Store<TrackerApiState, UnknownAction>
>()('@repo/redux-first/trackerApiStore/TrackerApiStore') { }

export type TrackerApiStoreId = Context.Service.Identifier<typeof TrackerApiStore>;
