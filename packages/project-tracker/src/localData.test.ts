import {
  describe,
  expect,
  test,
  vi
} from 'vitest';

import {
  createLocalActions,
  isLocalAction,
  reduceLocalData,
  remapTaskPreference
} from './localData.js';
import type { LocalState } from './localData.js';

function arrange() {
  const state: LocalState = {
    tasks: {
      t: {
        id: 't',
        projectId: 'p',
        assigneeId: null,
        title: 'Task',
        status: 'todo',
        priority: 'low',
      },
    },
    deletions: {},
    taskPreferences: {},
    scratchNotes: {},
  };
  const dispatch = vi.fn();
  const actions = createLocalActions({
    getState: () => state,
    dispatch,
    createId: () => 'note-1',
  });

  return { state, dispatch, actions };
}

describe('remapTaskPreference', () => {
  test('moves a draft preference to the confirmed ID', () => {
    // Arrange: the server ID has no local preference.
    const preferences = { 'temp:1': { taskId: 'temp:1', starred: true } };

    // Act: confirm the new task.
    const result = remapTaskPreference(preferences, { from: 'temp:1', to: 'saved' });

    // Assert: only the confirmed ID remains.
    expect(result).toEqual({ saved: { taskId: 'saved', starred: true } });
  });

  test('keeps an existing explicit false preference on collision', () => {
    // Arrange: a preference already exists for the confirmed ID.
    const preferences = {
      'temp:1': { taskId: 'temp:1', starred: true },
      saved: { taskId: 'saved', starred: false },
    };

    // Act: confirm the draft.
    const result = remapTaskPreference(preferences, { from: 'temp:1', to: 'saved' });

    // Assert: the existing preference wins.
    expect(result).toEqual({ saved: { taskId: 'saved', starred: false } });
  });
});

describe('local data actions', () => {
  test('preserves an explicit false preference in reducer state', () => {
    // Arrange: the task is currently starred.
    const { state } = arrange();
    const starred = { ...state, taskPreferences: { t: { taskId: 't', starred: true } } };

    // Act: reduce an unstar action.
    const result = reduceLocalData(starred, {
      type: 'localData/preferenceSet',
      payload: { taskId: 't', starred: false },
    });

    // Assert: false remains distinguishable from a missing preference.
    expect(result.taskPreferences.t).toEqual({ taskId: 't', starred: false });
  });

  test('rejects direct malformed local actions', () => {
    // Arrange: an untyped Redux action uses a local action name.
    const action = { type: 'localData/noteAdded', payload: null };

    // Act / Assert: the runtime boundary fails explicitly.
    expect(() => isLocalAction(action)).toThrow('Invalid local data action: localData/noteAdded.');
  });

  test('rejects direct actions that violate local validation', () => {
    // Arrange: an empty note bypasses the action boundary.
    const { state } = arrange();

    // Act / Assert: the reducer refuses the invalid data.
    expect(() => reduceLocalData(state, {
      type: 'localData/noteAdded',
      payload: { id: 'note', text: '' },
    })).toThrow('Invalid scratch note.');
  });

  test('sets a task preference synchronously without transport', () => {
    // Arrange: the task exists in the receiving store.
    const { actions, dispatch } = arrange();

    // Act: change its local star.
    const result = actions.setStarred({ taskId: 't', starred: true });

    // Assert: the boundary dispatches only a data action.
    expect(result).toEqual({ status: 'success' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'localData/preferenceSet',
      payload: { taskId: 't', starred: true },
    });
  });

  test('rejects preference changes for unknown tasks', () => {
    // Arrange: the requested task is absent.
    const { actions, dispatch } = arrange();

    // Act: attempt a local change.
    const result = actions.setStarred({ taskId: 'missing', starred: true });

    // Assert: the caller receives an error and nothing is dispatched.
    expect(result).toEqual({ status: 'error', error: 'Unknown task: missing.' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('rejects preference changes while deletion is pending', () => {
    // Arrange: deletion owns the task.
    const { state, dispatch } = arrange();
    const actions = createLocalActions({
      getState: () => ({
        ...state,
        deletions: { t: { status: 'saving', requestId: 'r', title: 'Task' } },
      }),
      dispatch,
      createId: () => 'note-1',
    });

    // Act: attempt a local change.
    const result = actions.setStarred({ taskId: 't', starred: false });

    // Assert: pending deletion is surfaced without a dispatch.
    expect(result).toEqual({ status: 'error', error: 'Task deletion is pending.' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('adds a trimmed note with a generated ID', () => {
    // Arrange: the note text has surrounding whitespace.
    const { actions, dispatch } = arrange();

    // Act: add the note.
    const result = actions.addNote('  Remember this  ');

    // Assert: the action contains only normalized data.
    expect(result).toEqual({ status: 'success' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'localData/noteAdded',
      payload: { id: 'note-1', text: 'Remember this' },
    });
  });

  test('rejects an empty note', () => {
    // Arrange: whitespace is not meaningful note text.
    const { actions, dispatch } = arrange();

    // Act: attempt to add it.
    const result = actions.addNote('  ');

    // Assert: the error is explicit and the store is untouched.
    expect(result).toEqual({ status: 'error', error: 'Enter a note.' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('rejects deletion of a missing note', () => {
    // Arrange: no notes exist.
    const { actions, dispatch } = arrange();

    // Act: attempt to remove one.
    const result = actions.deleteNote('missing');

    // Assert: an error is returned without dispatching.
    expect(result).toEqual({ status: 'error', error: 'Unknown note: missing.' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('deletes an existing note with a data-only action', () => {
    // Arrange: the receiving store contains one local note.
    const { state, dispatch } = arrange();
    const actions = createLocalActions({
      getState: () => ({ ...state, scratchNotes: { n: { id: 'n', text: 'Note' } } }),
      dispatch,
      createId: () => 'note-1',
    });

    // Act: delete the note.
    const result = actions.deleteNote('n');

    // Assert: the owning store receives the ID.
    expect(result).toEqual({ status: 'success' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'localData/noteDeleted', payload: 'n' });
  });

  test('rejects a generated note ID already in the store', () => {
    // Arrange: the ID generator collides with an existing note.
    const { state, dispatch } = arrange();
    const actions = createLocalActions({
      getState: () => ({ ...state, scratchNotes: { 'note-1': { id: 'note-1', text: 'Existing' } } }),
      dispatch,
      createId: () => 'note-1',
    });

    // Act: attempt to add another note.
    const result = actions.addNote('Another');

    // Assert: the existing note cannot be overwritten.
    expect(result).toEqual({ status: 'error', error: 'Could not generate a unique note ID.' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
