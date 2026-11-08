import {
  receiveNormalizedTaskPage,
  type NormalizedTaskPage
} from '@repo/project-tracker';
import { createCursorPagination } from '@repo/effect-store-toolkit';

import { trackerApi } from './api';
import type { TrackerApiState } from './trackerApiDefinition';

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
  return taskPagination.reducer(trackerApi.reducer(tasks(state, action), action), action);
}
