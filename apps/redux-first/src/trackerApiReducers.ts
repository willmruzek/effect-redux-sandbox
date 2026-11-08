import { receiveNormalizedTaskPage } from '@repo/project-tracker';

import { trackerApi } from './api';
import {
  createTrackerApiState,
  type TrackerApiState,
} from './trackerApiDefinition';

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

  onSuccess: (state, { requestId, result }) => {
    Object.assign(state, receiveNormalizedTaskPage(state, { requestId, page: result }));
  },

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

export function trackerApiReducer(
  state: TrackerApiState = createTrackerApiState(),
  action: { readonly type: string },
): TrackerApiState {
  return trackerApi.reducer(tasks(state, action), action);
}
