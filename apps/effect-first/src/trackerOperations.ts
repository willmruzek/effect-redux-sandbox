import { createRequestLifecycle } from '@repo/effect-store-toolkit';
import type {
  TaskDeletionInput,
  TaskDetailWriteInput,
  TaskFieldInput,
  Person,
  PersonNameInput,
  TaskCreationInput,
  Task,
  TaskPriority,
  TaskStatus
} from '@repo/project-tracker';
import type { TrackerApiState } from './trackerApiDefinition';

export const trackerOperations = {
  peopleRequest: createRequestLifecycle<TrackerApiState, readonly Person[]>()('tracker/peopleRequest', {
    pending: (state) =>
      state.sourceMode === 'mixed' && state.peopleRequest.status === 'loading'
        ? state.peopleRequest : undefined
  }),

  taskDetailWrite: createRequestLifecycle<TrackerApiState, Task>()('tracker/taskDetailWrite', {
    pending: (state, payload: TaskDetailWriteInput) => {
      const pending = state.detailWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

  deletion: createRequestLifecycle<TrackerApiState, string>()('tracker/deletion', {
    pending: (state, payload: TaskDeletionInput) => {
      const pending = state.deletions[payload.taskId];

      return pending?.status === 'saving' ? pending : undefined;
    }
  }),

  creation: createRequestLifecycle<TrackerApiState, Task>()('tracker/creation', {
    pending: (state, payload: TaskCreationInput) => {
      const pending = state.creations[payload.operationId];

      return pending?.status === 'saving' ? pending : undefined;
    }
  }),

  status: createRequestLifecycle<TrackerApiState, TaskStatus>()('tracker/status', {
    pending: (state, payload: TaskFieldInput<TaskStatus>) => {
      const pending = state.statusWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

  priority: createRequestLifecycle<TrackerApiState, TaskPriority>()('tracker/priority', {
    pending: (state, payload: TaskFieldInput<TaskPriority>) => {
      const pending = state.priorityWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),

  personName: createRequestLifecycle<TrackerApiState, Person>()('tracker/personName', {
    pending: (state, payload: PersonNameInput) => {
      const pending = state.personWrites[payload.personId];

      return pending?.status === 'saving' && state.people[payload.personId] ? pending : undefined;
    }
  }),

  assignee: createRequestLifecycle<TrackerApiState, string | null>()('tracker/assignee', {
    pending: (state, payload: TaskFieldInput<string | null>) => {
      const pending = state.assigneeWrites[payload.taskId];

      return pending?.status === 'saving' && state.tasks[payload.taskId] ? pending : undefined;
    }
  }),
};

export const operationActions = {
  taskDetailWriteStarted: trackerOperations.taskDetailWrite.actions.started,
  taskDetailWriteConfirmed: trackerOperations.taskDetailWrite.actions.confirmed,
  taskDetailWriteFailed: trackerOperations.taskDetailWrite.actions.failed,
  deletionStarted: trackerOperations.deletion.actions.started,
  deletionConfirmed: trackerOperations.deletion.actions.confirmed,
  deletionFailed: trackerOperations.deletion.actions.failed,
  creationStarted: trackerOperations.creation.actions.started,
  creationConfirmed: trackerOperations.creation.actions.confirmed,
  creationFailed: trackerOperations.creation.actions.failed,
  statusStarted: trackerOperations.status.actions.started,
  statusConfirmed: trackerOperations.status.actions.confirmed,
  statusFailed: trackerOperations.status.actions.failed,
  priorityStarted: trackerOperations.priority.actions.started,
  priorityConfirmed: trackerOperations.priority.actions.confirmed,
  priorityFailed: trackerOperations.priority.actions.failed,
  personNameStarted: trackerOperations.personName.actions.started,
  personNameConfirmed: trackerOperations.personName.actions.confirmed,
  personNameFailed: trackerOperations.personName.actions.failed,
  assigneeStarted: trackerOperations.assignee.actions.started,
  assigneeConfirmed: trackerOperations.assignee.actions.confirmed,
  assigneeFailed: trackerOperations.assignee.actions.failed,
};
