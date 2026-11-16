import type {
  TaskDetailState,
  TrackerViewState,
} from '@repo/project-tracker';
import type {
  CursorPaginationState,
  InvalidationState,
  RequestApiState,
} from '@repo/redux-toolkit';

import type { TrackerTag } from './trackerApiTags';

export type TrackerApiState = TrackerViewState & {
  readonly api: RequestApiState;
  readonly detail: TaskDetailState;
  readonly invalidation: InvalidationState<TrackerTag>;
  readonly pagination: CursorPaginationState<string>;
};
