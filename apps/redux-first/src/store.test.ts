import {
  Effect,
  Layer,
  ManagedRuntime
} from 'effect';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi
} from 'vitest';

import {
  createAppStore as makeAppStore,
  createTask,
  deleteTask,
  loadPeople,
  loadMoreTasks,
  saveTaskDetails,
  saveStatus,
  savePriority,
  saveAssignee,
  renamePerson,
  selectSourceMode,
  trackerActions
} from './store';
import { ReduxStore } from './reduxStore';
import { TrackerApiStore } from './trackerApiStore';
import { createTestPageTransport } from './testPageTransport';
import type { TrackerApiTransportOptions } from './api';

import { createTrackerDatabase } from '@repo/project-tracker/database';
import { createLocalActions } from '@repo/project-tracker';
import type {
  FieldWrite,
  TaskPriority,
  TaskStatus,
  TaskPage,
  FetchPage,
  TrackerState,
  TrackerSourceMode
} from '@repo/project-tracker';
import { fetchTaskPage } from '@repo/tracker-graphql/client';
import {
  createGraphqlHandler,
  createRestHandler,
  createTrackerRepository
} from '@repo/tracker-graphql/server';

let handleApiRequest: (request: Request) => Promise<Response>;

let handleRestRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  const repository = createTrackerRepository();

  handleApiRequest = createGraphqlHandler({ repository });
  handleRestRequest = createRestHandler({ repository });
});

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function createAppStore(
  initial?: TrackerState,
  fetchPage?: FetchPage,
  transportOptions: TrackerApiTransportOptions = {},
) {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  return makeAppStore(
    runtime,
    initial,
    {
      ...transportOptions,
      ...(fetchPage ? createTestPageTransport(fetchPage) : {}),
    },
  );
}

function getTrackerServices(store: ReturnType<typeof makeAppStore<never, never>>) {
  return store.dispatch(Effect.gen(function*() {
    return yield* ReduxStore;
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const request = new Request(new URL(url, 'http://localhost'), init);

    return new URL(request.url).pathname === '/graphql'
      ? handleApiRequest(request)
      : handleRestRequest(request);
  }));
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Redux project tracker', () => {
  test('loads mixed-mode people through the configured REST API', async () => {
    // Arrange: configure a REST transport that uses the shared test handler.
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const restFetcher = vi.fn((url: string, init: RequestInit) => {
      const request = new Request(new URL(url, 'http://localhost'), init);

      return handleRestRequest(request);
    });
    const store = makeAppStore(runtime, undefined, { restFetcher });

    // Act: select mixed mode, which loads people from REST.
    await store.dispatch(selectSourceMode('mixed'));

    // Assert: the centrally configured REST transport handles the people route.
    expect(restFetcher).toHaveBeenCalledWith(
      '/api/people',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(store.getState().peopleRequest.status).toBe('complete');
    expect(store.getState().people.mara).toBeDefined();
  });

  test('settles a shared people request after mixed mode is reselected', async () => {
    // Arrange: keep the configured REST request pending until a second caller joins.
    let finishPeople: (response: Response) => void = () => {
      throw new Error('People request did not start.');
    };
    let markPeopleStarted: () => void = () => {
      throw new Error('People request start signal was not initialized.');
    };
    const peopleStarted = new Promise<void>((resolve) => {
      markPeopleStarted = resolve;
    });
    const restFetcher = vi.fn(() => new Promise<Response>((resolve) => {
      finishPeople = resolve;
      markPeopleStarted();
    }));
    const store = createAppStore(undefined, undefined, { restFetcher });
    const firstLoad = store.dispatch(selectSourceMode('mixed'));

    await peopleStarted;

    // Act: leave and re-enter mixed mode while the people query is still running.
    store.dispatch(trackerActions.sourceModeSelected('graphql'));
    store.dispatch(trackerActions.sourceModeSelected('mixed'));
    const joinedLoad = store.dispatch(loadPeople());
    finishPeople(Response.json([{
      id: 'mara',
      name: 'Mara Voss',
      initials: 'MV',
      role: 'Designer',
    }]));
    await Promise.all([firstLoad, joinedLoad]);

    // Assert: the joined response still completes the app-owned people state.
    expect(restFetcher).toHaveBeenCalledOnce();
    expect(store.getState().peopleRequest.status).toBe('complete');
    expect(store.getState().people.mara?.name).toBe('Mara Voss');
  });

  test('records mixed-mode people failures from the configured REST API', async () => {
    // Arrange: make the configured people endpoint return an explicit error.
    const restFetcher = vi.fn(async () => Response.json(
      { error: 'People unavailable' },
      { status: 503 },
    ));
    const store = createAppStore(undefined, undefined, { restFetcher });

    // Act: select mixed mode, which loads people from REST.
    await store.dispatch(selectSourceMode('mixed'));

    // Assert: the REST operation publishes its failure through people state.
    expect(store.getState().peopleRequest).toMatchObject({
      status: 'error',
      error: 'REST request failed (503). People unavailable',
    });
  });

  test('invalidates the hydrated task chain after an injected status save without refreshing', async () => {
    // Arrange: the initial task page is explicitly seeded fresh.
    const store = createAppStore();
    const services = await getTrackerServices(store);
    const identity = store.getState().pagination.identity;
    const persist = vi.fn(async ({ taskId, value }: FieldWrite<TaskStatus>) => ({ taskId, value }));

    expect(services.taskPagination.selectFreshness(store.getState(), identity)).toBe('fresh');

    // Act: save a task through the injected persistence callback.
    await store.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done', persist }));

    // Assert: the chain is stale without an automatic refresh.
    expect(services.taskPagination.selectFreshness(store.getState(), identity)).toBe('stale');
    expect(store.getState().tasks['ATL-01']?.status).toBe('done');
    expect(persist).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('discards a page whose newly discovered task was invalidated while loading', async () => {
    // Arrange: keep a generated page request pending.
    let finish: (page: TaskPage) => void = () => { throw new Error('Page did not start.'); };
    let markStarted: () => void = () => { throw new Error('Start signal was not initialized.'); };
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchPage: FetchPage = () => new Promise<TaskPage>((resolve) => {
      finish = resolve;
      markStarted();
    });
    const store = createAppStore(undefined, fetchPage);
    const services = await getTrackerServices(store);
    const before = store.getState();
    const read = store.dispatch(loadMoreTasks());
    await started;

    // Act: invalidate an entity that is only known when the page arrives.
    store.dispatch(services.invalidation.actions.invalidate({ tags: [{ type: 'Task', id: 'new-task' }] }));
    finish({
      projects: [],
      people: [],
      tasks: [{ id: 'new-task', projectId: 'atlas', assigneeId: null, title: 'Old', status: 'todo', priority: 'low' }],
      pageInfo: { endCursor: 'next', hasNextPage: true },
      totalCount: 1,
      statusCounts: [],
    });
    await read;

    // Assert: the old window remains visible and the chain requires refresh.
    const after = store.getState();
    expect(after.tasks['new-task']).toBeUndefined();
    expect(after.result).toEqual(before.result);
    expect(after.pagination.cursor).toBe(before.pagination.cursor);
    expect(after.request.status).toBe('idle');
    expect(services.taskPagination.selectFreshness(after, before.pagination.identity)).toBe('stale');
    expect(Object.values(after.api.requests).some((request) => request.status === 'superseded')).toBe(true);
  });

  test.each(['rest', 'mixed'] satisfies readonly TrackerSourceMode[])(
    'invalidates the %s task chain when an assigned person is renamed',
    async (sourceMode) => {
      // Arrange: load the current source mode and its assigned people.
      const store = createAppStore();
      const services = await getTrackerServices(store);
      await store.dispatch(selectSourceMode(sourceMode));
      const identity = store.getState().pagination.identity;
      const requestsBeforeRename = vi.mocked(fetch).mock.calls.length;

      expect(services.taskPagination.selectFreshness(store.getState(), identity)).toBe('fresh');

      // Act: rename a person without refreshing task pages.
      await store.dispatch(renamePerson({ personId: 'mara', name: 'Mara Sato' }));

      // Assert: the visible chain is stale across transport modes.
      expect(store.getState().people.mara?.name).toBe('Mara Sato');
      expect(services.taskPagination.selectFreshness(store.getState(), identity)).toBe('stale');
      expect(vi.mocked(fetch).mock.calls.length).toBe(requestsBeforeRename + 1);
    },
  );

  describe.each(['graphql', 'rest', 'mixed'] satisfies readonly TrackerSourceMode[])('domain validation in %s mode', (sourceMode) => {
    test.each([
      {
        operation: 'status',
        run: () => saveStatus({ taskId: 'missing', value: 'done' }),
      },
      {
        operation: 'priority',
        run: () => savePriority({ taskId: 'missing', value: 'high' }),
      },
      {
        operation: 'assignee',
        run: () => saveAssignee({ taskId: 'missing', value: null }),
      },
      {
        operation: 'detail',
        run: () => saveTaskDetails({
          taskId: 'missing',
          values: { title: 'Missing', description: null },
        }),
      },
      {
        operation: 'deletion',
        run: () => deleteTask({ taskId: 'missing' }),
      },
    ])('rejects $operation before starting transport or optimism', async ({ run }) => {
      // Arrange: choose a mode without starting its loading workflow.
      const store = createAppStore();

      store.dispatch(trackerActions.sourceModeSelected(sourceMode));

      const before = store.getState();

      // Act: request a write for a missing task.
      const result = store.dispatch(run());

      // Assert: the failure is visible and no write starts.
      await expect(result).rejects.toThrow('Unknown task: missing.');
      expect(fetch).not.toHaveBeenCalled();
      expect(store.getState()).toBe(before);
    });
  });

  test('loads REST task results when the REST example is selected', async () => {
    // Arrange: the app store starts on the GraphQL example.
    const store = createAppStore();

    // Act: switch the task transport to REST.
    await store.dispatch(selectSourceMode('rest'));

    // Assert: the selected mode and REST response become the active result.
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/tracker\?/),
      expect.any(Object)
    );
    expect(store.getState().sourceMode).toBe('rest');
    expect(store.getState().result.ids).toContain('ATL-01');
  });

  test('ignores a GraphQL page that completes after switching to REST', async () => {
    // Arrange: keep an older GraphQL response pending while REST becomes active.
    let resolveStalePage: ((page: TaskPage) => void) | undefined;
    const stalePage = new Promise<TaskPage>((resolve) => {
      resolveStalePage = resolve;
    });
    const store = createAppStore(undefined, async () => stalePage);
    const staleRead = store.dispatch(loadMoreTasks({ query: { search: 'stale' } }));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    if (!resolveStalePage)
      throw new Error('The stale GraphQL read did not start.');

    // Act: load REST results, then let the older GraphQL read finish last.
    await store.dispatch(selectSourceMode('rest'));

    const restIds = store.getState().result.ids;

    resolveStalePage({
      projects: [],
      people: [],
      tasks: [{
        id: 'stale-task',
        projectId: 'atlas',
        assigneeId: null,
        title: 'Stale',
        status: 'todo',
        priority: 'low'
      }],
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: 1,
      statusCounts: [{ status: 'todo', total: 1 }],
    });
    await staleRead;

    // Assert: request ownership keeps the selected REST result intact.
    expect(store.getState().sourceMode).toBe('rest');
    expect(store.getState().result.ids).toEqual(restIds);
    expect(store.getState().result.ids).not.toContain('stale-task');
  });

  test(
    'uses REST for people and GraphQL for task reassignment in mixed mode',
    async () => {
      // Arrange: enter mixed mode, which loads tasks and people independently.
      vi.useFakeTimers();

      const store = createAppStore();

      await store.dispatch(selectSourceMode('mixed'));

      // Act: rename a REST-owned person and reassign a GraphQL-owned task.
      await store.dispatch(renamePerson({ personId: 'mara', name: 'Mara Sato' }));

      const reassignment = store.dispatch(saveAssignee({ taskId: 'ATL-01', value: 'eli' }));

      await vi.advanceTimersByTimeAsync(700);
      await reassignment;

      // Assert: the normalized join reflects the rename and task owner, with each write on its owner transport.
      expect(store.getState().people.mara?.name).toBe('Mara Sato');
      expect(store.getState().tasks['ATL-01']?.assigneeId).toBe('eli');
      expect(fetch).toHaveBeenCalledWith(
        '/api/people/mara',
        expect.objectContaining({ method: 'PATCH' })
      );
      expect(fetch).toHaveBeenCalledWith('/graphql', expect.objectContaining({
        body: expect.stringContaining('UpdateTask'),
      }));
    }
  );

  test(
    'persists REST task edits and details through REST when REST is selected',
    async () => {
      // Arrange: select REST and begin two field-scoped task writes.
      vi.useFakeTimers();

      const store = createAppStore();

      await store.dispatch(selectSourceMode('rest'));

      const status = store.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done' }));

      await vi.advanceTimersByTimeAsync(700);
      await status;

      const detail = store.dispatch(saveTaskDetails({
        taskId: 'ATL-01',
        values: { title: 'REST-edited task', description: 'Updated through REST' },
      }));

      await vi.advanceTimersByTimeAsync(700);
      await detail;

      // Assert: both writes reach REST and remain reflected in normalized state.
      expect(store.getState().tasks['ATL-01']).toMatchObject({
        status: 'done',
        title: 'REST-edited task',
        description: 'Updated through REST',
      });
      expect(fetch).toHaveBeenCalledWith(
        '/api/tasks/ATL-01',
        expect.objectContaining({ method: 'PATCH' })
      );
    }
  );

  test('creates and deletes tasks through REST in the REST example', async () => {
    // Arrange: select REST and prepare a valid task.
    vi.useFakeTimers();

    const store = createAppStore();

    await store.dispatch(selectSourceMode('rest'));

    // Act: create the task, then remove its server-assigned entity.
    const creation = store.dispatch(createTask({
      kind: 'new',
      input: {
        title: 'REST-created task',
        status: 'todo',
        priority: 'low',
        projectId: 'atlas',
        assigneeId: null
      },
    }));

    await vi.advanceTimersByTimeAsync(700);
    await creation;

    const created = Object.values(store.getState().tasks).find((task) => task.title === 'REST-created task');

    if (!created)
      throw new Error('REST-created task was not normalized.');

    const deletion = store.dispatch(deleteTask({ taskId: created.id }));

    await vi.advanceTimersByTimeAsync(700);
    await deletion;

    // Assert: REST handles both task lifecycle operations.
    expect(store.getState().tasks[created.id]).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetch).toHaveBeenCalledWith(
      `/api/tasks/${created.id}`,
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  test('allows a later client to overwrite a previously saved field', async () => {
    // Arrange: both clients begin with the same task value.
    vi.useFakeTimers();

    const first = createAppStore();
    const second = createAppStore();
    const saved = first.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done' }));

    await vi.advanceTimersByTimeAsync(700);
    await saved;

    // Act: the second client saves a later status.
    const stale = second.dispatch(saveStatus({ taskId: 'ATL-01', value: 'todo' }));

    await vi.advanceTimersByTimeAsync(700);
    await stale;

    // Assert: plain CRUD accepts the later value without a conflict token.
    expect(second.getState().statusWrites['ATL-01']).toBeUndefined();
    expect(second.getState().tasks['ATL-01']?.status).toBe('todo');
  });

  test('persists status through GraphQL for a fresh client', async () => {
    // Arrange: the server repository outlives this store.
    vi.useFakeTimers();

    const store = createAppStore();

    // Act: save and make a new initial-data request.
    const pending = store.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done' }));

    await vi.advanceTimersByTimeAsync(700);
    await pending;

    const page = await fetchTaskPage({
      after: null,
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      fail: false,
    });

    // Assert: a fresh client sees the authoritative persisted field.
    expect(page.tasks.find((task) => task.id === 'ATL-01')?.status).toBe('done');
    expect(fetch).toHaveBeenCalledWith('/graphql', expect.objectContaining({
      body: expect.stringContaining('UpdateTask'),
    }));
  });

  test('does not change server data on priority failure', async () => {
    // Arrange: deliberately fail the server mutation.
    vi.useFakeTimers();

    const store = createAppStore();

    // Act: settle the failed optimistic write and read the backend.
    const pending = store.dispatch(savePriority({
      taskId: 'ATL-01',
      value: 'low',
      fail: true
    }));

    await vi.advanceTimersByTimeAsync(700);
    await pending;

    const page = await fetchTaskPage({
      after: null,
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      fail: false,
    });

    // Assert: both rollback and persistence retain the original priority.
    expect(store.getState().tasks['ATL-01']?.priority).toBe('high');
    expect(page.tasks.find((task) => task.id === 'ATL-01')?.priority).toBe('high');
  });

  test(
    'retains only normalized entities and request metadata after GraphQL loading',
    async () => {
      // Arrange: the Redux store uses a real GraphQL transport boundary.
      const store = createAppStore();

      // Act: dispatch a cursor page through the generated API.
      await store.dispatch(loadMoreTasks());

      // Assert: request records never contain an operation response/document cache.
      expect(store.getState().result.ids).toHaveLength(20);
      expect(store.getState().tasks['ATL-01']?.id).toBe('ATL-01');

      const requests = Object.values(store.getState().api.requests);

      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({ status: 'succeeded', requestId: expect.any(String) });
    }
  );

  test('merges pending query intent and ignores a superseded failure', async () => {
    // Arrange: the project request stays pending when another filter changes.
    let reject: (error: Error) => void = () => {
      throw new Error('Request did not start');
    };
    const fetchPage = vi.fn<FetchPage>(async ({ query }) => {
      if (query.status === 'done')
        return {
          projects: [],
          people: [],
          tasks: [],
          pageInfo: { endCursor: null, hasNextPage: false },
          totalCount: 0,
          statusCounts: [],
        };

      return new Promise<TaskPage>((_resolve, fail) => {
        reject = fail;
      });
    });
    const store = createAppStore(undefined, fetchPage);
    const old = store.dispatch(loadMoreTasks({ query: { projectId: 'atlas' } }));

    // Act: change status before the project request fails.
    await store.dispatch(loadMoreTasks({ query: { status: 'done' } }));

    const current = store.getState();

    reject(new Error('Superseded HTTP failure'));
    await old;

    // Assert: the newest query includes both intentions and owns its result.
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      after: null,
      query: expect.objectContaining({ projectId: 'atlas', status: 'done' }),
    }));
    expect({ ...store.getState(), invalidation: current.invalidation }).toEqual(current);
    expect(store.getState().request.status).toBe('complete');
  });

  test('ignores a late response from a superseded backend query', async () => {
    // Arrange: the first request waits at the HTTP boundary.
    let resolve: (page: TaskPage) => void = () => {
      throw new Error('Request did not start');
    };
    const page: TaskPage = {
      projects: [],
      people: [],
      tasks: [],
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: 0,
      statusCounts: []
    };
    const fetchPage: FetchPage = ({ query }) => query.search
      ? Promise.resolve(page)
      : new Promise<TaskPage>((complete) => {
        resolve = complete;
      });
    const store = createAppStore(undefined, fetchPage);
    const old = store.dispatch(loadMoreTasks());

    // Act: replace the query, then let its earlier request finish.
    await store.dispatch(loadMoreTasks({ query: { search: 'new query' } }));

    const current = store.getState();

    resolve({ ...page, totalCount: 999 });
    await old;

    // Assert: stale pages cannot alter either entities or cursor ownership.
    expect({ ...store.getState(), invalidation: current.invalidation }).toEqual(current);
    expect(store.getState().result.query.search).toBe('new query');
    expect(store.getState().result.totalCount).toBe(0);
  });

  test('retries the same backend cursor after a failed append', async () => {
    // Arrange: obtain a real first-page cursor.
    let useTransport = false;
    let fail = true;
    const fetchPage = vi.fn<FetchPage>(async (input) => {
      if (!useTransport)
        return fetchTaskPage(input);
      if (fail)
        throw new Error('Temporary HTTP failure');

      return fetchTaskPage(input);
    });
    const store = createAppStore(undefined, fetchPage);

    await store.dispatch(loadMoreTasks());

    const cursor = store.getState().result.pageInfo.endCursor;
    fetchPage.mockClear();

    // Act: fail once, then retry with the same workflow.
    useTransport = true;
    await store.dispatch(loadMoreTasks());
    expect(store.getState().result.ids).toHaveLength(20);
    fail = false;
    await store.dispatch(loadMoreTasks());

    // Assert: cursor advances only after success, with no skipped records.
    expect(fetchPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ after: cursor })
    );
    expect(fetchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: cursor })
    );
    expect(store.getState().result.ids).toHaveLength(40);
  });

  test(
    'ignores stale priority settlement actions while another request owns the field',
    async () => {
      // Arrange: a pending request owns the optimistic priority.
      const store = createAppStore();
      const services = await getTrackerServices(store);

      store.dispatch(services.operations.priority.actions.started({
        taskId: 'ATL-01',
        value: 'low',
        requestId: 'current'
      }));

      const pending = store.getState();

      // Act: old confirmation and failure actions arrive.
      store.dispatch(services.operations.priority.actions.confirmed({
        taskId: 'ATL-01',
        value: 'low',
        result: 'medium',
        requestId: 'old'
      }));
      store.dispatch(services.operations.priority.actions.failed({
        taskId: 'ATL-01',
        value: 'low',
        requestId: 'old',
        error: 'Old failure'
      }));

      // Assert: neither stale action changes the newer optimistic field.
      expect(store.getState()).toBe(pending);
    }
  );

  test.each([
    { statusFails: false, priorityFails: false },
    { statusFails: true, priorityFails: false },
    { statusFails: false, priorityFails: true },
    { statusFails: true, priorityFails: true },
  ])('projects both store-owned writes while priority is still pending: %j', async ({ statusFails, priorityFails }) => {
    // Arrange: priority starts first and its API responds later than status.
    vi.useFakeTimers();

    const store = createAppStore();
    const database = createTrackerDatabase({
      getSnapshot: store.getState, subscribe: store.subscribe,
    });

    await database.tasks.preload();

    const persist = async ({ taskId, value }: FieldWrite<TaskStatus>) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      if (statusFails)
        throw new Error('Status failed early');

      return { taskId, value };
    };
    const persistPriority = async ({
      taskId,
      value,
      fail
    }: FieldWrite<TaskPriority>) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));

      if (fail)
        throw new Error('Priority failed');

      return { taskId, value };
    };
    const priority = store.dispatch(savePriority({
      taskId: 'ATL-01',
      value: 'low',
      fail: priorityFails,
      persist: persistPriority,
    }));

    // Act: settle status before the store settles priority.
    const status = store.dispatch(saveStatus({
      taskId: 'ATL-01',
      value: 'done',
      persist
    }));

    await vi.advanceTimersByTimeAsync(200);
    await status;

    // Assert: DB mirrors both store fields, including pending priority.
    try {
      expect(database.tasks.get('ATL-01')?.status).toBe(statusFails ? 'in-progress' : 'done');
      expect(database.tasks.get('ATL-01')?.priority).toBe('low');
      expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
      expect(store.getState().priorityWrites['ATL-01']?.status).toBe('saving');
      await vi.advanceTimersByTimeAsync(500);
      await priority;
      expect(database.tasks.get('ATL-01')?.status).toBe(statusFails ? 'in-progress' : 'done');
      expect(database.tasks.get('ATL-01')?.priority).toBe(priorityFails ? 'high' : 'low');
      expect(store.getState().tasks['ATL-01']?.priority).toBe(priorityFails ? 'high' : 'low');
      expect(store.getState().priorityWrites['ATL-01']?.status).toBe(priorityFails ? 'error' : undefined);
    } finally {
      await database.dispose();
    }
  });

  test('preserves local preferences when a remote status write rolls back', async () => {
    // Arrange: begin a failing remote write.
    vi.useFakeTimers();
    const store = createAppStore();
    const original = store.getState().tasks['ATL-01']?.status;
    const pending = store.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done', fail: true }));
    const local = createLocalActions({ getState: store.getState, dispatch: store.dispatch, createId: () => 'note' });

    expect(local.setStarred({ taskId: 'ATL-01', starred: true })).toEqual({ status: 'success' });

    // Act: settle the rejected remote write.
    await vi.advanceTimersByTimeAsync(700);
    await pending;

    // Assert: only the remote field rolled back.
    expect(store.getState().tasks['ATL-01']?.status).toBe(original);
    expect(store.getState().taskPreferences['ATL-01']).toEqual({ taskId: 'ATL-01', starred: true });
  });

  test.each([false, true])(
    'owns status optimism and field-scoped settlement (fail=%s)',
    async (fail) => {
      // Arrange: independent status and priority writes target one task.
      vi.useFakeTimers();

      const store = createAppStore();
      const original = store.getState().tasks['ATL-01']?.status;

      // Act: begin status optimism, then confirm a separate priority change.
      const status = store.dispatch(saveStatus({
        taskId: 'ATL-01',
        value: 'done',
        fail
      }));

      expect(store.getState().tasks['ATL-01']?.status).toBe('done');
      expect(store.getState().statusWrites['ATL-01']?.status).toBe('saving');

      const priority = store.dispatch(savePriority({ taskId: 'ATL-01', value: 'low' }));

      await vi.advanceTimersByTimeAsync(700);
      await Promise.all([status, priority]);

      // Assert: status rollback cannot erase confirmed priority.
      expect(store.getState().tasks['ATL-01']?.status).toBe(fail ? original : 'done');
      expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
      expect(store.getState().statusWrites['ATL-01']?.status).toBe(fail ? 'error' : undefined);

      if (fail) {
        const retry = store.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done' }));

        await vi.advanceTimersByTimeAsync(700);
        await retry;
        expect(store.getState().tasks['ATL-01']?.status).toBe('done');
        expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
        expect(store.getState().statusWrites['ATL-01']).toBeUndefined();
      }
    }
  );

  test(
    'rejects repeated status edits while the first save owns the field',
    async () => {
      // Arrange: an API boundary whose calls can be counted.
      vi.useFakeTimers();

      const store = createAppStore();
      const persist = vi.fn(async (): Promise<{
        taskId: string;
        value: 'done'
      }> => ({ taskId: 'ATL-01', value: 'done' }));

      // Act: dispatch two edits before the first settles.
      const first = store.dispatch(saveStatus({
        taskId: 'ATL-01',
        value: 'done',
        persist
      }));

      await expect(store.dispatch(saveStatus({
        taskId: 'ATL-01',
        value: 'todo',
        persist
      })))
        .rejects.toThrow('Status is already saving for ATL-01.');
      await first;

      // Assert: the repeated write never reaches persistence.
      expect(persist).toHaveBeenCalledTimes(1);
      expect(store.getState().tasks['ATL-01']?.status).toBe('done');
    }
  );

  test.each([false, true])(
    'owns priority optimism and rollback in the store (fail=%s)',
    async (fail) => {
      // Arrange: observe store state before the fake API settles.
      vi.useFakeTimers();

      const store = createAppStore();

      // Act: start but do not finish the priority request.
      const request = store.dispatch(savePriority({
        taskId: 'ATL-01',
        value: 'low',
        fail
      }));

      expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
      expect(store.getState().priorityWrites['ATL-01']?.status).toBe('saving');
      await vi.advanceTimersByTimeAsync(700);
      await request;

      // Assert: failure rolls back only priority and a retry clears its error.
      expect(store.getState().tasks['ATL-01']?.priority).toBe(fail ? 'high' : 'low');
      expect(store.getState().priorityWrites['ATL-01']?.status).toBe(fail ? 'error' : undefined);

      const retry = store.dispatch(savePriority({ taskId: 'ATL-01', value: 'low' }));

      await vi.advanceTimersByTimeAsync(700);
      await retry;
      expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
      expect(store.getState().priorityWrites['ATL-01']).toBeUndefined();
    }
  );

  test('rejects repeated priority edits at the store boundary', async () => {
    // Arrange: count persistence calls while the first write owns priority.
    const store = createAppStore();
    const persist = vi.fn(async (): Promise<{
      taskId: string;
      value: 'low'
    }> => ({ taskId: 'ATL-01', value: 'low' }));

    // Act: dispatch two edits without waiting for the first.
    const first = store.dispatch(savePriority({
      taskId: 'ATL-01',
      value: 'low',
      persist
    }));

    await expect(store.dispatch(savePriority({
      taskId: 'ATL-01',
      value: 'medium',
      persist
    })))
      .rejects.toThrow('Priority is already saving for ATL-01.');
    await first;

    // Assert: only the owning write reaches persistence.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.getState().tasks['ATL-01']?.priority).toBe('low');
  });

  test('creates a lazy loading Effect requiring the receiving Redux store', () => {
    // Arrange: observe the global transport boundary.

    // Act: describe the request without dispatching it.
    const program = loadMoreTasks();

    // Assert: constructing the action is lazy and retains its store requirement.
    expect(Effect.isEffect(program)).toBe(true);
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, Error, ReduxStore | TrackerApiStore>
    >();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('seeds independent relational state for each client', () => {
    // Arrange: create two independent stores.
    const first = createAppStore();
    const second = createAppStore();

    // Act: change one client's selection.
    first.dispatch(trackerActions.projectSelected('atlas'));

    // Assert: only that client's UI state changes.
    expect(first.getState().selectedProjectId).toBe('atlas');
    expect(second.getState().selectedProjectId).toBeNull();
    expect(Object.keys(first.getState().tasks)).toHaveLength(6);
  });

  test('loads and merges more related data through an Effect', async () => {
    // Arrange: control the simulated API clock.
    vi.useFakeTimers();

    const store = createAppStore();

    // Act: start loading without awaiting and then finish the network delay.
    const request = store.dispatch(loadMoreTasks());

    expect(store.getState().request.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(700);
    await request;

    // Assert: existing entities survive and new foreign keys resolve.
    const state = store.getState();

    expect(state.result.ids).toHaveLength(20);
    expect(Object.keys(state.people)).toHaveLength(20);
    expect(Object.keys(state.projects)).toHaveLength(12);
    expect(state.result.pageInfo.endCursor).not.toBeNull();
    expect(state.request).toEqual({ status: 'idle' });
  });

  test('ignores a duplicate load while a request is pending', async () => {
    // Arrange: issue both requests before the fake network responds.
    vi.useFakeTimers();

    const store = createAppStore();

    // Act: dispatch two concurrent requests.
    const first = store.dispatch(loadMoreTasks());
    const second = store.dispatch(loadMoreTasks());

    await vi.advanceTimersByTimeAsync(700);
    await Promise.all([first, second]);

    // Assert: exactly one page is consumed.
    expect(store.getState().result.ids).toHaveLength(20);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('reports a failed request and retries the same page', async () => {
    // Arrange: start a deliberate failure.
    vi.useFakeTimers();

    const store = createAppStore();
    const failed = store.dispatch(loadMoreTasks({ fail: true }));

    // Act: finish the failed request, then retry.
    await vi.advanceTimersByTimeAsync(700);
    await failed;
    expect(store.getState().request).toMatchObject({
      status: 'error',
      after: null,
      sourceMode: 'graphql',
      error: 'Simulated network failure. Retry this page.',
    });

    const retry = store.dispatch(loadMoreTasks());

    await vi.advanceTimersByTimeAsync(700);
    await retry;

    // Assert: retry adds the first page without losing the original tasks.
    expect(store.getState().result.ids).toHaveLength(20);
    expect(store.getState().request).toEqual({ status: 'idle' });
  });

  test('stops loading when all pages are exhausted', async () => {
    // Arrange: control two sequential fake responses.
    vi.useFakeTimers();

    const store = createAppStore();

    for (let page = 0; page < 10; page++) {
      const request = store.dispatch(loadMoreTasks());

      await vi.advanceTimersByTimeAsync(700);
      await request;
    }

    // Act: attempt an additional request after exhaustion.
    await store.dispatch(loadMoreTasks());

    // Assert: no duplicate tasks or extra request is created.
    expect(store.getState().result.ids).toHaveLength(200);
    expect(store.getState().request).toEqual({ status: 'complete' });
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  test('filters tasks without changing entity records', () => {
    // Arrange: create a fresh tracker.
    const store = createAppStore();
    const before = store.getState();

    // Act: change the read-only view's filter.
    store.dispatch(trackerActions.statusSelected('done'));

    // Assert: only UI state changes, not the source entities.
    expect(store.getState().statusFilter).toBe('done');
    expect(store.getState().tasks).toBe(before.tasks);
    expect(store.getState().people).toBe(before.people);
    expect(store.getState().projects).toBe(before.projects);
  });

  test('provides live state and nested dispatch to Effects', async () => {
    // Arrange: nested work reads the same store as its caller.
    const store = createAppStore();
    const nested = Effect.gen(function*() {
      const redux = yield* ReduxStore;

      yield* redux.dispatch(trackerActions.projectSelected('atlas'));

      return (yield* redux.getState).selectedProjectId;
    });
    const program = Effect.gen(function*() {
      const redux = yield* ReduxStore;

      return yield* redux.dispatch(nested);
    });

    // Act: run the store-dependent Effect.
    const result = await store.dispatch(program);

    // Assert: nested dispatch reaches the receiving store.
    expect(result).toBe('atlas');
  });

  test('propagates Effect failures', async () => {
    // Arrange: a typed failure crosses the Promise boundary.
    const store = createAppStore();
    const error = new Error('Effect failed');

    // Act: dispatch the failing program.
    const result = store.dispatch(Effect.fail(error));

    // Assert: the caller receives the original error.
    await expect(result).rejects.toBe(error);
  });
});
