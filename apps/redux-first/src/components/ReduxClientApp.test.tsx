// @vitest-environment happy-dom

import {
  act,
  StrictMode
} from 'react';
import {
  createRoot,
  hydrateRoot,
  type Root
} from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';

import { ReduxClientApp } from './ReduxClientApp';

import type { TrackerState } from '@repo/project-tracker';
import {
  createGraphqlHandler,
  createTrackerRepository
} from '@repo/tracker-graphql/server';

let handleApiRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  handleApiRequest = createGraphqlHandler({ repository: createTrackerRepository() });
});

function fixture(): TrackerState {
  return {
    projects: {
      atlas: {
        id: 'atlas',
        name: 'Atlas website',
        code: 'ATL',
        description: 'Website'
      },
      studio: {
        id: 'studio',
        name: 'Studio toolkit',
        code: 'STU',
        description: 'Toolkit'
      },
      field: {
        id: 'field',
        name: 'Field research',
        code: 'FLD',
        description: 'Research'
      },
      ideas: {
        id: 'ideas',
        name: 'Ideas inbox',
        code: 'IDE',
        description: 'Empty project'
      },
    },
    people: {
      mara: {
        id: 'mara',
        name: 'Mara Chen',
        initials: 'MC',
        role: 'Design'
      },
      eli: {
        id: 'eli',
        name: 'Eli Brooks',
        initials: 'EB',
        role: 'Engineering'
      },
      nia: {
        id: 'nia',
        name: 'Nia Patel',
        initials: 'NP',
        role: 'Research'
      },
      owen: {
        id: 'owen',
        name: 'Owen Reed',
        initials: 'OR',
        role: 'Product'
      },
    },
    tasks: {
      'ATL-01': {
        id: 'ATL-01',
        projectId: 'atlas',
        assigneeId: 'mara',
        title: 'Map the new information architecture',
        status: 'in-progress',
        priority: 'high'
      },
      'ATL-02': {
        id: 'ATL-02',
        projectId: 'atlas',
        assigneeId: 'eli',
        title: 'Build the accessible navigation shell',
        status: 'todo',
        priority: 'high'
      },
      'STU-01': {
        id: 'STU-01',
        projectId: 'studio',
        assigneeId: 'mara',
        title: 'Document the color foundations',
        status: 'done',
        priority: 'medium'
      },
      'STU-02': {
        id: 'STU-02',
        projectId: 'studio',
        assigneeId: null,
        title: 'Audit component usage across teams',
        status: 'todo',
        priority: 'low'
      },
      'FLD-01': {
        id: 'FLD-01',
        projectId: 'field',
        assigneeId: 'nia',
        title: 'Synthesize the first interview round',
        status: 'in-progress',
        priority: 'high'
      },
      'FLD-02': {
        id: 'FLD-02',
        projectId: 'field',
        assigneeId: 'owen',
        title: 'Share the research brief',
        status: 'done',
        priority: 'medium'
      },
    },
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
      ids: ['ATL-01', 'ATL-02', 'FLD-01', 'FLD-02', 'STU-01', 'STU-02'],
      pageInfo: { endCursor: null, hasNextPage: true },
      totalCount: 6,
      statusCounts: [{ status: 'todo', total: 2 }, { status: 'in-progress', total: 2 }, { status: 'done', total: 2 }],
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
    taskPreferences: {},
    scratchNotes: {},
  };
}

describe('Redux project tracker UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) =>
      handleApiRequest(new Request(new URL(url, 'http://localhost'), init))));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ReduxClientApp initial={fixture()} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function button(label: string): HTMLButtonElement {
    const result = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes(label),
    );

    if (!result)
      throw new Error(`Missing button: ${label}`);

    return result;
  }

  test('renders joined tasks with project and assignee names', () => {
    // Arrange: the mounted app runs the real live query.
    // Act: read the rendered task table.
    const rows = container.querySelectorAll('tbody tr');

    // Assert: the first DB page has resolved relationships.
    expect(rows).toHaveLength(5);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.textContent).toContain('Atlas website');
    expect(container.textContent).toContain('Mara Chen');
    expect(container.textContent).toContain('Map the new information architecture');
  });

  test('updates local stars and notes without sending requests', async () => {
    // Arrange: use the real app and its read-only projection.
    const star = container.querySelector<HTMLButtonElement>('[aria-label="Star task ATL-01"]');
    const input = container.querySelector<HTMLInputElement>('.scratch-notes input');
    const form = container.querySelector<HTMLFormElement>('[aria-label="Add scratch note"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    if (!star || !input || !form || !setter)
      throw new Error('Missing local controls.');

    const requestsBefore = vi.mocked(fetch).mock.calls.length;

    // Act: commit a local star and note.
    await act(async () => star.click());
    await act(async () => {
      setter.call(input, '  A local note  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    // Assert: both projections update without transport.
    expect(container.querySelector('[aria-label="Unstar task ATL-01"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.scratch-notes')?.textContent).toContain('A local note');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requestsBefore);

    const removeNote = container.querySelector<HTMLButtonElement>('[aria-label="Delete note A local note"]');

    if (!removeNote)
      throw new Error('Missing local note delete button.');

    await act(async () => removeNote.click());
    expect(container.querySelector('.scratch-notes')?.textContent).not.toContain('A local note');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(requestsBefore);
  });

  test('shows seeded unassigned tasks through the shared filter', async () => {
    // Arrange: the seed includes an intentionally null assignee.
    const assignee = container.querySelector<HTMLSelectElement>('[aria-label="Filter by assignee"]');

    if (!assignee)
      throw new Error('Missing assignee filter');

    // Act: select unassigned tasks.
    await act(async () => {
      assignee.value = 'unassigned';
      assignee.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Assert: the optional relationship does not hide the task.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.querySelector('tbody')?.textContent).toContain('Unassigned');
    expect(container.textContent).toContain('20 loaded /');
    expect(container.querySelector('[data-project-id="ideas"]')?.textContent).toContain('0 tasks');
  });

  test('filters tasks by project through store-owned selection', async () => {
    // Arrange: all projects are initially visible.
    // Act: select one project.
    await act(async () => button('Atlas website').click());

    // Assert: only that project's two tasks remain.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.textContent).toContain('Build the accessible navigation shell');
    expect(container.querySelector('tbody')?.textContent).not.toContain('Synthesize');
  });

  test('filters the live ledger by assignee in title order', async () => {
    // Arrange: use the actual shared controls in the Redux app.
    const assignee = container.querySelector<HTMLSelectElement>('[aria-label="Filter by assignee"]');
    const sort = container.querySelector<HTMLSelectElement>('[aria-label="Sort tasks"]');

    if (!assignee || !sort)
      throw new Error('Missing ledger controls');

    // Act: select Mara's tasks and title order.
    await act(async () => {
      assignee.value = 'mara';
      assignee.dispatchEvent(new Event('change', { bubbles: true }));
      sort.value = 'title';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Assert: the mirrored app uses DB filtering and ordering.
    expect(Array.from(container.querySelectorAll('tbody .task-id'), (row) => row.textContent).slice(
      0,
      2
    )).toEqual(['STU-01', 'ATL-01']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(button('Atlas website').textContent).toContain('2');
  });

  test('labels both optimistic fields as store owned', () => {
    // Arrange: the mounted tracker has seeded task statuses.
    // Act: inspect the joined task rows.
    const table = container.querySelector('tbody');

    // Assert: neither field advertises a DB-owned write.
    expect(table?.textContent).toContain('In progress');
    expect(table?.textContent).toContain('Done');
    expect(container.textContent).toContain('Store optimistic');
    expect(container.textContent).not.toContain('DB optimistic');
    expect(container.textContent).toContain('DB stays read-only');
    expect(table?.querySelector('[aria-label="Status for ATL-01"]')).not.toBeNull();
    expect(table?.querySelector('[aria-label="Priority for ATL-01"]')).not.toBeNull();
  });

  test.each([
    { statusFails: false, priorityFails: false },
    { statusFails: true, priorityFails: false },
    { statusFails: false, priorityFails: true },
    { statusFails: true, priorityFails: true },
  ])('settles independent optimistic writes: %j', async ({ statusFails, priorityFails }) => {
    // Arrange: independent failure controls exercise the real Effect/API boundary.
    vi.useFakeTimers();

    const status = container.querySelector<HTMLSelectElement>('[aria-label="Status for ATL-01"]');
    const priority = container.querySelector<HTMLSelectElement>('[aria-label="Priority for ATL-01"]');

    if (!status || !priority)
      throw new Error('Missing write controls');

    await act(async () => {
      if (statusFails)
        container.querySelector<HTMLInputElement>('[aria-label="Fail status saves"]')?.click();

      if (priorityFails)
        container.querySelector<HTMLInputElement>('[aria-label="Fail priority saves"]')?.click();
    });

    // Act: edit both fields before either network request finishes.
    await act(async () => {
      status.value = 'done';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      priority.value = 'low';
      priority.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(status.value).toBe('done');
    expect(priority.value).toBe('low');
    expect(status.disabled).toBe(true);
    expect(priority.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(700));

    // Assert: each field confirms or rolls back without undoing the other.
    expect(status.value).toBe(statusFails ? 'in-progress' : 'done');
    expect(priority.value).toBe(priorityFails ? 'high' : 'low');
    expect(status.disabled).toBe(false);
    expect(priority.disabled).toBe(false);
    expect(container.textContent?.includes('Simulated status save failure')).toBe(statusFails);
    expect(container.textContent?.includes('Simulated priority save failure')).toBe(priorityFails);
  });

  test('loads more data into the live join after a fake request', async () => {
    // Arrange: control the simulated network.
    vi.useFakeTimers();

    // Act: request another page.
    await act(async () => button('Load more tasks').click());
    await act(async () => vi.advanceTimersByTimeAsync(700));

    // Assert: new tasks join new projects and people, not just old entities.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    await act(async () => button('Next').click());
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.textContent).toContain('20 loaded / 200 matching tasks on backend');
    expect(container.textContent).toContain('Initiative 1');
  });

  test('shows a fake request failure and supports retry', async () => {
    // Arrange: enable deliberate network failure.
    vi.useFakeTimers();

    const checkbox = container.querySelector<HTMLInputElement>('.failure-toggle input');

    if (!checkbox)
      throw new Error('Missing failure simulation control');

    await act(async () => checkbox.click());

    // Act: finish a failed request and retry with failure disabled.
    await act(async () => button('Load more tasks').click());
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Simulated network failure');
    await act(async () => checkbox.click());
    await act(async () => button('Retry loading tasks').click());
    await act(async () => vi.advanceTimersByTimeAsync(700));

    // Assert: retry loads the same page and clears the error.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(button('All statuses').textContent).toContain('200');
  });

  test('server renders loader data instead of a client fallback', async () => {
    // Arrange: loader data deliberately differs from the built-in seed.
    const state: TrackerState = {
      projects: {
        p: {
          id: 'p',
          name: 'SSR project',
          code: 'SSR',
          description: 'From GraphQL'
        }
      },
      people: {},
      tasks: {
        t: {
          id: 't',
          projectId: 'p',
          assigneeId: null,
          title: 'GraphQL server task',
          status: 'todo',
          priority: 'high'
        }
      },
      selectedProjectId: null,
      statusFilter: 'all',
      request: { status: 'complete' },
      result: {
        loadedPages: 1,
        query: {
          projectId: null,
          status: 'all',
          search: '',
          assigneeId: '',
          sort: 'id'
        },
        ids: ['t'],
        pageInfo: { endCursor: null, hasNextPage: false },
        totalCount: 1,
        statusCounts: [{ status: 'todo', total: 1 }],
      },
      statusWrites: {},
      priorityWrites: {},
      assigneeWrites: {},
      personWrites: {},
      detailWrites: {},
      taskPreferences: {},
      scratchNotes: {},
    };
    const initial = state;

    // Act: server-render the hydrated app.
    const stream = await renderToReadableStream(<ReduxClientApp initial={initial} />);

    await stream.allReady;

    const html = await new Response(stream).text();

    // Assert: both DB joins and store values come from the request.
    expect(html).toContain('SSR project');
    expect(html).toContain('GraphQL server task');
    expect(html).toContain('Unassigned');
    expect(html).not.toContain('Atlas website');
  });

  test('hydrates server rows without refetching initial data', async () => {
    // Arrange: serialize loader data and server-render a separate store/DB scope.
    const initial = fixture();
    const stream = await renderToReadableStream(<ReduxClientApp initial={initial} />);

    await stream.allReady;

    const html = await new Response(stream).text();

    await act(async () => root.unmount());
    container.innerHTML = html;

    const recoverable = vi.fn();
    const fetcher = vi.fn();

    vi.stubGlobal('fetch', fetcher);

    // Act: hydrate in a fresh scope and dispatch a store selection afterward.
    await act(async () => {
      root = hydrateRoot(
        container,
        <ReduxClientApp initial={structuredClone(initial)} />,
        { onRecoverableError: recoverable }
      );
    });
    await act(async () => button('Next').click());

    // Assert: matching markup was reused and the hydrated store drives live queries.
    expect(recoverable).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.querySelector('tbody')?.textContent).toContain('STU-02');
    expect(container.querySelector('.scratch-notes li')).toBeNull();
    expect(container.querySelector('[aria-label="Star task STU-02"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  test(
    'shows an empty state for a project with no tasks in the selected status',
    async () => {
      // Arrange: Ideas inbox has no backend tasks.
      await act(async () => button('Ideas inbox').click());

      // Act: select the completed-task filter.
      await act(async () => button('Done').click());

      // Assert: the query respects both filters and explains the empty view.
      expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
      expect(container.textContent).toContain('No tasks match this view.');
    }
  );

  test(
    'disables fetching after the final source page while keeping ledger navigation',
    async () => {
      // Arrange: control the fake API clock.
      vi.useFakeTimers();

      // Act: load both available pages.
      for (let page = 0; page < 10; page++) {
        await act(async () => button('Load more tasks').click());
        await act(async () => vi.advanceTimersByTimeAsync(700));
      }

      // Assert: every source row is loaded, but the ledger remains paginated.
      expect(button('All statuses').textContent).toContain('200');
      expect(button('All tasks loaded').disabled).toBe(true);
      await act(async () => button('Next').click());
      await act(async () => button('Next').click());
      expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
      expect(container.textContent).toContain('Page 3 of 40');
      expect(button('Next').disabled).toBe(false);
    }
  );

  test('reconnects collections during Strict Mode effect replay', async () => {
    // Arrange: enable React's setup-cleanup-setup development cycle.
    // Act: remount the app under Strict Mode.
    await act(async () => root.render(<StrictMode><ReduxClientApp initial={fixture()} /></StrictMode>));

    // Assert: cleaned-up collections are not reused by the live queries.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
  });
});
