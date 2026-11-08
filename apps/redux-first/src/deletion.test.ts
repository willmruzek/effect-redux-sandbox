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

import type {
  Task,
  TrackerState
} from '@repo/project-tracker';
import {
  createGraphqlHandler,
  createTrackerRepository
} from '@repo/tracker-graphql/server';

import {
  createAppStore,
  deleteTask
} from './store';

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange() {
  const project = {
    id: 'p',
    name: 'Project',
    code: 'P',
    description: ''
  };
  const tasks: Task[] = [
    {
      id: 'a',
      title: 'Task A',
      projectId: 'p',
      assigneeId: null,
      status: 'todo',
      priority: 'low'
    },
    {
      id: 'b',
      title: 'Task B',
      projectId: 'p',
      assigneeId: null,
      status: 'todo',
      priority: 'low'
    },
  ];
  const initial: TrackerState = {
    projects: { p: project },
    people: {},
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: 'complete' },
    result: {
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      ids: ['a', 'b'],
      loadedPages: 1,
      totalCount: 2,
      statusCounts: [{ status: 'todo', total: 2 }],
      pageInfo: { endCursor: null, hasNextPage: false }
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
  };
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  const app = createAppStore(runtime, initial);
  const repository = createTrackerRepository({
    seed: {
      projects: [project],
      people: [],
      tasks
    }
  });
  const handler = createGraphqlHandler({ repository });
  const fetcher = vi.fn((url: string, init: RequestInit) =>
    handler(new Request(new URL(url, 'http://localhost'), init)));

  vi.stubGlobal('fetch', fetcher);

  return {
    app,
    repository,
    fetcher
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('task deletion', () => {
  test('hides a pending task and removes it after the server confirms', async () => {
    // Arrange: two tasks are visible in the normalized result.
    vi.useFakeTimers();

    const {
      app,
      repository,
      fetcher
    } = arrange();

    // Act: start deletion, then allow the server write and refresh to finish.
    const pending = app.dispatch(deleteTask({ taskId: 'a' }));

    expect(app.getState().deletions.a).toMatchObject({ status: 'saving' });
    await vi.advanceTimersByTimeAsync(700);
    await pending;

    // Assert: the row and its local request metadata are removed; the query refreshes once.
    expect(repository.read().tasks.map((task) => task.id)).toEqual(['b']);
    expect(app.getState().tasks.a).toBeUndefined();
    expect(app.getState().deletions.a).toBeUndefined();
    expect(app.getState().result.totalCount).toBe(1);
    expect(fetcher.mock.calls.filter(([, init]) => typeof init.body === 'string'
      && init.body.includes('TrackerPage'))).toHaveLength(1);
  });

  test(
    'restores visibility and exposes an error when the server rejects deletion',
    async () => {
      // Arrange: retain a visible task and its server copy.
      vi.useFakeTimers();

      const { app, repository } = arrange();

      // Act: request a deliberate server failure.
      const pending = app.dispatch(deleteTask({ taskId: 'a', fail: true }));

      await vi.advanceTimersByTimeAsync(700);
      await pending;

      // Assert: optimistic hiding rolls back without changing the server.
      expect(repository.read().tasks.map((task) => task.id)).toEqual(['a', 'b']);
      expect(app.getState().tasks.a?.title).toBe('Task A');
      expect(app.getState().deletions.a).toMatchObject({ status: 'error' });
    }
  );
});
