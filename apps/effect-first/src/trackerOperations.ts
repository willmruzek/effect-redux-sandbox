import { createRequestLifecycle } from '@repo/effect-store-toolkit';
import type {
  TaskDeletionInput,
  TaskDetailWriteInput,
  TaskFieldInput,
  Person,
  TaskCreationInput,
  Task,
  TaskPriority,
  TaskStatus
} from '@repo/project-tracker';
import type { TrackerApiState } from './trackerApiDefinition';
import {
  taskTags,
  type createTrackerInvalidation,
} from './trackerInvalidation';

export const createTrackerOperations = (trackerInvalidation: ReturnType<typeof createTrackerInvalidation>) => ({
  peopleRequest: createRequestLifecycle<TrackerApiState, readonly Person[]>()('tracker/peopleRequest', {
    pending: (state) =>
      state.sourceMode === 'mixed' && state.peopleRequest.status === 'loading'
        ? state.peopleRequest : undefined
  }),

  taskDetailWrite: createRequestLifecycle<TrackerApiState, Task>()('tracker/taskDetailWrite', {
    invalidation: {
      registry: trackerInvalidation,
      tags: (input: TaskDetailWriteInput, result: Task) => [
        ...taskTags(input.taskId), { type: 'Task', id: result.id },
      ],
    },
    pending: (state, payload: TaskDetailWriteInput) => {
      const pending = state.detailWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

  deletion: createRequestLifecycle<TrackerApiState, string>()('tracker/deletion', {
    invalidation: {
      registry: trackerInvalidation,
      tags: (input: TaskDeletionInput) => taskTags(input.taskId),
    },
    pending: (state, payload: TaskDeletionInput) => {
      const pending = state.deletions[payload.taskId];

      return pending?.status === 'saving' ? pending : undefined;
    }
  }),

  creation: createRequestLifecycle<TrackerApiState, Task>()('tracker/creation', {
    invalidation: {
      registry: trackerInvalidation,
      tags: (input: TaskCreationInput, result: Task) => [
        ...taskTags(input.task.id), { type: 'Task', id: result.id },
      ],
    },
    pending: (state, payload: TaskCreationInput) => {
      const pending = state.creations[payload.operationId];

      return pending?.status === 'saving' ? pending : undefined;
    }
  }),

  status: createRequestLifecycle<TrackerApiState, TaskStatus>()('tracker/status', {
    invalidation: {
      registry: trackerInvalidation,
      tags: (input: TaskFieldInput<TaskStatus>) => taskTags(input.taskId),
    },
    pending: (state, payload: TaskFieldInput<TaskStatus>) => {
      const pending = state.statusWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

  priority: createRequestLifecycle<TrackerApiState, TaskPriority>()('tracker/priority', {
    invalidation: {
      registry: trackerInvalidation,
      tags: (input: TaskFieldInput<TaskPriority>) => taskTags(input.taskId),
    },
    pending: (state, payload: TaskFieldInput<TaskPriority>) => {
      const pending = state.priorityWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

});

export type TrackerOperations = ReturnType<typeof createTrackerOperations>;
