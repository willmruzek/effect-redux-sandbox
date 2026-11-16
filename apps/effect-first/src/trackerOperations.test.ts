import {
  expect,
  expectTypeOf,
  test
} from 'vitest';

import type {
  TaskCreationInput,
  TaskDeletionInput,
  TaskDetailWriteInput,
  TaskFieldInput,
  TaskPriority,
  TaskStatus
} from '@repo/project-tracker';

import { createTrackerOperations } from './trackerOperations';
import { createTrackerInvalidation } from './trackerInvalidation';
import { createTrackerOperationReducer } from './trackerOperationReducers';
import type { TrackerApiState } from './trackerApiDefinition';

function initialState(): TrackerApiState {
  return {
    projects: {},
    people: {},
    tasks: {
      a: { id: 'a', title: 'Task', projectId: 'p', assigneeId: null, status: 'todo', priority: 'low' },
    },
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: 'idle' },
    result: {
      query: { projectId: null, status: 'all', search: '', assigneeId: '', sort: 'id' },
      ids: ['a'],
      loadedPages: 0,
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: 1,
      statusCounts: [],
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
    taskPreferences: {},
    scratchNotes: {},
    sourceMode: 'graphql',
    peopleRequest: { status: 'idle' },
    creations: {},
    deletions: {},
    detail: { status: 'idle' },
    api: { requests: {}, latest: {} },
    invalidation: { revision: 0, queries: {}, history: [] },
    pagination: { identity: '', cursor: null, exhausted: true, pending: null, error: null },
  };
}

test('tracker operation reducer uses its supplied store-specific operations', () => {
  // Arrange: construct operations and a reducer from the same registry.
  const operations = createTrackerOperations(createTrackerInvalidation());
  const reducer = createTrackerOperationReducer(operations);
  const state = initialState();

  // Act: publish an optimistic status start.
  const next = reducer({
    state,
    action: operations.status.actions.started({ taskId: 'a', value: 'done', requestId: 'one' }),
  });

  // Assert: the reducer applies the supplied operation without changing the prior snapshot.
  expect(next.tasks.a?.status).toBe('done');
  expect(next.statusWrites.a).toMatchObject({ status: 'saving', requestId: 'one', original: 'todo' });
  expect(state.tasks.a?.status).toBe('todo');
});

test('tracker operations can register independently for separate stores', () => {
  // Arrange: create separate registry resources for two stores.
  const firstRegistry = createTrackerInvalidation();
  const secondRegistry = createTrackerInvalidation();

  // Act: register the same operation definitions against each registry.
  const first = createTrackerOperations(firstRegistry);
  const second = createTrackerOperations(secondRegistry);

  // Assert: definitions have stable action identities without sharing instances.
  expect(first).not.toBe(second);
  expect(first.status.actions.confirmed.type).toBe(second.status.actions.confirmed.type);
});

test('operation runners use domain inputs while generated payloads preserve precise types', () => {
  // Arrange: model the operation inputs exposed by the store factory.
  type Operations = ReturnType<typeof createTrackerOperations>;

  // Act / Assert: runner inputs have no handwritten lifecycle metadata.
  expectTypeOf<Parameters<Operations['creation']['run']>[0]['input']>().toEqualTypeOf<TaskCreationInput>();
  expectTypeOf<Parameters<Operations['deletion']['run']>[0]['input']>().toEqualTypeOf<TaskDeletionInput>();
  expectTypeOf<Parameters<Operations['taskDetailWrite']['run']>[0]['input']>().toEqualTypeOf<TaskDetailWriteInput>();
  expectTypeOf<Parameters<Operations['status']['run']>[0]['input']>().toEqualTypeOf<TaskFieldInput<TaskStatus>>();
  expectTypeOf<Parameters<Operations['priority']['run']>[0]['input']>().toEqualTypeOf<TaskFieldInput<TaskPriority>>();
});
