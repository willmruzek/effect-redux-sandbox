import {
  createSlice,
  type PayloadAction,
  type SliceActions,
  type RequestActions,
  type InvalidationAction,
  type PaginationAction
} from '@repo/effect-store-toolkit';
import {
  isLocalAction,
  reduceLocalData,
  type LocalAction,
  type TaskDetailReceived,
  type TaskDetailLoadFailed,
  type TaskStatus,
  type TrackerSourceMode,
  type NormalizedTaskPage
} from '@repo/project-tracker';

import {
  createTrackerApiState,
  type TrackerApiState
} from './api';
import type { TrackerApiDefinitions } from './trackerApiDefinition';
import type { TrackerOperations } from './trackerOperations';
import type { TrackerApiReducers } from './trackerApiReducers';
import { createTrackerOperationReducer } from './trackerOperationReducers';
import { createTrackerInvalidation, type TrackerTag } from './trackerInvalidation';

const tracker = createSlice({
  name: 'tracker',
  initialState: createTrackerApiState,

  reducers: (slice) => ({
    taskDetailRequested: slice.reducer('taskDetailRequested', (state, { payload }: PayloadAction<string>) => {
      state.detail = { status: 'loading', taskId: payload };
    }),

    taskDetailReceived: slice.reducer(
      'taskDetailReceived',
      (state, { payload }: PayloadAction<TaskDetailReceived>) => {
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
      }
    ),

    taskDetailLoadFailed: slice.reducer(
      'taskDetailLoadFailed',
      (state, { payload }: PayloadAction<TaskDetailLoadFailed>) => {
        state.detail = {
          status: 'error',
          taskId: payload.taskId,
          error: payload.error
        };
      }
    ),

    taskDetailCleared: slice.reducer('taskDetailCleared', (state, { payload }: PayloadAction<string>) => {
      if (state.detail.status !== 'idle' && state.detail.taskId === payload)
        state.detail = { status: 'idle' };
    }),

    deletionErrorDismissed: slice.reducer(
      'deletionErrorDismissed',
      (state, { payload }: PayloadAction<string>) => {
        if (state.deletions[payload]?.status === 'error')
          delete state.deletions[payload];
      }
    ),

    creationDiscarded: slice.reducer('creationDiscarded', (state, { payload }: PayloadAction<string>) => {
      const creation = state.creations[payload];

      if (!creation || creation.status === 'saving')
        return;

      if (creation.status === 'error') {
        delete state.tasks[creation.taskId];
        delete state.taskPreferences[creation.taskId];
      }

      delete state.creations[payload];
    }),

    projectSelected: slice.reducer('projectSelected', (state, action: PayloadAction<string | null>) => {
      state.selectedProjectId = action.payload;
    }),

    statusSelected: slice.reducer(
      'statusSelected',
      (state, action: PayloadAction<TaskStatus | 'all'>) => {
        state.statusFilter = action.payload;
      }
    ),

    sourceModeSelected: slice.reducer(
      'sourceModeSelected',
      (state, action: PayloadAction<TrackerSourceMode>) => {
        state.sourceMode = action.payload;
        state.peopleRequest = { status: 'idle' };
      }
    ),
  }),
});

export function createTrackerRootReducer(input: Readonly<{
  invalidation: ReturnType<typeof createTrackerInvalidation>;
  apiReducer: TrackerApiReducers['reducer'];
  operationReducer: ReturnType<typeof createTrackerOperationReducer>;
}>) {
  return (actionInput: Readonly<{
    state: RootState;
    action: StoreAction;
  }>): RootState => {
    const invalidationState = input.invalidation.reducer(actionInput.state, actionInput.action);
    const readState = input.apiReducer({ state: invalidationState, action: actionInput.action });
    const operationState = input.operationReducer({ state: readState, action: actionInput.action });
    const next = tracker.reducer({ state: operationState, action: actionInput.action });

    return isLocalAction(actionInput.action) ? reduceLocalData(next, actionInput.action) : next;
  };
}

export const trackerActions = tracker.actions;

export type RootState = TrackerApiState;

export type StoreAction =
  | LocalAction
  | InvalidationAction<TrackerTag>
  | PaginationAction<string, NormalizedTaskPage>
  | SliceActions<typeof trackerActions>
  | RequestActions<TrackerApiDefinitions['graphql']['endpoints']>
  | RequestActions<TrackerApiDefinitions['rest']['endpoints']>
  | RequestActions<TrackerOperations>;
