import type { TrackerState } from '@repo/project-tracker';

import {
  createTrackerApiDefinitions,
  type TrackerApiTransportOptions,
} from './trackerApiDefinition';
import { createTrackerApiState } from './trackerApiDefinition';
import { createTrackerRootReducer } from './reducer';
import { createTrackerInvalidation } from './trackerInvalidation';
import { createTrackerOperations } from './trackerOperations';
import { createTrackerApiReducers } from './trackerApiReducers';
import { createTrackerOperationReducer } from './trackerOperationReducers';

export function createTrackerServices(options: TrackerApiTransportOptions = {}) {
  const invalidation = createTrackerInvalidation();
  const apis = createTrackerApiDefinitions({
    ...options,
    invalidation,
  });
  const operations = createTrackerOperations(invalidation);
  const apiReducers = createTrackerApiReducers({ apis, invalidation });
  const operationReducer = createTrackerOperationReducer(operations);
  const reducer = createTrackerRootReducer({
    invalidation,
    apiReducer: apiReducers.reducer,
    operationReducer,
  });

  return {
    apis,
    invalidation,
    operations,
    reducer,
    taskPagination: apiReducers.taskPagination,
    createInitialState: (state?: TrackerState) => createTrackerApiState(state, invalidation),
  };
}

export type TrackerServices = ReturnType<typeof createTrackerServices>;
