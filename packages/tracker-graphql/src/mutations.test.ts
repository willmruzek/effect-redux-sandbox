import type { TrackerData } from '@repo/project-tracker';

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
} from './server.js';
import { fetchInitialTrackerData } from './client.js';

function arrange() {
  const seed: TrackerData = {
    projects: [{
      id: 'project',
      code: 'PRJ',
      name: 'Project',
      description: 'Demo'
    }],
    people: [],
    tasks: [{
      id: 'task',
      projectId: 'project',
      assigneeId: null,
      title: 'Original',
      status: 'todo',
      priority: 'low'
    }],
  };
  const repository = createTrackerRepository({ seed });
  const handler = createGraphqlHandler({ repository });
  const request = (query: string, variables: object = {}) => handler(new Request('http://localhost/graphql', {
    method: 'POST', body: JSON.stringify({ query, variables }),
  }));

  return {
    repository,
    handler,
    request
  };
}

const update = `mutation Update($patch: TaskPatch!, $delayMs: Int!, $fail: Boolean!) {
  updateTask(id: "task", patch: $patch, delayMs: $delayMs, fail: $fail) { id title status priority }
}`;

afterEach(() => vi.useRealTimers());

describe('persistent GraphQL endpoint', () => {
  test('serves saved values to fresh initial-data reads', async () => {
    // Arrange: a single app-server handler receives multiple independent requests.
    const { request, handler } = arrange();

    // Act: update, then fetch as a fresh SSR/browser client.
    await request(update, {
      patch: { status: 'done' },
      delayMs: 0,
      fail: false
    });

    const result = await fetchInitialTrackerData({
      endpoint: 'http://localhost/graphql',

      fetcher: (url, init) => handler(new Request(url, init)),
    });

    // Assert: new reads return authoritative server data, without session setup.
    expect(result.tasks[0]?.status).toBe('done');
  });

  test('resets data without setting a cookie', async () => {
    // Arrange: change the repository through the API.
    const { request, repository } = arrange();

    await request(update, {
      patch: { priority: 'high' },
      delayMs: 0,
      fail: false
    });

    // Act: execute the explicit reset operation.
    const response = await request('mutation { resetDemo }');

    // Assert: reset is observable and needs no session cookie.
    expect(await response.json()).toEqual({ data: { resetDemo: true } });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(repository.read().tasks[0]?.priority).toBe('low');
  });

  test('applies latency before committing an update', async () => {
    // Arrange: control the actual server delay.
    vi.useFakeTimers();

    const { request, repository } = arrange();
    const pending = request(update, {
      patch: { status: 'done' },
      delayMs: 700,
      fail: false
    });

    // Act: cross the documented delay boundary.
    await vi.advanceTimersByTimeAsync(699);
    expect(repository.read().tasks[0]?.status).toBe('todo');
    await vi.advanceTimersByTimeAsync(1);

    const response = await pending;

    // Assert: the update committed at 700 ms.
    expect(await response.json()).toEqual({
      data: {
        updateTask: {
          id: 'task',
          title: 'Original',
          status: 'done',
          priority: 'low'
        }
      },
    });
  });

  test('does not commit a deliberately failed write', async () => {
    // Arrange: a write with explicit failure control.
    const { request, repository } = arrange();

    // Act: ask the backend to fail the write.
    const response = await request(update, {
      patch: { status: 'done' },
      delayMs: 0,
      fail: true
    });

    // Assert: failure is explicit and the repository remains unchanged.
    expect(await response.json()).toEqual({
      data: null,
      errors: [expect.objectContaining({ message: 'Simulated status save failure. Change the field to retry.' })],
    });
    expect(repository.read().tasks[0]?.status).toBe('todo');
  });

  test('prevents a delayed write from committing after reset', async () => {
    // Arrange: start an update against the current repository generation.
    vi.useFakeTimers();

    const { request, repository } = arrange();
    const pending = request(update, {
      patch: { status: 'done' },
      delayMs: 700,
      fail: false
    });

    await vi.advanceTimersByTimeAsync(0);

    // Act: reset before the write completes.
    await request('mutation { resetDemo }');
    await vi.advanceTimersByTimeAsync(700);

    const response = await pending;

    // Assert: old work cannot repopulate a reset demo.
    expect(await response.json()).toEqual({
      data: null,
      errors: [expect.objectContaining({ message: 'Demo was reset. Retry this operation.' })],
    });
    expect(repository.read().tasks[0]?.status).toBe('todo');
  });

  test.each([-1, 5001])('rejects invalid latency %s', async (delayMs) => {
    // Arrange: the API limits delays to 0-5000 ms.
    const { request, repository } = arrange();

    // Act: submit an invalid control value.
    const response = await request(update, {
      patch: { status: 'done' },
      delayMs,
      fail: false
    });

    // Assert: invalid controls produce errors rather than silent defaults.
    expect(await response.json()).toHaveProperty('errors');
    expect(repository.read().tasks[0]?.status).toBe('todo');
  });
});
