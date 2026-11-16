import { configureStore } from '@reduxjs/toolkit';
import { variablesKey } from '@repo/gql-api';

import {
  createInitialState,
  requestedQuery,
  validateTaskDeletion,
  validateTaskEdit,
  type DeleteOptions,
  type DetailWriteOptions,
  type CreateOptions,
  type Task,
  type PersonNameInput,
  type TrackerState,
  type LoadOptions,
  type RefreshOptions,
  type TaskStatus,
  type TaskPriority,
  type WriteOptions,
  type TrackerSourceMode,
  type FieldWrite
} from '@repo/project-tracker';
import {
  fetchTaskDelete,
  fetchTaskCreate,
  fetchTaskUpdate
} from '@repo/tracker-graphql/client';
import {
  fetchRestTaskCreate,
  fetchRestTaskDelete,
  fetchRestTaskUpdate,
} from '@repo/tracker-graphql/rest-client';

import {
  Effect,
  type ManagedRuntime
} from 'effect';

import { createEffectMiddleware } from './effectMiddleware';
import type { TrackerApiTransportOptions } from './trackerApiDefinition';
import {
  trackerActions
} from './reducer';
import {
  ReduxStore,
  type ReduxDispatch
} from './reduxStore';
import {
  createTrackerServices
} from './trackerServices';

export { trackerActions } from './reducer';

export type { RootState } from './reducer';

const makeAppStore = <R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  initialState: TrackerState,
  transportOptions: TrackerApiTransportOptions,
) => {
  const services = createTrackerServices(transportOptions);
  const effectMiddleware = createEffectMiddleware({
    runtime,
    services,

    getDispatch: () => dispatch,
  });
  const store = configureStore({
    reducer: services.reducer,
    preloadedState: services.createInitialState(initialState),

    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(effectMiddleware),
  });
  const dispatch: ReduxDispatch<R> = store.dispatch;

  return store;
};

function updateTask(
  sourceMode: TrackerSourceMode,
  input: Readonly<{
    id: string;
    patch: Partial<Omit<Task, 'id'>>;
    fail: boolean;
    signal: AbortSignal;
  }>
): Promise<Task> {
  return sourceMode === 'rest'
    ? fetchRestTaskUpdate({
      endpoint: '/api',
      ...input,
      delayMs: 700
    })
    : fetchTaskUpdate({
      endpoint: '/graphql',
      ...input,
      delayMs: 700
    });
}

export type AppStore = ReturnType<typeof makeAppStore<never, never>>;

export type AppDispatch = AppStore['dispatch'];

export function createAppStore<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
  initialState: TrackerState = createInitialState(),
  transportOptions: TrackerApiTransportOptions = {},
) {
  return makeAppStore(runtime, initialState, transportOptions);
}

export const loadMoreTasks = Effect.fn('loadMoreTasks')(function*(options: LoadOptions = {}) {
  const services = yield* ReduxStore;
  const state = yield* services.getState;
  const query = { ...requestedQuery(state), ...options.query };

  query.search = query.search.trim().toLowerCase();

  const sourceMode = options.sourceMode ?? state.sourceMode;

  const api = sourceMode === 'rest' ? services.apis.rest : services.apis.graphql;

  yield* services.taskPagination.next({
    store: services,
    identity: variablesKey({ query, sourceMode }),
    restart: Boolean(options.query),
    query: (after, request) => api.endpoints.tasks.initiate({
        mode: request.mode === 'refresh' ? 'refresh' : 'page',
        query,
        after,
        fail: options.fail ?? false,
        sourceMode,
      }, {
        fence: { identity: services.taskPagination.key(request.identity), requestId: request.requestId },
      }),
  });
});

/** Refresh the current query from its first backend page. */
export const refreshTasks = Effect.fn('refreshTasks')(function*(options: RefreshOptions = {}) {
  const services = yield* ReduxStore;
  const state = yield* services.getState;
  const query = requestedQuery(state);
  const sourceMode = options.sourceMode ?? state.sourceMode;
  const api = sourceMode === 'rest' ? services.apis.rest : services.apis.graphql;

  yield* services.taskPagination.refresh({
    store: services,
    identity: variablesKey({ query, sourceMode }),
    query: (after, request) => api.endpoints.tasks.initiate({
        mode: 'refresh',
        query,
        after,
        fail: options.fail ?? false,
        sourceMode,
      }, {
        fence: {
          identity: services.taskPagination.key(request.identity),
          requestId: request.requestId,
        },
      }),
  });
});

export const loadPeople = Effect.fn('loadPeople')(function*() {
  const services = yield* ReduxStore;

  if ((yield* services.getState).sourceMode !== 'mixed')
    return;
  yield* services.apis.rest.endpoints.people.initiate({});
});

export const selectSourceMode = Effect.fn('selectSourceMode')(function*(sourceMode: TrackerSourceMode) {
  const redux = yield* ReduxStore;

  yield* redux.dispatch(trackerActions.sourceModeSelected(sourceMode));

  const state = yield* redux.getState;

  yield* loadMoreTasks({ query: requestedQuery(state), sourceMode });

  if (sourceMode === 'mixed' && (yield* redux.getState).sourceMode === 'mixed')
    yield* loadPeople();
});

export const deleteTask = Effect.fn('deleteTask')(function*(options: DeleteOptions) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const validation = validateTaskDeletion(state, options);

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const { task } = validation;

  const outcome = yield* redux.operations.deletion.run({
    store: redux,

    input: {
      taskId: task.id
    },

    execute: async (signal) => {
      const saved = await (state.sourceMode === 'rest'
        ? fetchRestTaskDelete({
          endpoint: '/api',
          id: task.id,
          fail: options.fail ?? false,
          delayMs: 700,
          signal
        })
        : fetchTaskDelete({
          endpoint: '/graphql',
          id: task.id,
          fail: options.fail ?? false,
          delayMs: 700,
          signal
        }));

      return saved;
    },
  });

  if (outcome.status === 'succeeded') {
    yield* refreshTasks();
  }
});

export const createTask = Effect.fn('createTask')(function*(options: CreateOptions) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const operationId = options.kind === 'new' ? yield* Effect.sync(() => crypto.randomUUID()) : options.operationId;
  let task: Task;

  if (options.kind === 'retry') {
    const creation = state.creations[operationId];

    if (creation?.status !== 'error')
      return yield* Effect.fail(new Error('Only failed creations can be retried.'));

    const existing = state.tasks[creation.taskId];

    if (!existing)
      return yield* Effect.fail(new Error('Missing retained creation draft.'));

    task = existing;
  } else {
    task = { ...options.input, id: `temp:${operationId}` };
  }

  const outcome = yield* redux.operations.creation.run({
    store: redux,

    input: {
      operationId,
      task
    },

    execute: async (signal) => {
      const saved = await (state.sourceMode === 'rest'
        ? fetchRestTaskCreate({
          endpoint: '/api',
          operationId,
          input: {
            title: task.title,
            status: task.status,
            priority: task.priority,
            projectId: task.projectId,
            assigneeId: task.assigneeId
          },
          fail: options.fail ?? false,
          delayMs: 700,
          signal,
        })
        : fetchTaskCreate({
          endpoint: '/graphql',
          operationId,
          input: {
            title: task.title,
            status: task.status,
            priority: task.priority,
            projectId: task.projectId,
            assigneeId: task.assigneeId
          },
          fail: options.fail ?? false,
          delayMs: 700,
          signal,
        }));

      return saved;
    },
  });

  if (outcome.status === 'succeeded') {
    yield* refreshTasks();
  }
});

export const saveTaskDetails = Effect.fn('saveTaskDetails')(function*(options: DetailWriteOptions) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const validation = validateTaskEdit(state, { field: 'detail', taskId: options.taskId });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const { task } = validation;

  const values = {
    title: options.values.title,
    description: options.values.description?.trim() || null,
  };
  const patch = {
    ...(values.title !== task.title ? { title: values.title } : {}),
    ...(values.description !== (task.description ?? null) ? { description: values.description } : {}),
  };

  if (!Object.keys(patch).length)
    return;

  const sourceMode = options.sourceMode ?? state.sourceMode;

  const outcome = yield* redux.operations.taskDetailWrite.run({
    store: redux,

    input: {
      taskId: task.id,
      values
    },

    execute: async (signal) => {
      const saved = await updateTask(sourceMode, {
        id: task.id,
        patch,
        fail: options.fail ?? false,
        signal,
      });

      return saved;
    },
  });

  if (outcome.status === 'succeeded') {
    yield* refreshTasks({ sourceMode });
  }
});

export const saveStatus = Effect.fn('saveStatus')(function*(options: WriteOptions<TaskStatus>) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;

  const validation = validateTaskEdit(state, { field: 'status', taskId: options.taskId });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const outcome = yield* redux.operations.status.run({
    store: redux,

    input: {
      taskId: options.taskId,
      value: options.value
    },

    execute: async (signal) => {
      if (options.persist) {
        const saved = await options.persist({
          taskId: options.taskId,
          value: options.value,
          fail: options.fail ?? false
        });

        return saved.value;
      }

      const task = await updateTask(state.sourceMode, {
        id: options.taskId,
        patch: { status: options.value },
        fail: options.fail ?? false,
        signal,
      });

      return task.status;
    },
  });

  if (outcome.status === 'succeeded') {
    if (!options.persist)
      yield* refreshTasks();
  }
});

export const savePriority = Effect.fn('savePriority')(function*(options: WriteOptions<TaskPriority>) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;

  const validation = validateTaskEdit(state, { field: 'priority', taskId: options.taskId });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const outcome = yield* redux.operations.priority.run({
    store: redux,

    input: {
      taskId: options.taskId,
      value: options.value
    },

    execute: async (signal) => {
      if (options.persist) {
        const saved = await options.persist({
          taskId: options.taskId,
          value: options.value,
          fail: options.fail ?? false
        });

        return saved.value;
      }

      const task = await updateTask(state.sourceMode, {
        id: options.taskId,
        patch: { priority: options.value },
        fail: options.fail ?? false,
        signal,
      });

      return task.priority;
    },
  });

  if (outcome.status === 'succeeded') {
    if (!options.persist)
      yield* refreshTasks();
  }
});

export const saveAssignee = Effect.fn('saveAssignee')(function*(options: FieldWrite<string | null>) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const validation = validateTaskEdit(state, {
    field: 'assignee',
    taskId: options.taskId,
    value: options.value,
  });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const { task } = validation;

  const api = state.sourceMode === 'rest' ? redux.apis.rest : redux.apis.graphql;
  const outcome = yield* api.endpoints.assignee.initiate({
      id: task.id,
      patch: { assigneeId: options.value },
      fail: options.fail ?? false,
      delayMs: 700,
      sourceMode: state.sourceMode,
  });

  if (outcome.status === 'succeeded') {
    yield* refreshTasks();
  }
});

export const renamePerson = Effect.fn('renamePerson')(function*(options: PersonNameInput) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;

  if (state.sourceMode === 'graphql')
    return yield* Effect.fail(new Error('Person names are owned by REST in this example.'));

  if (!state.people[options.personId])
    return yield* Effect.fail(new Error(`Unknown person: ${options.personId}.`));

  if (!options.name.trim())
    return yield* Effect.fail(new Error('Person name cannot be empty.'));

  const name = options.name.trim();

  yield* redux.apis.rest.endpoints.renamePerson.initiate({
    personId: options.personId,
    name,
  });
});
