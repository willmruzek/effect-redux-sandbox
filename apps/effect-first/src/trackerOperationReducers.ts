import {
  createOptimisticFieldReducers,
  createSlice
} from '@repo/effect-store-toolkit';
import {
  remapTaskPreference,
  TaskFieldInput,
  TaskPriority,
  TaskStatus
} from '@repo/project-tracker';

import {
  createTrackerApiState,
  type TrackerApiState
} from './trackerApiDefinition';
import { trackerOperations } from './trackerOperations';

const tracker = createSlice({
  name: 'trackerOperations',
  initialState: createTrackerApiState,
  reducers: () => ({}),

  extraReducers: (builder) => {
    const peopleRequest = trackerOperations.peopleRequest.reducers({
      onStarted: (state, payload) => {
        if (state.sourceMode !== 'mixed')
          return;
        state.peopleRequest = { status: 'loading', requestId: payload.requestId };
      },

      onConfirmed: (state, _payload, people) => {
        for (const person of people) {
          if (state.personWrites[person.id]?.status !== 'saving')
            state.people[person.id] = person;
        }
        state.peopleRequest = { status: 'complete' };
      },

      onFailed: (state, payload) => {
        state.peopleRequest = { status: 'error', ...payload };
      }
    });

    builder.addCase(trackerOperations.peopleRequest.actions.started, peopleRequest.started);
    builder.addCase(trackerOperations.peopleRequest.actions.confirmed, peopleRequest.confirmed);
    builder.addCase(trackerOperations.peopleRequest.actions.failed, peopleRequest.failed);

    const taskDetailWrite = trackerOperations.taskDetailWrite.reducers({
      onStarted: (state, payload) => {
        const task = state.tasks[payload.taskId];

        if (
          !task ||
          state.deletions[payload.taskId]?.status === 'saving'
        )
          return;

        state.detailWrites[payload.taskId] = {
          status: 'saving',
          requestId: payload.requestId,
          original: { title: task.title, description: task.description ?? null },
        };
        task.title = payload.values.title;
        task.description = payload.values.description;
      },

      onConfirmed: (state, payload, saved) => {
        const previous = state.tasks[payload.taskId];

        if (previous)
          state.tasks[payload.taskId] = {
            ...saved,
            ...(state.statusWrites[payload.taskId]?.status === 'saving' ? { status: previous.status } : {}),
            ...(state.priorityWrites[payload.taskId]?.status === 'saving' ? { priority: previous.priority } : {}),
            ...(state.assigneeWrites[payload.taskId]?.status === 'saving' ? { assigneeId: previous.assigneeId } : {}),
          };

        delete state.detailWrites[payload.taskId];
      },

      onFailed: (state, payload, pending) => {
        const task = state.tasks[payload.taskId];

        if (!task)
          return;

        task.title = pending.original.title;
        task.description = pending.original.description;
        state.detailWrites[payload.taskId] = { status: 'error', error: payload.error };
      }
    });

    builder.addCase(trackerOperations.taskDetailWrite.actions.started, taskDetailWrite.started);
    builder.addCase(trackerOperations.taskDetailWrite.actions.confirmed, taskDetailWrite.confirmed);
    builder.addCase(trackerOperations.taskDetailWrite.actions.failed, taskDetailWrite.failed);

    const deletion = trackerOperations.deletion.reducers({
      onStarted: (state, payload) => {
        const task = state.tasks[payload.taskId];
        const previous = state.deletions[payload.taskId];

        if (
          !task ||
          task.id.startsWith('temp:') ||
          (previous && previous.status !== 'error') ||
          state.statusWrites[payload.taskId]?.status === 'saving' ||
          state.priorityWrites[payload.taskId]?.status === 'saving' ||
          state.assigneeWrites[payload.taskId]?.status === 'saving' ||
          state.detailWrites[payload.taskId]?.status === 'saving'
        )
          return;

        state.deletions[payload.taskId] = {
          status: 'saving',
          requestId: payload.requestId,
          title: task.title
        };
      },

      onConfirmed: (state, payload) => {
        delete state.tasks[payload.taskId];
        delete state.taskPreferences[payload.taskId];
        delete state.statusWrites[payload.taskId];
        delete state.priorityWrites[payload.taskId];
        delete state.assigneeWrites[payload.taskId];
        delete state.personWrites[payload.taskId];

        for (const [id, creation] of Object.entries(state.creations)) {
          if (creation.taskId === payload.taskId)
            delete state.creations[id];
        }

        state.result.ids = state.result.ids.filter((id) => id !== payload.taskId);
        delete state.deletions[payload.taskId];
      },

      onFailed: (state, payload, pending) => {
        state.deletions[payload.taskId] = {
          ...pending,
          status: 'error',
          error: payload.error
        };
      }
    });

    builder.addCase(trackerOperations.deletion.actions.started, deletion.started);
    builder.addCase(trackerOperations.deletion.actions.confirmed, deletion.confirmed);
    builder.addCase(trackerOperations.deletion.actions.failed, deletion.failed);

    const creation = trackerOperations.creation.reducers({
      onStarted: (state, payload) => {
        const previous = state.creations[payload.operationId];

        if (previous && previous.status !== 'error')
          return;

        state.tasks[payload.task.id] = payload.task;
        state.creations[payload.operationId] = {
          status: 'saving',
          taskId: payload.task.id,
          requestId: payload.requestId
        };
      },

      onConfirmed: (state, payload, saved, pending) => {
        delete state.tasks[pending.taskId];
        state.taskPreferences = {
          ...remapTaskPreference(state.taskPreferences, { from: pending.taskId, to: saved.id }),
        };

        const existing = state.tasks[saved.id];

        state.tasks[saved.id] = existing ?? saved;
        state.creations[payload.operationId] = { status: 'created', taskId: saved.id };
      },

      onFailed: (state, payload, pending) => {
        state.creations[payload.operationId] = {
          ...pending,
          status: 'error',
          error: payload.error
        };
      }
    });

    builder.addCase(trackerOperations.creation.actions.started, creation.started);
    builder.addCase(trackerOperations.creation.actions.confirmed, creation.confirmed);
    builder.addCase(trackerOperations.creation.actions.failed, creation.failed);

    const status = trackerOperations.status.reducers(
      createOptimisticFieldReducers<TrackerApiState, TaskFieldInput<TaskStatus>>()({
        field: 'status',
        value: (input) => input.value,
        canStart: (state, input) => state.deletions[input.taskId]?.status !== 'saving',

        select: (state, input) => {
          const entity = state.tasks[input.taskId];

          return entity ? {
            entity,
            writes: state.statusWrites,
            id: input.taskId,
          } : undefined;
        },
      }),
    );

    builder.addCase(trackerOperations.status.actions.started, status.started);
    builder.addCase(trackerOperations.status.actions.confirmed, status.confirmed);
    builder.addCase(trackerOperations.status.actions.failed, status.failed);

    const priority = trackerOperations.priority.reducers(
      createOptimisticFieldReducers<TrackerApiState, TaskFieldInput<TaskPriority>>()({
        field: 'priority',
        value: (input) => input.value,
        canStart: (state, input) => state.deletions[input.taskId]?.status !== 'saving',

        select: (state, input) => {
          const entity = state.tasks[input.taskId];

          return entity ? {
            entity,
            writes: state.priorityWrites,
            id: input.taskId,
          } : undefined;
        },
      }),
    );

    builder.addCase(trackerOperations.priority.actions.started, priority.started);
    builder.addCase(trackerOperations.priority.actions.confirmed, priority.confirmed);
    builder.addCase(trackerOperations.priority.actions.failed, priority.failed);

    const personName = trackerOperations.personName.reducers({
      onStarted: (state, payload) => {
        const person = state.people[payload.personId];

        if (
          !person ||
          state.sourceMode === 'graphql'
        )
          return;

        state.personWrites[payload.personId] = {
          status: 'saving',
          requestId: payload.requestId,
          original: person.name,
        };
        person.name = payload.name;
      },

      onConfirmed: (state, payload, person) => {
        state.people[payload.personId] = person;
        delete state.personWrites[payload.personId];
      },

      onFailed: (state, payload, pending) => {
        const person = state.people[payload.personId];

        if (!person)
          return;

        person.name = pending.original;
        state.personWrites[payload.personId] = { status: 'error', error: payload.error };
      }
    });

    builder.addCase(trackerOperations.personName.actions.started, personName.started);
    builder.addCase(trackerOperations.personName.actions.confirmed, personName.confirmed);
    builder.addCase(trackerOperations.personName.actions.failed, personName.failed);

    const assignee = trackerOperations.assignee.reducers(
      createOptimisticFieldReducers<TrackerApiState, TaskFieldInput<string | null>>()({
        field: 'assigneeId',
        value: (input) => input.value,
        canStart: (state, input) => state.deletions[input.taskId]?.status !== 'saving',

        select: (state, input) => {
          const entity = state.tasks[input.taskId];

          return entity ? {
            entity,
            writes: state.assigneeWrites,
            id: input.taskId,
          } : undefined;
        },
      }),
    );

    builder.addCase(trackerOperations.assignee.actions.started, assignee.started);
    builder.addCase(trackerOperations.assignee.actions.confirmed, assignee.confirmed);
    builder.addCase(trackerOperations.assignee.actions.failed, assignee.failed);
  },
});

export const trackerOperationReducer = tracker.reducer;
