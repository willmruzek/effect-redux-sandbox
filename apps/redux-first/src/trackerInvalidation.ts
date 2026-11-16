import {
  createInvalidationRegistry,
  type InvalidationTag
} from '@repo/redux-toolkit';
import type { NormalizedTaskPage } from '@repo/project-tracker';

import type { TrackerApiState } from './trackerApiState';
import type { TrackerTag } from './trackerApiTags';

export type { TrackerTag } from './trackerApiTags';

export function createTrackerInvalidation() {
  return createInvalidationRegistry<TrackerApiState, TrackerTag>()({
    name: 'tracker',
    getState: (state) => state.invalidation,
    setState: (state, invalidation) => ({ ...state, invalidation }),
  });
}

export function taskTags(taskId: string): readonly InvalidationTag<TrackerTag>[] {
  return [{ type: 'TaskList' }, { type: 'Task', id: taskId }];
}

export function pageTags(
  taskIds: readonly string[],
  personIds: readonly string[],
): readonly InvalidationTag<TrackerTag>[] {
  return [
    { type: 'TaskList' },
    ...taskIds.map((id): InvalidationTag<TrackerTag> => ({ type: 'Task', id })),
    ...personIds.map((id): InvalidationTag<TrackerTag> => ({ type: 'Person', id })),
  ];
}

export function taskPageTags(page: NormalizedTaskPage): readonly InvalidationTag<TrackerTag>[] {
  const people = new Set(Object.keys(page.entities.people));

  for (const task of Object.values(page.entities.tasks)) {
    if (task.assigneeId)
      people.add(task.assigneeId);
  }

  return pageTags(page.ids, [...people]);
}
