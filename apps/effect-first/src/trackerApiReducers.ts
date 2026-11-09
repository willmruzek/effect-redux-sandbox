import {
  receiveNormalizedTaskPage,
  type NormalizedTaskPage
} from '@repo/project-tracker';
import { variablesKey } from '@repo/gql-api';
import { createCursorPagination, type PaginationAction } from '@repo/effect-store-toolkit';

import { trackerApi } from './api';
import type { TrackerApiState } from './trackerApiDefinition';
import { taskPageTags, trackerInvalidation } from './trackerInvalidation';

const tasks = trackerApi.operations.tasks.reducer({
  onStarted: (state, { requestId, variables }) => {
    state.request = variables.mode === 'refresh'
      ? {
        status: 'refreshing',
        requestId,
        after: null,
        query: variables.query,
        sourceMode: variables.sourceMode
      }
      : {
        status: 'loading',
        requestId,
        after: variables.after,
        query: variables.query,
        sourceMode: variables.sourceMode
      };
  },

  // Pagination commits the page only after validating ownership and cursor.
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
  }
});

export const taskPagination = createCursorPagination<TrackerApiState, string, NormalizedTaskPage>()({
  name: 'trackerTasks',
  invalidation: {
    registry: trackerInvalidation,
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

    Object.assign(state, receiveNormalizedTaskPage(state, { requestId: state.request.requestId, page }));
  },
});

export function trackerApiReducer({ state, action }: Readonly<{
  state: TrackerApiState;
  action: { readonly type: string };
}>): TrackerApiState {
  const next = taskPagination.reducer(trackerApi.reducer(tasks(state, action), action), action);

  function isAbandoned(value: { readonly type: string }): value is Extract<
    PaginationAction<string, NormalizedTaskPage>, { readonly kind: 'abandoned' }
  > {
    return value.type === 'trackerTasks/pagination' && 'kind' in value && value.kind === 'abandoned';
  }

  if (
    isAbandoned(action) &&
    state.pagination.pending?.requestId === action.request.requestId &&
    (state.request.status === 'loading' || state.request.status === 'refreshing') &&
    variablesKey({ query: state.request.query, sourceMode: state.request.sourceMode }) === action.request.identity &&
    state.request.after === action.request.after
  ) {
    return { ...next, request: { status: state.pagination.exhausted ? 'complete' : 'idle' } };
  }

  return next;
}
