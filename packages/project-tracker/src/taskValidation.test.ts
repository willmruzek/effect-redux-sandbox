import {
  describe,
  expect,
  test,
} from 'vitest';

import type {
  Task,
  TrackerViewState,
} from './index.js';
import {
  validateTaskDeletion,
  validateTaskEdit,
  type TaskEditValidationInput,
} from './taskValidation.js';

type State = Pick<TrackerViewState,
  'tasks' | 'people' | 'deletions' | 'statusWrites' | 'priorityWrites' | 'assigneeWrites' | 'detailWrites'
>;

function arrange(overrides: Partial<State> = {}): State {
  const task: Task = {
    id: 'a',
    title: 'Task A',
    projectId: 'p',
    assigneeId: null,
    status: 'todo',
    priority: 'low',
  };

  return {
    tasks: { a: task },
    people: {
      person: {
        id: 'person',
        name: 'Person',
        initials: 'P',
        role: 'Developer',
      },
    },
    deletions: {},
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    detailWrites: {},
    ...overrides,
  };
}

const edits: readonly TaskEditValidationInput[] = [
  { field: 'status', taskId: 'a' },
  { field: 'priority', taskId: 'a' },
  { field: 'assignee', taskId: 'a', value: null },
  { field: 'detail', taskId: 'a' },
];

describe('validateTaskEdit', () => {
  test.each(edits)('accepts a saved task for $field', (input) => {
    // Arrange: a persisted task has no pending operations.
    const state = arrange();
    const before = structuredClone(state);

    // Act: evaluate the operation's domain rules.
    const result = validateTaskEdit(state, input);

    // Assert: the validated entity is returned without copying or changing it.
    expect(result).toEqual({ status: 'valid', task: state.tasks.a });

    if (result.status === 'valid')
      expect(result.task).toBe(state.tasks.a);

    expect(state).toEqual(before);
  });

  test.each(edits)('rejects a missing task for $field', (input) => {
    // Arrange: the task is absent.
    const state = arrange({ tasks: {} });

    // Act: validate the missing entity.
    const result = validateTaskEdit(state, input);

    // Assert: the failure carries the existing user-facing message.
    expect(result).toEqual({ status: 'invalid', error: 'Unknown task: a.' });
  });

  test.each(edits)('rejects a creation draft for $field', (input) => {
    // Arrange: use a retained temporary task rather than a saved task.
    const state = arrange({
      tasks: {
        'temp:a': {
          id: 'temp:a',
          title: 'Draft',
          projectId: 'p',
          assigneeId: null,
          status: 'todo',
          priority: 'low',
        },
      },
    });

    // Act: validate the draft edit.
    const result = validateTaskEdit(state, { ...input, taskId: 'temp:a' });

    // Assert: drafts require creation to finish first.
    expect(result).toEqual({
      status: 'invalid',
      error: 'Save the creation before editing its fields.',
    });
  });

  test.each(edits)('rejects a pending deletion for $field', (input) => {
    // Arrange: deletion owns this task.
    const state = arrange({
      deletions: { a: { status: 'saving', requestId: 'delete', title: 'Task A' } },
    });

    // Act: validate an edit during deletion.
    const result = validateTaskEdit(state, input);

    // Assert: no edit may start on a task being deleted.
    expect(result).toEqual({ status: 'invalid', error: 'Task deletion is pending.' });
  });

  test.each([
    {
      input: { field: 'status', taskId: 'a' },
      state: { statusWrites: { a: { status: 'saving', requestId: 's', original: 'todo' } } },
      error: 'Status is already saving for a.',
    },
    {
      input: { field: 'priority', taskId: 'a' },
      state: { priorityWrites: { a: { status: 'saving', requestId: 'p', original: 'low' } } },
      error: 'Priority is already saving for a.',
    },
    {
      input: { field: 'assignee', taskId: 'a', value: null },
      state: { assigneeWrites: { a: { status: 'saving', requestId: 'a', original: null } } },
      error: 'Assignee is already saving for a.',
    },
    {
      input: { field: 'detail', taskId: 'a' },
      state: {
        detailWrites: {
          a: {
            status: 'saving',
            requestId: 'd',
            original: { title: 'Task A', description: null },
          },
        },
      },
      error: 'Task detail save is already pending.',
    },
  ] satisfies readonly {
    input: TaskEditValidationInput;
    state: Partial<State>;
    error: string;
  }[])('rejects a pending $input.field save', ({ input, state: overrides, error }) => {
    // Arrange: this operation already owns its save.
    const state = arrange(overrides);

    // Act: validate another save of the same field.
    const result = validateTaskEdit(state, input);

    // Assert: domain-specific pending feedback is preserved.
    expect(result).toEqual({ status: 'invalid', error });
  });

  test('accepts status edits while a different field is saving', () => {
    // Arrange: priority ownership does not block status.
    const state = arrange({
      priorityWrites: { a: { status: 'saving', requestId: 'p', original: 'low' } },
    });

    // Act: validate the independent field.
    const result = validateTaskEdit(state, { field: 'status', taskId: 'a' });

    // Assert: field independence is preserved.
    expect(result.status).toBe('valid');
  });

  test('accepts a retry after deletion or field failures', () => {
    // Arrange: errors do not own pending work.
    const state = arrange({
      deletions: { a: { status: 'error', requestId: 'd', title: 'Task A', error: 'Offline' } },
      statusWrites: { a: { status: 'error', error: 'Offline' } },
    });

    // Act: validate a retry.
    const result = validateTaskEdit(state, { field: 'status', taskId: 'a' });

    // Assert: only saving records block edits.
    expect(result.status).toBe('valid');
  });

  test('rejects an unknown assignee before checking assignee ownership', () => {
    // Arrange: the requested person is absent and an earlier save is pending.
    const state = arrange({
      assigneeWrites: { a: { status: 'saving', requestId: 'a', original: null } },
    });

    // Act: validate an invalid assignment.
    const result = validateTaskEdit(state, { field: 'assignee', taskId: 'a', value: 'missing' });

    // Assert: reference validation retains its precedence.
    expect(result).toEqual({ status: 'invalid', error: 'Unknown person: missing.' });
  });

  test('accepts an existing assignee', () => {
    // Arrange: the requested person exists.
    const state = arrange();

    // Act: validate the assignment.
    const result = validateTaskEdit(state, { field: 'assignee', taskId: 'a', value: 'person' });

    // Assert: valid references are accepted.
    expect(result.status).toBe('valid');
  });

  test.each([
    { field: 'status', expected: 'Task deletion is pending.' },
    { field: 'priority', expected: 'Task deletion is pending.' },
    { field: 'detail', expected: 'Unknown task: a.' },
  ] satisfies readonly { field: 'status' | 'priority' | 'detail'; expected: string }[])(
    'preserves $field error precedence when the task is absent during deletion',
    ({ field, expected }) => {
      // Arrange: overlapping invalid states match the pre-refactor workflow.
      const state = arrange({
        tasks: {},
        deletions: { a: { status: 'saving', requestId: 'd', title: 'Task A' } },
      });

      // Act: validate this operation.
      const result = validateTaskEdit(state, { field, taskId: 'a' });

      // Assert: extraction does not reorder the visible failure.
      expect(result).toEqual({ status: 'invalid', error: expected });
    },
  );
});

describe('validateTaskDeletion', () => {
  test.each([
    {
      label: 'missing task',
      state: { tasks: {} },
      error: 'Unknown task: a.',
    },
    {
      label: 'pending deletion',
      state: { deletions: { a: { status: 'saving', requestId: 'd', title: 'Task A' } } },
      error: 'Task deletion is already pending.',
    },
    {
      label: 'status save',
      state: { statusWrites: { a: { status: 'saving', requestId: 's', original: 'todo' } } },
      error: 'Wait for task field saves before deleting.',
    },
    {
      label: 'priority save',
      state: { priorityWrites: { a: { status: 'saving', requestId: 'p', original: 'low' } } },
      error: 'Wait for task field saves before deleting.',
    },
    {
      label: 'assignee save',
      state: { assigneeWrites: { a: { status: 'saving', requestId: 'a', original: null } } },
      error: 'Wait for task field saves before deleting.',
    },
    {
      label: 'detail save',
      state: {
        detailWrites: {
          a: {
            status: 'saving',
            requestId: 'd',
            original: { title: 'Task A', description: null },
          },
        },
      },
      error: 'Wait for task detail saves before deleting.',
    },
  ] satisfies readonly { label: string; state: Partial<State>; error: string }[])(
    'rejects deletion during $label',
    ({ state: overrides, error }) => {
      // Arrange: an operation-specific precondition is unsatisfied.
      const state = arrange(overrides);

      // Act: validate deletion.
      const result = validateTaskDeletion(state, { taskId: 'a' });

      // Assert: rejection is explicit domain data.
      expect(result).toEqual({ status: 'invalid', error });
    },
  );

  test('rejects deletion of a creation draft', () => {
    // Arrange: a draft has not been persisted.
    const state = arrange({
      tasks: {
        'temp:a': {
          id: 'temp:a',
          title: 'Draft',
          projectId: 'p',
          assigneeId: null,
          status: 'todo',
          priority: 'low',
        },
      },
    });

    // Act: validate draft deletion.
    const result = validateTaskDeletion(state, { taskId: 'temp:a' });

    // Assert: discarding is distinct from a backend delete.
    expect(result).toEqual({
      status: 'invalid',
      error: 'Discard the creation draft instead of deleting it.',
    });
  });

  test('accepts deletion after failed writes', () => {
    // Arrange: failed operations no longer own this task.
    const state = arrange({
      deletions: { a: { status: 'error', requestId: 'd', title: 'Task A', error: 'Offline' } },
      statusWrites: { a: { status: 'error', error: 'Offline' } },
      detailWrites: { a: { status: 'error', error: 'Offline' } },
    });

    // Act: validate deletion.
    const result = validateTaskDeletion(state, { taskId: 'a' });

    // Assert: the saved entity is returned.
    expect(result).toEqual({ status: 'valid', task: state.tasks.a });
  });
});
