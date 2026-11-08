import type {
  Task,
  TaskDeletionInput,
  TrackerViewState,
} from './index.js';

export type TaskValidationState = Pick<TrackerViewState,
  | 'tasks'
  | 'people'
  | 'deletions'
  | 'statusWrites'
  | 'priorityWrites'
  | 'assigneeWrites'
  | 'detailWrites'
>;

export type TaskValidationResult =
  | { readonly status: 'valid'; readonly task: Task }
  | { readonly status: 'invalid'; readonly error: string };

export type TaskEditValidationInput = {
  readonly taskId: string;
} & (
  | { readonly field: 'status' | 'priority' | 'detail' }
  | { readonly field: 'assignee'; readonly value: string | null }
);

function existingTask(
  state: Pick<TaskValidationState, 'tasks'>,
  taskId: string,
): TaskValidationResult {
  const task = state.tasks[taskId];

  return task
    ? { status: 'valid', task }
    : { status: 'invalid', error: `Unknown task: ${taskId}.` };
}

/** Pure domain eligibility; callers surface failures before claiming request ownership. */
export function validateTaskEdit(
  state: TaskValidationState,
  input: TaskEditValidationInput,
): TaskValidationResult {
  // Preserve the existing operation-specific error precedence for overlapping failures.
  if (
    (input.field === 'status' || input.field === 'priority') &&
    state.deletions[input.taskId]?.status === 'saving'
  ) {
    return { status: 'invalid', error: 'Task deletion is pending.' };
  }

  const result = existingTask(state, input.taskId);

  if (result.status === 'invalid')
    return result;

  const { task } = result;
  const draft = task.id.startsWith('temp:');

  if (input.field === 'detail' && draft)
    return { status: 'invalid', error: 'Save the creation before editing its fields.' };

  if (state.deletions[task.id]?.status === 'saving')
    return { status: 'invalid', error: 'Task deletion is pending.' };

  if (draft)
    return { status: 'invalid', error: 'Save the creation before editing its fields.' };

  if (input.field === 'assignee' && input.value !== null && !state.people[input.value])
    return { status: 'invalid', error: `Unknown person: ${input.value}.` };

  switch (input.field) {
    case 'status':
      if (state.statusWrites[input.taskId]?.status === 'saving')
        return { status: 'invalid', error: `Status is already saving for ${input.taskId}.` };
      break;

    case 'priority':
      if (state.priorityWrites[input.taskId]?.status === 'saving')
        return { status: 'invalid', error: `Priority is already saving for ${input.taskId}.` };
      break;

    case 'assignee':
      if (state.assigneeWrites[task.id]?.status === 'saving')
        return { status: 'invalid', error: `Assignee is already saving for ${task.id}.` };
      break;

    case 'detail':
      if (state.detailWrites[task.id]?.status === 'saving')
        return { status: 'invalid', error: 'Task detail save is already pending.' };
      break;
  }

  return result;
}

/** Deletion conflicts with every task save; unrelated entity writes do not block it. */
export function validateTaskDeletion(
  state: Omit<TaskValidationState, 'people'>,
  input: TaskDeletionInput,
): TaskValidationResult {
  const result = existingTask(state, input.taskId);

  if (result.status === 'invalid')
    return result;

  const { task } = result;

  if (task.id.startsWith('temp:'))
    return { status: 'invalid', error: 'Discard the creation draft instead of deleting it.' };

  if (state.deletions[task.id]?.status === 'saving')
    return { status: 'invalid', error: 'Task deletion is already pending.' };

  if (
    state.statusWrites[task.id]?.status === 'saving' ||
    state.priorityWrites[task.id]?.status === 'saving' ||
    state.assigneeWrites[task.id]?.status === 'saving'
  ) {
    return { status: 'invalid', error: 'Wait for task field saves before deleting.' };
  }

  if (state.detailWrites[task.id]?.status === 'saving')
    return { status: 'invalid', error: 'Wait for task detail saves before deleting.' };

  return result;
}
