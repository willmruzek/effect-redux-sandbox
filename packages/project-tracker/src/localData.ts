import type {
  Task,
  TaskDeletion
} from './index.js';

export type TaskPreference = {
  readonly taskId: string;
  readonly starred: boolean;
};

export type ScratchNote = {
  readonly id: string;
  readonly text: string;
};

export type LocalResult =
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly error: string };

export type LocalAction =
  | {
    readonly type: 'localData/preferenceSet';
    readonly payload: { readonly taskId: string; readonly starred: boolean };
  }
  | {
    readonly type: 'localData/noteAdded';
    readonly payload: ScratchNote;
  }
  | {
    readonly type: 'localData/noteDeleted';
    readonly payload: string;
  };

export type LocalState = {
  readonly tasks: Readonly<Record<string, Task>>;
  readonly deletions: Readonly<Record<string, TaskDeletion>>;
  readonly taskPreferences: Readonly<Record<string, TaskPreference>>;
  readonly scratchNotes: Readonly<Record<string, ScratchNote>>;
};

export const trackerTables = {
  projects: { ownership: 'remote' },
  people: { ownership: 'remote' },
  tasks: { ownership: 'remote' },
  taskPreferences: { ownership: 'local' },
  scratchNotes: { ownership: 'local' },
} satisfies Readonly<Record<string, { readonly ownership: 'local' | 'remote' }>>;

export function remapTaskPreference(
  preferences: Readonly<Record<string, TaskPreference>>,
  ids: Readonly<{ from: string; to: string }>,
): Readonly<Record<string, TaskPreference>> {
  const draft = preferences[ids.from];

  if (ids.from === ids.to || !draft)
    return preferences;

  const next = { ...preferences };

  delete next[ids.from];

  if (!next[ids.to])
    next[ids.to] = { taskId: ids.to, starred: draft.starred };

  return next;
}

export function isLocalAction(action: { readonly type: string }): action is LocalAction {
  if (
    action.type !== 'localData/preferenceSet' &&
    action.type !== 'localData/noteAdded' &&
    action.type !== 'localData/noteDeleted'
  )
    return false;

  if ('payload' in action) {
    const payload = action.payload;

    if (action.type === 'localData/noteDeleted' && typeof payload === 'string')
      return true;

    if (typeof payload === 'object' && payload !== null) {
      if (action.type === 'localData/preferenceSet' &&
        'taskId' in payload && typeof payload.taskId === 'string' &&
        'starred' in payload && typeof payload.starred === 'boolean')
        return true;

      if (action.type === 'localData/noteAdded' &&
        'id' in payload && typeof payload.id === 'string' &&
        'text' in payload && typeof payload.text === 'string')
        return true;
    }
  }

  throw new Error(`Invalid local data action: ${action.type}.`);
}

export function reduceLocalData<State extends LocalState>(state: State, action: LocalAction): State {
  switch (action.type) {
    case 'localData/preferenceSet': {
      if (!state.tasks[action.payload.taskId])
        throw new Error(`Unknown task: ${action.payload.taskId}.`);

      if (state.deletions[action.payload.taskId]?.status === 'saving')
        throw new Error('Task deletion is pending.');

      return {
        ...state,
        taskPreferences: {
          ...state.taskPreferences,
          [action.payload.taskId]: { taskId: action.payload.taskId, starred: action.payload.starred },
        },
      };
    }
    case 'localData/noteAdded':
      if (
        !action.payload.id.trim() ||
        !action.payload.text.trim() ||
        action.payload.text !== action.payload.text.trim() ||
        state.scratchNotes[action.payload.id]
      )
        throw new Error('Invalid scratch note.');

      return {
        ...state,
        scratchNotes: { ...state.scratchNotes, [action.payload.id]: action.payload },
      };
    case 'localData/noteDeleted': {
      if (!state.scratchNotes[action.payload])
        throw new Error(`Unknown note: ${action.payload}.`);

      const scratchNotes = { ...state.scratchNotes };

      delete scratchNotes[action.payload];

      return { ...state, scratchNotes };
    }
  }
}

export function createLocalActions(options: Readonly<{
  getState: () => LocalState;
  dispatch: (action: LocalAction) => unknown;
  createId: () => string;
}>) {
  return {
    setStarred(input: Readonly<{ taskId: string; starred: boolean }>): LocalResult {
      const state = options.getState();

      if (!state.tasks[input.taskId])
        return { status: 'error', error: `Unknown task: ${input.taskId}.` };

      if (state.deletions[input.taskId]?.status === 'saving')
        return { status: 'error', error: 'Task deletion is pending.' };

      options.dispatch({ type: 'localData/preferenceSet', payload: input });

      return { status: 'success' };
    },

    addNote(text: string): LocalResult {
      const trimmed = text.trim();

      if (!trimmed)
        return { status: 'error', error: 'Enter a note.' };

      const id = options.createId();

      if (!id.trim() || options.getState().scratchNotes[id])
        return { status: 'error', error: 'Could not generate a unique note ID.' };

      options.dispatch({ type: 'localData/noteAdded', payload: { id, text: trimmed } });

      return { status: 'success' };
    },

    deleteNote(id: string): LocalResult {
      if (!options.getState().scratchNotes[id])
        return { status: 'error', error: `Unknown note: ${id}.` };

      options.dispatch({ type: 'localData/noteDeleted', payload: id });

      return { status: 'success' };
    },
  };
}
