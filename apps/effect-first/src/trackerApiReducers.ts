import {
  receiveNormalizedTaskPage,
  type NormalizedTaskPage
} from '@repo/project-tracker';
import { variablesKey } from '@repo/gql-api';
import {
  createCursorPagination,
  type PaginationAction,
} from '@repo/effect-store-toolkit';

import {
  type TrackerApiDefinitions,
  type TrackerApiState,
} from './trackerApiDefinition';
import {
  createTrackerInvalidation,
  taskPageTags,
} from './trackerInvalidation';

function createTaskHandlers(api: TrackerApiDefinitions['graphql'] | TrackerApiDefinitions['rest']) {
  return api.endpoints.tasks.reducer({
    onStarted: (state, { requestId, variables }) => {
      state.request = variables.mode === 'refresh'
        ? {
          status: 'refreshing',
          requestId,
          after: null,
          query: variables.query,
          sourceMode: variables.sourceMode,
        }
        : {
          status: 'loading',
          requestId,
          after: variables.after,
          query: variables.query,
          sourceMode: variables.sourceMode,
        };
    },

    onSuccess: () => {},

    onFailure: (state, { requestId, error }) => {
      if (
        (state.request.status !== 'loading' && state.request.status !== 'refreshing') ||
        state.request.requestId !== requestId
      )
        return;

      state.request = {
        status: state.request.status === 'refreshing' ? 'refresh-error' : 'error',
        after: state.request.after,
        query: state.request.query,
        sourceMode: state.request.sourceMode,
        error,
      };
    },
  });
}

function createAssigneeHandlers(api: TrackerApiDefinitions['graphql'] | TrackerApiDefinitions['rest']) {
  return api.endpoints.assignee.reducer({
    onStarted: (state, { requestId, variables }) => {
      const task = state.tasks[variables.id];

      if (task)
        state.assigneeWrites[variables.id] = {
          status: 'saving',
          requestId,
          original: task.assigneeId,
        };
    },

    onSuccess: (state, { requestId, variables }) => {
      const pending = state.assigneeWrites[variables.id];

      if (pending?.status === 'saving' && pending.requestId === requestId)
        delete state.assigneeWrites[variables.id];
    },

    onFailure: (state, { requestId, variables, error }) => {
      const pending = state.assigneeWrites[variables.id];

      if (pending?.status === 'saving' && pending.requestId === requestId)
        state.assigneeWrites[variables.id] = { status: 'error', error };
    },
  });
}

function createPersonNameHandlers(api: TrackerApiDefinitions['rest']) {
  return api.endpoints.renamePerson.reducer({
    onStarted: (state, { requestId, variables }) => {
      const person = state.people[variables.personId];

      if (person)
        state.personWrites[variables.personId] = {
          status: 'saving',
          requestId,
          original: person.name,
        };
    },

    onSuccess: (state, { requestId, variables }) => {
      const pending = state.personWrites[variables.personId];

      if (pending?.status === 'saving' && pending.requestId === requestId)
        delete state.personWrites[variables.personId];
    },

    onFailure: (state, { requestId, variables, error }) => {
      const pending = state.personWrites[variables.personId];

      if (pending?.status === 'saving' && pending.requestId === requestId)
        state.personWrites[variables.personId] = { status: 'error', error };
    },
  });
}

export function createTrackerApiReducers(input: Readonly<{
  apis: TrackerApiDefinitions;
  invalidation: ReturnType<typeof createTrackerInvalidation>;
}>) {
  const graphqlTasks = createTaskHandlers(input.apis.graphql);
  const restTasks = createTaskHandlers(input.apis.rest);
  const graphqlAssignee = createAssigneeHandlers(input.apis.graphql);
  const restAssignee = createAssigneeHandlers(input.apis.rest);
  const renamePerson = createPersonNameHandlers(input.apis.rest);

  const taskPagination = createCursorPagination<TrackerApiState, string, NormalizedTaskPage>()({
    name: 'trackerTasks',
    invalidation: {
      registry: input.invalidation,
      fromIdentity: () => [{ type: 'TaskList' }],
      fromPage: taskPageTags,
    },
    getState: (state) => state.pagination,
    setState: (state, pagination) => {
      state.pagination = pagination;
    },
    pageInfo: (page) => ({
      cursor: page.pageInfo.endCursor,
      hasNextPage: page.pageInfo.hasNextPage,
    }),
    merge: (state, page) => {
      if (state.request.status !== 'loading' && state.request.status !== 'refreshing')
        throw new Error('Cannot merge a page without an active tracker request.');

      Object.assign(state, receiveNormalizedTaskPage(state, {
        requestId: state.request.requestId,
        page,
      }));
    },
  });

  function reducer({ state, action }: Readonly<{
    state: TrackerApiState;
    action: { readonly type: string };
  }>): TrackerApiState {
    let next = graphqlTasks(state, action);
    next = restTasks(next, action);
    next = graphqlAssignee(next, action);
    next = restAssignee(next, action);
    next = renamePerson(next, action);
    next = input.apis.graphql.endpoints.tasks.optimisticReducer(next, action);
    next = input.apis.rest.endpoints.tasks.optimisticReducer(next, action);
    next = input.apis.graphql.endpoints.assignee.optimisticReducer(next, action);
    next = input.apis.rest.endpoints.assignee.optimisticReducer(next, action);
    next = input.apis.rest.endpoints.renamePerson.optimisticReducer(next, action);
    next = input.apis.graphql.reducer(next, action);
    next = input.apis.rest.reducer(next, action);
    next = taskPagination.reducer(next, action);

    function isAbandoned(value: { readonly type: string }): value is Extract<
      PaginationAction<string, NormalizedTaskPage>,
      { readonly kind: 'abandoned' }
    > {
      return value.type === 'trackerTasks/pagination' &&
        'kind' in value &&
        value.kind === 'abandoned';
    }

    if (
      isAbandoned(action) &&
      state.pagination.pending?.requestId === action.request.requestId &&
      (state.request.status === 'loading' || state.request.status === 'refreshing') &&
      variablesKey({ query: state.request.query, sourceMode: state.request.sourceMode }) === action.request.identity &&
      state.request.after === action.request.after
    ) {
      return {
        ...next,
        request: { status: state.pagination.exhausted ? 'complete' : 'idle' },
      };
    }

    return next;
  }

  return {
    reducer,
    taskPagination,
  };
}

export type TrackerApiReducers = ReturnType<typeof createTrackerApiReducers>;
