// @vitest-environment happy-dom

import {
  act,
  StrictMode
} from 'react';
import {
  createRoot,
  type Root
} from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';

import { ProjectTracker } from './ProjectTracker.js';
import type {
  TaskQuery,
  TrackerViewState,
  TrackerSourceMode
} from './index.js';

function createSource() {
  let state: TrackerViewState = {
    sourceMode: 'graphql',
    peopleRequest: { status: 'idle' },
    creations: {},
    deletions: {},
    taskPreferences: {},
    scratchNotes: {},
    projects: {
      a: {
        id: 'a',
        name: 'Alpha project',
        code: 'ALP',
        description: 'First project'
      },
      empty: {
        id: 'empty',
        name: 'Empty project',
        code: 'EMP',
        description: 'No tasks yet'
      },
    },
    people: {
      ada: {
        id: 'ada',
        name: 'Ada Test',
        initials: 'AT',
        role: 'Design'
      }
    },
    tasks: Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
      const id = String(index + 1);

      return [id, {
        id,
        projectId: 'a',
        assigneeId: index === 0 ? null : 'ada',
        title: `Task ${id}`,
        status: 'todo',
        priority: 'high',
      }];
    })),
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: 'idle' },
    result: {
      loadedPages: 1,
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      ids: ['7', '6', '5', '4', '3', '2', '1'],
      pageInfo: { endCursor: 'cursor', hasNextPage: true },
      totalCount: 200,
      statusCounts: [{ status: 'todo', total: 200 }],
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
  };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,

    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    update: (next: TrackerViewState) => {
      state = next;

      for (const listener of listeners)
        listener();
    },

    listenerCount: () => listeners.size,
  };
}

describe('backend-driven tracker view', () => {
  let container: HTMLDivElement;
  let root: Root;
  let source: ReturnType<typeof createSource>;
  const queryChanged = vi.fn<(query: Partial<TaskQuery>, fail: boolean) => Promise<void>>(async () => { });
  const loadMore = vi.fn(async () => { });
  const refresh = vi.fn<(fail: boolean) => Promise<void>>(async () => { });
  const remove = vi.fn<(input: {
    readonly taskId: string;
    readonly fail?: boolean
  }) => Promise<void>>(async () => { });
  const openTask = vi.fn<(taskId: string, sourceMode: TrackerSourceMode) => void>();
  const selectSourceMode = vi.fn<(sourceMode: TrackerSourceMode) => Promise<void>>(async () => { });
  const saveAssignee = vi.fn(async () => { });
  const renamePerson = vi.fn(async () => { });
  const setStarred = vi.fn(() => ({ status: 'success' } satisfies import('./index.js').LocalResult));
  const addNote = vi.fn(() => ({ status: 'error', error: 'Enter a note.' } satisfies import('./index.js').LocalResult));
  const deleteNote = vi.fn(() => ({ status: 'success' } satisfies import('./index.js').LocalResult));
  function render(strict = false): void {
    const app = <ProjectTracker
      implementation="Effect First" source={source} state={source.getSnapshot()}
      onCreate={async () => { }} onRetry={async () => { }} onDiscard={() => { }}
      onDelete={remove} onDismissDeletionError={() => { }}
      onQueryChange={queryChanged} onLoadMore={loadMore} onRefresh={refresh}
      onSaveStatus={async () => { }} onSavePriority={async () => { }}
      onSaveAssignee={saveAssignee} onRenamePerson={renamePerson}
      onSelectSourceMode={selectSourceMode}
      onOpenTask={openTask}
      onSetStarred={setStarred} onAddNote={addNote} onDeleteNote={deleteNote}
    />;

    root.render(strict ? <StrictMode>{app}</StrictMode> : app);
  }

  function button(label: string): HTMLButtonElement {
    const result = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(label));

    if (!result)
      throw new Error(`Missing button: ${label}`);

    return result;
  }

  function ids(): (string | null)[] {
    return Array.from(container.querySelectorAll('tbody .task-id'), (element) => element.textContent);
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    queryChanged.mockClear();
    loadMore.mockClear();
    refresh.mockClear();
    remove.mockClear();
    openTask.mockClear();
    selectSourceMode.mockClear();
    saveAssignee.mockClear();
    renamePerson.mockClear();
    setStarred.mockClear();
    addNote.mockClear();
    deleteNote.mockClear();
    source = createSource();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => render());
  });

  test('delegates task stars to the local action boundary', async () => {
    // Arrange: the visible task has no preference.
    const star = container.querySelector<HTMLButtonElement>('[aria-label="Star task 7"]');

    if (!star)
      throw new Error('Missing star button.');

    // Act: change its preference.
    await act(async () => star.click());

    // Assert: the local boundary receives the intended value.
    expect(setStarred).toHaveBeenCalledExactlyOnceWith({ taskId: '7', starred: true });
  });

  test('shows local note validation failures', async () => {
    // Arrange: the input is empty.
    const form = container.querySelector<HTMLFormElement>('[aria-label="Add scratch note"]');

    if (!form)
      throw new Error('Missing note form.');

    // Act: submit the invalid note.
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    // Assert: the boundary error is visible.
    expect(addNote).toHaveBeenCalledExactlyOnceWith('');
    expect(container.textContent).toContain('Enter a note.');
  });

  test('requires explicit confirmation before deleting a task', async () => {
    // Arrange: select a visible row for deletion.
    await act(async () => button('Delete 7').click());
    expect(remove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Keep task'));
    // Act: confirm the destructive intent.
    await act(async () => button('Confirm deletion').click());
    // Assert: the app, not the UI, owns mutation state.
    expect(remove).toHaveBeenCalledExactlyOnceWith({ taskId: '7', fail: false });
  });

  test('opens the selected task detail from its row', async () => {
    // Arrange: render the current backend page.
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open task 7: Task 7"]');

    if (!open)
      throw new Error('Missing task detail button.');

    // Act: open a task.
    await act(async () => open.click());
    // Assert: navigation intent stays app-owned.
    expect(openTask).toHaveBeenCalledExactlyOnceWith('7', 'graphql');
  });

  test(
    'selects a data source example without coupling it to the shared UI',
    async () => {
      // Arrange: the example selector is rendered with GraphQL as the default.
      const selector = container.querySelector<HTMLSelectElement>('[aria-label="Data source example"]');

      if (!selector)
        throw new Error('Missing data source selector.');

      expect(selector.value).toBe('graphql');

      // Act: select the mixed-source example.
      await act(async () => {
        selector.value = 'mixed';
        selector.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Assert: the app owns the source transition.
      expect(selectSourceMode).toHaveBeenCalledExactlyOnceWith('mixed');
    }
  );

  test('delegates reassignment from the task table to the owning app', async () => {
    // Arrange: find the assignee control for a visible task.
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="Assignee for 7"]');

    if (!selector)
      throw new Error('Missing task assignee control.');

    // Act: select a person.
    await act(async () => {
      selector.value = 'ada';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Assert: the app receives a field-scoped assignment request.
    expect(saveAssignee).toHaveBeenCalledExactlyOnceWith({ taskId: '7', value: 'ada' });
  });

  test('shows REST-owned person names only in REST-backed examples', async () => {
    // Arrange: switch the rendered example to REST.
    source.update({ ...source.getSnapshot(), sourceMode: 'rest' });
    await act(async () => render());

    const input = container.querySelector<HTMLInputElement>('#person-name-ada');

    if (!input)
      throw new Error('Missing REST person-name input.');

    // Act: submit a new display name.
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

      if (!setValue)
        throw new Error('Missing input value setter.');

      setValue.call(input, 'Ada Lovelace');
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const form = input.closest('form');

      if (!form)
        throw new Error('Missing person rename form.');

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Assert: name persistence is delegated to the app workflow.
    expect(renamePerson).toHaveBeenCalledExactlyOnceWith({ personId: 'ada', name: 'Ada Lovelace' });
  });

  test.each(['graphql', 'rest', 'mixed'] satisfies readonly TrackerSourceMode[])(
    'derives the %s source mode from the supplied state',
    async (sourceMode) => {
      // Arrange: the source selection exists only in the store snapshot.
      source.update({ ...source.getSnapshot(), sourceMode });

      // Act: render without separate source-mode props.
      await act(async () => render());

      // Assert: selection and REST-owned controls reflect the same state.
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Data source example"]')?.value)
        .toBe(sourceMode);
      expect(container.querySelector('#person-name-ada') !== null).toBe(sourceMode !== 'graphql');
    },
  );

  test('derives people loading and failure messages from request state', async () => {
    // Arrange: REST owns a pending people request.
    source.update({
      ...source.getSnapshot(),
      sourceMode: 'mixed',
      peopleRequest: { status: 'loading', requestId: 'people' },
    });

    // Act: render the pending request.
    await act(async () => render());

    // Assert: the loading message comes from state, without a duplicate prop.
    expect(container.textContent).toContain('Loading people from REST...');

    // Arrange: that request fails.
    source.update({
      ...source.getSnapshot(),
      peopleRequest: { status: 'error', requestId: 'people', error: 'People unavailable' },
    });

    // Act: publish the failure snapshot.
    await act(async () => render());

    // Assert: loading disappears and the actual failure is visible.
    expect(container.textContent).not.toContain('Loading people from REST...');
    expect(container.querySelector('.people-directory [role="alert"]')?.textContent)
      .toBe('People unavailable');
  });

  test('derives retained creation notices from the supplied state', async () => {
    // Arrange: a retained failed creation points at a normalized task.
    source.update({
      ...source.getSnapshot(),
      creations: {
        draft: { status: 'error', taskId: '7', requestId: 'create', error: 'Creation unavailable' },
      },
    });

    // Act: render without a separate creations prop.
    await act(async () => render());

    // Assert: the notice and retry controls use state-owned metadata.
    expect(container.querySelector('[data-operation-id="draft"]')?.textContent).toContain('Task 7');
    expect(container.querySelector('[data-operation-id="draft"] [role="alert"]')?.textContent)
      .toBe('Creation unavailable');
    expect(button('Retry creation')).toBeDefined();
  });

  test('canceling confirmation leaves the task untouched', async () => {
    // Arrange: open the confirmation.
    await act(async () => button('Delete 7').click());
    // Act: cancel.
    await act(async () => button('Keep task').click());
    // Assert: no deletion intent is dispatched.
    expect(remove).not.toHaveBeenCalled();
    expect(ids()).toContain('7');
  });

  test(
    'hides pending deletion rows while keeping server totals unchanged',
    async () => {
      // Arrange: the entity is still retained in the store.
      source.update({
        ...source.getSnapshot(),
        deletions: {
          '7': {
            status: 'saving',
            title: 'Task 7',
            requestId: 'delete'
          }
        },
      });
      // Act: render the app-owned pending deletion metadata.
      await act(async () => render());
      // Assert: a distinct notice replaces the row without fabricating server totals.
      expect(ids()).not.toContain('7');
      expect(container.textContent).toContain('Deleting');
      expect(container.querySelector('#task-heading span')?.textContent).toBe('200');
      expect(source.getSnapshot().tasks['7']).toBeDefined();
    }
  );

  test('restores a failed row with explicit refresh and retry actions', async () => {
    // Arrange: deletion failed and the retained entity is visible again.
    source.update({
      ...source.getSnapshot(),
      deletions: {
        '7': {
          status: 'error',
          title: 'Task 7',
          requestId: 'delete',
          error: 'Field changed. Refresh and retry.'
        }
      },
    });
    // Act: render the failure.
    await act(async () => render());
    // Assert: retry requires confirmation rather than silently reissuing deletion.
    expect(ids()).toContain('7');
    expect(container.querySelector('[data-deletion-id="7"] [role="alert"]')?.textContent).toContain('Field changed');
    await act(async () => button('Retry deletion').click());
    expect(remove).not.toHaveBeenCalled();
    expect(button('Confirm deletion')).toBeDefined();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('requests refresh while keeping the current ledger visible', async () => {
    // Arrange: a loaded ledger is already visible.
    const before = ids();

    // Act: request a refresh through the separate UI boundary.
    await act(async () => button('Refresh tasks').click());

    // Assert: the callback owns reconciliation, not the UI.
    expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
    expect(ids()).toEqual(before);
    expect(loadMore).not.toHaveBeenCalled();
  });

  test('shows refreshing state without hiding rows or local pagination', async () => {
    // Arrange: move to the second five-row UI page.
    await act(async () => button('Next').click());

    const before = ids();

    // Act: the store publishes an in-flight refresh.
    await act(async () => {
      const current = source.getSnapshot();

      source.update({
        ...current,
        request: {
          status: 'refreshing',
          after: null,
          sourceMode: 'graphql',
          query: current.result.query,
          requestId: 'refresh',
        }
      });
      render();
    });

    // Assert: current rows/page remain, with distinct refresh feedback.
    expect(ids()).toEqual(before);
    expect(container.textContent).toContain('Refreshing source records');
    expect(container.textContent).toContain('Page 2 of 2');
    expect(button('Refreshing tasks').disabled).toBe(true);
  });

  test(
    'offers refresh retry without removing the previous window on failure',
    async () => {
      // Arrange: existing rows survived a failed refresh.
      const before = ids();

      await act(async () => {
        const current = source.getSnapshot();

        source.update({
          ...current,
          request: {
            status: 'refresh-error',
            after: null,
            sourceMode: 'graphql',
            query: current.result.query,
            error: 'Refresh unavailable.',
          }
        });
        render();
      });

      // Act: retry through the refresh control.
      await act(async () => button('Retry refresh').click());

      // Assert: the error was visible and retry does not append an old cursor.
      expect(container.textContent).toContain('Refresh unavailable.');
      expect(container.textContent).toContain('Successful mutations remain committed');
      expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
      expect(loadMore).not.toHaveBeenCalled();
      expect(ids()).toEqual(before);
    }
  );

  test(
    'pages fetched IDs in backend order without requesting another cursor',
    async () => {
      // Arrange: backend order deliberately differs from ID order.
      expect(ids()).toEqual(['7', '6', '5', '4', '3']);

      // Act: navigate the local window.
      await act(async () => button('Next').click());

      // Assert: only fetched records participate, not the backend total.
      expect(ids()).toEqual(['2', '1']);
      expect(container.textContent).toContain('Page 2 of 2');
      expect(container.textContent).toContain('7 loaded / 200 matching tasks on backend');
      expect(loadMore).not.toHaveBeenCalled();
    }
  );

  test(
    'dispatches backend filter intent without locally hiding the previous view',
    async () => {
      // Arrange: an existing result remains while the backend is contacted.
      const before = ids();

      // Act: select a project.
      await act(async () => button('Empty project').click());

      // Assert: the store workflow, not a local predicate, owns replacement.
      expect(queryChanged).toHaveBeenCalledWith({ projectId: 'empty' }, false);
      expect(ids()).toEqual(before);
    }
  );

  test.each([
    {
      label: 'Filter by assignee',
      value: 'unassigned',
      expected: { assigneeId: 'unassigned' }
    },
    {
      label: 'Sort tasks',
      value: 'priority',
      expected: { sort: 'priority' }
    },
  ])('requests backend changes for $label', async ({
    label,
    value,
    expected
  }) => {
    // Arrange: a real shared select control.
    const input = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);

    if (!input)
      throw new Error('Missing select');

    // Act: change one backend query parameter.
    await act(async () => {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Assert: intent reaches the dispatched workflow boundary.
    expect(queryChanged).toHaveBeenCalledWith(expected, false);
  });

  test('debounces normalized backend search by 300 ms', async () => {
    // Arrange: control the query delay.
    vi.useFakeTimers();

    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    if (!input || !setter)
      throw new Error('Missing search');

    // Act: type without waiting for the debounce.
    await act(async () => {
      setter.call(input, '  PLAN  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(queryChanged).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    // Assert: one normalized request, no immediate local filtering.
    expect(queryChanged).toHaveBeenCalledExactlyOnceWith({ search: 'plan' }, false);
    expect(ids()).toHaveLength(5);
  });

  test(
    'resets the local page when the backend publishes a replacement query',
    async () => {
      // Arrange: navigate away from the first local page.
      await act(async () => button('Next').click());

      // Act: a successful query replaces the visible result IDs.
      await act(async () => {
        const state = source.getSnapshot();

        source.update({
          ...state,
          result: {
            ...state.result,
            query: { ...state.result.query, search: 'new' },
            ids: ['1']
          }
        });
        render();
      });

      // Assert: cached non-matching records do not leak into the view.
      expect(ids()).toEqual(['1']);
      expect(container.textContent).toContain('Page 1 of 1');
    }
  );

  test('keeps left-joined unassigned tasks and empty cached projects', async () => {
    // Arrange: the fixture has an unassigned task on the second local page.
    // Act: reveal it.
    await act(async () => button('Next').click());

    // Assert: nullable relations survive DB projection.
    expect(container.querySelector('tbody')?.textContent).toContain('Unassigned');
    expect(container.querySelector('[data-project-id="empty"]')?.textContent).toContain('0 tasks');
    expect(container.querySelector('[data-project-id="empty"]')?.textContent).toContain('No cached tasks yet');
  });

  test('reacts to cached entity changes without a parent render', async () => {
    // Arrange: update an existing visible row.
    const state = source.getSnapshot();
    const task = state.tasks['7'];

    if (!task)
      throw new Error('Missing fixture task');

    // Act: publish only through the source subscription.
    await act(async () => source.update({
      ...state,
      tasks: { ...state.tasks, '7': { ...task, title: 'Updated live task' } }
    }));

    // Assert: the read-only live query follows the store.
    expect(container.querySelector('tbody')?.textContent).toContain('Updated live task');
  });

  test('keeps one source subscription through Strict Mode replay', async () => {
    // Arrange: unmount the ordinary consumer.
    await act(async () => root.render(null));

    // Act: mount under Strict Mode.
    await act(async () => render(true));
    expect(source.listenerCount()).toBe(1);
    await act(async () => root.render(null));

    // Assert: discarded render attempts and cleanup leave no source listeners.
    expect(source.listenerCount()).toBe(0);
  });

  test('replaces its DB scope when the source changes', async () => {
    // Arrange: replace the source at the same component position.
    const previous = source;

    source = createSource();
    source.update({ ...source.getSnapshot(), tasks: {} });

    // Act: render the new source.
    await act(async () => render());

    // Assert: the old source is disconnected.
    expect(previous.listenerCount()).toBe(0);
    expect(source.listenerCount()).toBe(1);
    expect(ids()).toEqual([]);
  });
});
