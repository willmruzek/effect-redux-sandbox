import {
  requestedQuery,
  validateTaskDeletion,
  validateTaskEdit,
  type DeleteOptions,
  type DetailWriteOptions,
  type CreateOptions,
  type Task,
  type PersonNameInput,
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
  Effect
} from 'effect';

import { EffectStore } from './effectStore';
import { trackerActions } from './reducer';
import { trackerApi } from './api';
import { trackerOperations } from './trackerOperations';

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

export const loadMoreTasks = Effect.fn('loadMoreTasks')(function*(options: LoadOptions = {}) {
  const store = yield* EffectStore;
  const state = yield* store.getState;
  const { request } = state;

  if (!options.query && request.status === 'refresh-error')
    return yield* refreshTasks(options);

  if (
    !options.query &&
    (request.status === 'loading' ||
      request.status === 'refreshing' ||
      request.status === 'complete')
  )
    return;

  const query = { ...requestedQuery(state), ...options.query };

  query.search = query.search.trim().toLowerCase();

  const sourceMode = options.sourceMode ?? state.sourceMode;

  if (
    (request.status === 'loading' || request.status === 'refreshing') &&
    request.sourceMode === sourceMode &&
    JSON.stringify(query) === JSON.stringify(request.query)
  )
    return;

  const after = options.query ? null : request.status === 'error' ? request.after : state.result.pageInfo.endCursor;
  const fetchPage = options.fetchPage;

  yield* trackerApi.operations.tasks.run({
    variables: {
      mode: 'page',
      query,
      after,
      fail: options.fail ?? false,
      sourceMode
    },
    store,
    ...(fetchPage ? { execute: async (variables) => ({ page: await fetchPage(variables), loadedPages: 1 }) }
      : sourceMode === 'rest' ? {
        execute: async (variables, signal) => ({
          page: await fetchRestTrackerPage({
            endpoint: '/api',
            after: variables.after,
            query: variables.query,
            fail: variables.fail,
            signal,
          }),
          loadedPages: 1,
        }),
      } : {}),
  });
});

/** Refresh the current query from its first backend page. */
export const refreshTasks = Effect.fn('refreshTasks')(function*(options: RefreshOptions = {}) {
  const store = yield* EffectStore;
  const state = yield* store.getState;
  const query = requestedQuery(state);
  const fetchPage = options.fetchPage;
  const sourceMode = options.sourceMode ?? state.sourceMode;

  yield* trackerApi.operations.tasks.run({
    variables: {
      mode: 'refresh',
      query,
      after: null,
      fail: options.fail ?? false,
      sourceMode
    },
    store,
    ...(fetchPage ? {
      execute: async (variables) => ({
        page: await fetchPage({
          after: null,
          query: variables.query,
          fail: variables.fail
        }),
        loadedPages: 1,
      }),
    } : sourceMode === 'rest' ? {
      execute: async (variables, signal) => ({
        page: await fetchRestTrackerPage({
          endpoint: '/api',
          after: null,
          query: variables.query,
          fail: variables.fail,
          signal,
        }),
        loadedPages: 1,
      }),
    } : {}),
  });
});

export const loadPeople = Effect.fn('loadPeople')(function*() {
  const store = yield* EffectStore;

  if ((yield* store.getState).sourceMode !== 'mixed')
    return;
  yield* trackerOperations.peopleRequest.run({
    store: store,

    input: {},

    execute: async (signal) => fetchRestPeople({ endpoint: '/api', signal }),
  });
});

export const selectSourceMode = Effect.fn('selectSourceMode')(function*(sourceMode: TrackerSourceMode) {
  const store = yield* EffectStore;

  yield* store.dispatch(trackerActions.sourceModeSelected(sourceMode));

  const state = yield* store.getState;

  yield* loadMoreTasks({ query: requestedQuery(state), sourceMode });

  if (sourceMode === 'mixed' && (yield* store.getState).sourceMode === 'mixed')
    yield* loadPeople();
});

export const deleteTask = Effect.fn('deleteTask')(function*(options: DeleteOptions) {
  const store = yield* EffectStore;
  const state = yield* store.getState;
  const validation = validateTaskDeletion(state, options);

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const { task } = validation;

  const outcome = yield* trackerOperations.deletion.run({
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;
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
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;
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
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;

  const validation = validateTaskEdit(state, { field: 'status', taskId: options.taskId });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const outcome = yield* trackerOperations.status.run({
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;

  const validation = validateTaskEdit(state, { field: 'priority', taskId: options.taskId });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const outcome = yield* trackerOperations.priority.run({
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;
  const validation = validateTaskEdit(state, {
    field: 'assignee',
    taskId: options.taskId,
    value: options.value,
  });

  if (validation.status === 'invalid')
    return yield* Effect.fail(new Error(validation.error));

  const { task } = validation;

  const outcome = yield* trackerOperations.assignee.run({
    store: store,

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
  const store = yield* EffectStore;
  const state = yield* store.getState;

  if (state.sourceMode === 'graphql')
    return yield* Effect.fail(new Error('Person names are owned by REST in this example.'));

  if (!state.people[options.personId])
    return yield* Effect.fail(new Error(`Unknown person: ${options.personId}.`));

  if (!options.name.trim())
    return yield* Effect.fail(new Error('Person name cannot be empty.'));

  const name = options.name.trim();

  yield* trackerOperations.personName.run({
    store: store,

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
