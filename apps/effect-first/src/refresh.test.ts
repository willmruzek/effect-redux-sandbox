import {
  Layer,
  ManagedRuntime
} from 'effect';
import {
  afterEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';

import {
  createLocalActions,
  type FetchPage,
  type Task,
  type TaskPage,
  type TrackerState
} from '@repo/project-tracker';

import { createAppStore } from './store';
import {
  loadMoreTasks,
  refreshTasks
} from './flows';

function task(id: string): Task {
  return {
    id,
    title: id,
    projectId: 'p',
    assigneeId: null,
    status: 'todo',
    priority: 'low'
  };
}

function initial(): TrackerState {
  return {
    projects: {},
    people: {},
    tasks: { old: task('old') },
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: 'idle' },
    result: {
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      ids: ['old'],
      loadedPages: 3,
      totalCount: 60,
      pageInfo: { endCursor: 'old-third', hasNextPage: true },
      statusCounts: [],
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

function page(id: string, endCursor: string | null, hasNextPage: boolean): TaskPage {
  return {
    projects: [],
    people: [],
    tasks: [task(id)],
    pageInfo: { endCursor, hasNextPage },
    totalCount: 2,
    statusCounts: [{ status: 'todo', total: 2 }],
  };
}

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function store() {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  return createAppStore(runtime, initial());
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('task refresh', () => {
  test('refresh supersedes an older pending next page', async () => {
    // Arrange: keep the old cursor request pending.
    const app = store();
    let finishPage: (value: TaskPage) => void = () => {
      throw new Error('Page request did not start.');
    };
    const pending = app.dispatch(loadMoreTasks({
      fetchPage: () => new Promise<TaskPage>((resolve) => {
        finishPage = resolve;
      }),
    }));

    // Act: refresh before the old page settles, then complete the old page.
    await app.dispatch(refreshTasks({ fetchPage: async () => page('fresh', 'fresh-cursor', true) }));
    finishPage(page('stale', null, false));
    await pending;

    // Assert: the stale page cannot alter the refreshed window or cursor.
    expect(app.getSnapshot().result.ids).toEqual(['fresh']);
    expect(app.getSnapshot().result.pageInfo.endCursor).toBe('fresh-cursor');
  });

  test('rejects a page without a cursor when it reports more pages', async () => {
    // Arrange: the next page cannot be followed despite reporting more results.
    const app = store();
    const fetchPage = vi.fn<FetchPage>(async () => page('new', null, true));

    // Act: request the next page.
    await app.dispatch(loadMoreTasks({ fetchPage }));

    // Assert: the invalid page does not alter the visible window or cursor.
    expect(app.getSnapshot().request.status).toBe('error');
    expect(app.getSnapshot().result.ids).toEqual(['old']);
    expect(app.getSnapshot().result.pageInfo.endCursor).toBe('old-third');
  });

  test('rejects a page that repeats its cursor while reporting more pages', async () => {
    // Arrange: the next page would not advance the existing cursor.
    const app = store();
    const fetchPage = vi.fn<FetchPage>(async () => page('new', 'old-third', true));

    // Act: request the next page.
    await app.dispatch(loadMoreTasks({ fetchPage }));

    // Assert: the invalid page does not alter the visible window or cursor.
    expect(app.getSnapshot().request.status).toBe('error');
    expect(app.getSnapshot().result.ids).toEqual(['old']);
    expect(app.getSnapshot().result.pageInfo.endCursor).toBe('old-third');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('retains local data when the refreshed page omits the task', async () => {
    // Arrange: independent stores start with the same remote task.
    const app = store();
    const other = store();
    const local = createLocalActions({ getState: app.getSnapshot, dispatch: app.dispatch, createId: () => 'note' });

    expect(local.setStarred({ taskId: 'old', starred: true })).toEqual({ status: 'success' });
    expect(local.addNote('Remember')).toEqual({ status: 'success' });

    // Act: replace the visible query with a page that omits the task.
    await app.dispatch(refreshTasks({ fetchPage: async () => page('fresh', null, false) }));

    // Assert: local data survives and does not leak to the other store.
    expect(app.getSnapshot().taskPreferences.old?.starred).toBe(true);
    expect(app.getSnapshot().scratchNotes.note?.text).toBe('Remember');
    expect(other.getSnapshot().taskPreferences).toEqual({});
    expect(other.getSnapshot().scratchNotes).toEqual({});
  });

  test('refreshes one page and continues from its new cursor', async () => {
    // Arrange: the visible result contains three pages from an older cursor chain.
    const app = store();
    const fetchPage = vi.fn<FetchPage>(async ({ after }) =>
      after === null ? page('fresh', 'fresh-cursor', true) : page('next', null, false));

    // Act: refresh, then explicitly load the next page.
    await app.dispatch(refreshTasks({ fetchPage }));
    await app.dispatch(loadMoreTasks({ fetchPage }));

    // Assert: refresh begins a new one-page window and normal pagination follows it.
    expect(fetchPage).toHaveBeenNthCalledWith(1, {
      after: null,
      query: initial().result.query,
      fail: false,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      after: 'fresh-cursor',
      query: initial().result.query,
      fail: false,
      mode: 'page',
      sourceMode: 'graphql',
    });
    expect(app.getSnapshot().result.ids).toEqual(['fresh', 'next']);
    expect(app.getSnapshot().result.loadedPages).toBe(2);
    expect(app.getSnapshot().pagination.cursor).toBeNull();
    expect(app.getSnapshot().pagination.exhausted).toBe(true);
  });

  test('retries a failed refresh from the first page without losing the previous window', async () => {
    // Arrange: the refresh fails after a previously loaded window.
    const app = store();
    await app.dispatch(refreshTasks({ fetchPage: async () => { throw new Error('Offline'); } }));
    expect(app.getSnapshot().result.ids).toEqual(['old']);
    expect(app.getSnapshot().pagination.cursor).toBe('old-third');

    // Act: the next-page action retries the failed refresh.
    const fetchPage = vi.fn<FetchPage>(async () => page('fresh', null, false));
    await app.dispatch(loadMoreTasks({ fetchPage }));

    // Assert: retry restarts at the first page and replaces the old window.
    expect(fetchPage).toHaveBeenCalledWith({
      after: null,
      query: initial().result.query,
      fail: false,
    });
    expect(app.getSnapshot().result.ids).toEqual(['fresh']);
    expect(app.getSnapshot().pagination.exhausted).toBe(true);
  });
});
