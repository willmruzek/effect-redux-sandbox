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
  createGraphqlHandler,
  createTrackerRepository
} from '@repo/tracker-graphql/server';

import { createAppStore } from './store';
import { createTask } from './flows';

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange() {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  const app = createAppStore(runtime);
  const repository = createTrackerRepository();
  const handler = createGraphqlHandler({ repository });
  const transport = (url: string, init: RequestInit) =>
    handler(new Request(new URL(url, 'http://localhost'), init));
  const fetcher = vi.fn(transport);

  vi.stubGlobal('fetch', fetcher);

  const input = {
    title: 'Created task',
    projectId: 'atlas',
    assigneeId: null,
    status: 'todo',
    priority: 'low',
  } satisfies Extract<Parameters<typeof createTask>[0], { kind: 'new' }>['input'];

  return {
    app,
    input,
    repository,
    fetcher,
    transport
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('task creation', () => {
  test('replaces its temporary entity with the server-created task', async () => {
    // Arrange: the creation is submitted to the real GraphQL repository.
    vi.useFakeTimers();

    const {
      app,
      input,
      repository
    } = arrange();

    // Act: finish the create request and its first-page refresh.
    const pending = app.dispatch(createTask({ kind: 'new', input }));
    const operationId = Object.keys(app.getSnapshot().creations)[0];

    if (!operationId)
      throw new Error('Missing local creation.');

    await vi.advanceTimersByTimeAsync(700);
    await pending;

    // Assert: the server entity replaces the temporary record.
    const creation = app.getSnapshot().creations[operationId];

    if (!creation || creation.status !== 'created')
      throw new Error('Creation was not confirmed.');

    expect(app.getSnapshot().tasks[`temp:${operationId}`]).toBeUndefined();
    expect(app.getSnapshot().tasks[creation.taskId]).toMatchObject(input);
    expect(repository.read().tasks).toContainEqual(app.getSnapshot().tasks[creation.taskId]);
  });

  test('retains a failed draft for an explicit retry', async () => {
    // Arrange: request a deliberate server failure.
    vi.useFakeTimers();

    const {
      app,
      input,
      repository
    } = arrange();
    const first = app.dispatch(createTask({
      kind: 'new',
      input,
      fail: true
    }));
    const operationId = Object.keys(app.getSnapshot().creations)[0];

    if (!operationId)
      throw new Error('Missing local creation.');

    await vi.advanceTimersByTimeAsync(700);
    await first;

    // Act: retry the draft after the request is known to have failed.
    const retry = app.dispatch(createTask({ kind: 'retry', operationId }));

    await vi.advanceTimersByTimeAsync(700);
    await retry;

    // Assert: one server task is created and the local draft is confirmed.
    expect(repository.read().tasks.filter((task) => task.title === input.title)).toHaveLength(1);
    expect(app.getSnapshot().creations[operationId]?.status).toBe('created');
  });

  test('may create a duplicate when retrying an uncertain server commit', async () => {
    // Arrange: the first create commits, but its response is lost.
    vi.useFakeTimers();

    const {
      app,
      input,
      repository,
      fetcher,
      transport
    } = arrange();
    let loseResponse = true;

    fetcher.mockImplementation(async (url, init) => {
      const response = await transport(url, init);

      if (loseResponse && typeof init.body === 'string' && init.body.includes('CreateTask')) {
        loseResponse = false;
        throw new Error('Response lost.');
      }

      return response;
    });

    const first = app.dispatch(createTask({ kind: 'new', input }));
    const operationId = Object.keys(app.getSnapshot().creations)[0];

    if (!operationId)
      throw new Error('Missing local creation.');

    await vi.advanceTimersByTimeAsync(700);
    await first;

    // Act: retry the uncertain request; the server treats it as a new create.
    const retry = app.dispatch(createTask({ kind: 'retry', operationId }));

    await vi.advanceTimersByTimeAsync(700);
    await retry;

    // Assert: there is no server receipt/deduplication contract.
    expect(repository.read().tasks.filter((task) => task.title === input.title)).toHaveLength(2);
    expect(app.getSnapshot().creations[operationId]?.status).toBe('created');
  });
});
