import {
  createSlice,
  type PayloadAction,
  type UnknownAction
} from '@reduxjs/toolkit';

import {
  type TaskDetailReceived,
  type TaskDetailLoadFailed,
  type TaskStatus,
  type TrackerSourceMode
} from '@repo/project-tracker';

import {
  createTrackerApiState,
  type TrackerApiState
} from './api';
import { operationActions } from './trackerOperations';
import { trackerApiReducer } from './trackerApiReducers';
import { trackerOperationReducer } from './trackerOperationReducers';

const tracker = createSlice({
  name: 'tracker',
  initialState: createTrackerApiState,
  reducers: {
    taskDetailRequested(state, { payload }: PayloadAction<string>) {
      state.detail = { status: 'loading', taskId: payload };
    },

    taskDetailReceived(state, { payload }: PayloadAction<TaskDetailReceived>) {
      if (payload.task === null) {
        state.detail = { status: 'not-found', taskId: payload.taskId };

        return;
      }

      const previous = state.tasks[payload.taskId];
      const incoming = payload.task;

      const keepTitle = previous && state.detailWrites[payload.taskId]?.status === 'saving';
      const keepStatus = previous && state.statusWrites[payload.taskId]?.status === 'saving';
      const keepPriority = previous && state.priorityWrites[payload.taskId]?.status === 'saving';
      const keepAssignee = previous && state.assigneeWrites[payload.taskId]?.status === 'saving';
      const keepDescription = previous &&
        (incoming.description === undefined ||
          state.detailWrites[payload.taskId]?.status === 'saving');

      state.tasks[payload.taskId] = {
        ...incoming,
        ...(keepTitle ? { title: previous.title } : {}),
        ...(keepStatus ? { status: previous.status } : {}),
        ...(keepPriority ? { priority: previous.priority } : {}),
        ...(keepAssignee ? { assigneeId: previous.assigneeId } : {}),
        ...(keepDescription ? { description: previous.description } : {}),
      };
      state.detail = { status: 'ready', taskId: payload.taskId };
    },

    taskDetailLoadFailed(state, { payload }: PayloadAction<TaskDetailLoadFailed>) {
      state.detail = {
        status: 'error',
        taskId: payload.taskId,
        error: payload.error
      };
    },

    taskDetailCleared(state, { payload }: PayloadAction<string>) {
      if (state.detail.status !== 'idle' && state.detail.taskId === payload)
        state.detail = { status: 'idle' };
    },

    deletionErrorDismissed(state, { payload }: PayloadAction<string>) {
      if (state.deletions[payload]?.status === 'error')
        delete state.deletions[payload];
    },

    creationDiscarded(state, { payload }: PayloadAction<string>) {
      const creation = state.creations[payload];

      if (!creation || creation.status === 'saving')
        return;

      if (creation.status === 'error')
        delete state.tasks[creation.taskId];

      delete state.creations[payload];
    },

    projectSelected(state, action: PayloadAction<string | null>) {
      state.selectedProjectId = action.payload;
    },

    statusSelected(state, action: PayloadAction<TaskStatus | 'all'>) {
      state.statusFilter = action.payload;
    },

    sourceModeSelected(state, action: PayloadAction<TrackerSourceMode>) {
      state.sourceMode = action.payload;
      state.peopleRequest = { status: 'idle' };
    },
  },
});

export function rootReducer(state: RootState | undefined, action: UnknownAction): RootState {
  const readState = trackerApiReducer(state, action);
  const operationState = trackerOperationReducer(readState, action);

  return tracker.reducer(operationState, action);
}

export const trackerActions = { ...tracker.actions, ...operationActions };

export type RootState = TrackerApiState;
