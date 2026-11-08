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
  fetchRestPeople,
  fetchRestPersonUpdate,
  fetchRestTaskCreate,
  fetchRestTaskDelete,
  fetchRestTaskUpdate,
  fetchRestTrackerPage
} from '@repo/tracker-graphql/rest-client';

import {
  Effect,
  type ManagedRuntime
} from 'effect';

import { createEffectMiddleware } from './effectMiddleware';
import {
  trackerActions,
  rootReducer
} from './reducer';
import {
  ReduxStore,
  type ReduxDispatch
} from './reduxStore';
import {
  createTrackerApiState,
  trackerApi
} from './api';
import { trackerOperations } from './trackerOperations';
import { taskPagination } from './trackerApiReducers';

export { trackerActions } from './reducer';

export type { RootState } from './reducer';

const makeAppStore = <R, ER>(runtime: ManagedRuntime.ManagedRuntime<R, ER>, initialState: TrackerState) => {
  const effectMiddleware = createEffectMiddleware({
    runtime,

    getDispatch: () => dispatch,
  });
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: createTrackerApiState(initialState),

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
) {
  return makeAppStore(runtime, initialState);
}

export const loadMoreTasks = Effect.fn('loadMoreTasks')(function*(options: LoadOptions = {}) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const query = { ...requestedQuery(state), ...options.query };

  query.search = query.search.trim().toLowerCase();

  const sourceMode = options.sourceMode ?? state.sourceMode;

  const fetchPage = options.fetchPage;

  yield* taskPagination.next({
    store: redux,
    identity: variablesKey({ query, sourceMode }),
    restart: Boolean(options.query),
    query: (after, request) => trackerApi.operations.tasks.runWithResult({
      variables: { mode: request.mode === 'refresh' ? 'refresh' : 'page', query, after, fail: options.fail ?? false, sourceMode },
      store: redux,
      ...(fetchPage ? { execute: async (variables) => ({
        page: await fetchPage(request.mode === 'refresh'
          ? { after: variables.after, query: variables.query, fail: variables.fail }
          : variables),
        loadedPages: 1,
      }) }
        : sourceMode === 'rest' ? {
          execute: async (variables, signal) => ({
            page: await fetchRestTrackerPage({ endpoint: '/api', after: variables.after, query: variables.query, fail: variables.fail, signal }),
            loadedPages: 1,
          }),
        } : {}),
    }),
  });
});

/** Refresh the current query from its first backend page. */
export const refreshTasks = Effect.fn('refreshTasks')(function*(options: RefreshOptions = {}) {
  const redux = yield* ReduxStore;
  const state = yield* redux.getState;
  const query = requestedQuery(state);
  const fetchPage = options.fetchPage;
  const sourceMode = options.sourceMode ?? state.sourceMode;

  yield* taskPagination.refresh({
    store: redux,
    identity: variablesKey({ query, sourceMode }),
    query: (after) => trackerApi.operations.tasks.runWithResult({
      variables: { mode: 'refresh', query, after, fail: options.fail ?? false, sourceMode },
      store: redux,
      ...(fetchPage ? {
        execute: async (variables) => ({
          page: await fetchPage({ after: variables.after, query: variables.query, fail: variables.fail }),
          loadedPages: 1,
        }),
      } : sourceMode === 'rest' ? {
        execute: async (variables, signal) => ({
          page: await fetchRestTrackerPage({ endpoint: '/api', after: variables.after, query: variables.query, fail: variables.fail, signal }),
          loadedPages: 1,
        }),
      } : {}),
    }),
  });
});

export const loadPeople = Effect.fn('loadPeople')(function*() {
  const redux = yield* ReduxStore;

  if ((yield* redux.getState).sourceMode !== 'mixed')
    return;
  yield* trackerOperations.peopleRequest.run({
    store: redux,

    input: {},

    execute: async (signal) => fetchRestPeople({ endpoint: '/api', signal }),
  });
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

  const outcome = yield* trackerOperations.deletion.run({
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

  const outcome = yield* trackerOperations.creation.run({
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

  const outcome = yield* trackerOperations.taskDetailWrite.run({
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

  const outcome = yield* trackerOperations.status.run({
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

  const outcome = yield* trackerOperations.priority.run({
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

  const outcome = yield* trackerOperations.assignee.run({
    store: redux,

    input: {
      taskId: task.id,
      value: options.value
    },

    execute: async (signal) => {
      const saved = await updateTask(state.sourceMode, {
        id: task.id,
        patch: { assigneeId: options.value },
        fail: options.fail ?? false,
        signal,
      });

      return saved.assigneeId;
    },
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

  yield* trackerOperations.personName.run({
    store: redux,

    input: {
      ...options,
      name
    },

    execute: async (signal) => {
      const saved = await fetchRestPersonUpdate({
        endpoint: '/api',
        id: options.personId,
        name,
        signal,
      });

      return saved;
    },
  });
});
