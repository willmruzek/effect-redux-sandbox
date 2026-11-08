import {
  expect,
  expectTypeOf,
  test
} from 'vitest';

import type {
  PersonNameInput,
  TaskCreationInput,
  TaskDeletionInput,
  TaskDetailWriteInput,
  TaskFieldInput,
  TaskPriority,
  TaskStatus
} from '@repo/project-tracker';

import { trackerOperations } from './trackerOperations';

test('operation runners use domain inputs while generated payloads preserve precise types', () => {
  // Arrange: shared domain input contracts for independent app definitions.
  type Operations = typeof trackerOperations;

  // Act / Assert: runner inputs have no handwritten lifecycle metadata.
  expectTypeOf<Parameters<Operations['creation']['run']>[0]['input']>().toEqualTypeOf<TaskCreationInput>();
  expectTypeOf<Parameters<Operations['deletion']['run']>[0]['input']>().toEqualTypeOf<TaskDeletionInput>();
  expectTypeOf<Parameters<Operations['taskDetailWrite']['run']>[0]['input']>().toEqualTypeOf<TaskDetailWriteInput>();
  expectTypeOf<Parameters<Operations['personName']['run']>[0]['input']>().toEqualTypeOf<PersonNameInput>();
  expectTypeOf<Parameters<Operations['status']['run']>[0]['input']>().toEqualTypeOf<TaskFieldInput<TaskStatus>>();
  expectTypeOf<Parameters<Operations['priority']['run']>[0]['input']>().toEqualTypeOf<TaskFieldInput<TaskPriority>>();
  expectTypeOf<Parameters<Operations['assignee']['run']>[0]['input']>().toEqualTypeOf<TaskFieldInput<string | null>>();
  expectTypeOf<Parameters<Operations['assignee']['actions']['confirmed']>[0]['result']>()
    .toEqualTypeOf<string | null>();

  expect(trackerOperations.assignee.actions.started({
    taskId: 'task',
    value: null,
    requestId: 'owner',
  })).toEqual({
    type: 'tracker/assigneeStarted',
    payload: { taskId: 'task', value: null, requestId: 'owner' },
  });
});
