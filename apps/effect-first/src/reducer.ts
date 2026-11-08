import {
  createSlice,
  type PayloadAction,
  type SliceActions,
  type RequestActions
} from '@repo/effect-store-toolkit';
import {
  isLocalAction,
  reduceLocalData,
  type LocalAction,
  type TaskDetailReceived,
  type TaskDetailLoadFailed,
  type TaskStatus,
  type TrackerSourceMode
} from '@repo/project-tracker';

import {
  createTrackerApiState,
  trackerApi,
  type TrackerApiState
} from './api';
import {
  trackerOperations,
  operationActions
} from './trackerOperations';
import { trackerApiReducer } from './trackerApiReducers';
import { trackerOperationReducer } from './trackerOperationReducers';

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

export function rootReducer(input: Readonly<{
  state: RootState;
  action: StoreAction
}>): RootState {
  const readState = trackerApiReducer(input);
  const operationState = trackerOperationReducer({ state: readState, action: input.action });

  const next = tracker.reducer({ state: operationState, action: input.action });

  return isLocalAction(input.action) ? reduceLocalData(next, input.action) : next;
}

export const trackerActions = { ...tracker.actions, ...operationActions };

export type RootState = TrackerApiState;

export type StoreAction =
  | LocalAction
  | SliceActions<typeof trackerActions>
  | RequestActions<typeof trackerApi.operations>
  | RequestActions<typeof trackerOperations>;
