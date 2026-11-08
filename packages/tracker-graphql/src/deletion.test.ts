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
import { fetchTaskDelete } from './client.js';

function arrange() {
  const repository = createTrackerRepository();
  const handler = createGraphqlHandler({ repository });
  const fetcher = (url: string, init: RequestInit) => handler(new Request(url, init));
  const taskId = repository.read().tasks[0]?.id;

  if (!taskId)
    throw new Error('Missing seeded task.');

  const remove = (options: Readonly<{
    fail?: boolean;
    delayMs?: number
  }> = {}) =>
    fetchTaskDelete({
      endpoint: 'http://localhost/graphql',
      id: taskId,
      fetcher,
      ...options
    });

  return {
    taskId,
    repository,
    fetcher,
    remove
  };
}

afterEach(() => vi.useRealTimers());

describe('task deletion', () => {
  test('removes only the task from the repository', async () => {
    // Arrange: the seeded task references shared project and person rows.
    const {
      taskId,
      repository,
      remove
    } = arrange();
    const before = repository.read();

    // Act: delete the task through GraphQL.
    expect(await remove()).toBe(taskId);

    // Assert: parent records and the prior immutable snapshot remain available.
    expect(repository.read().tasks.some((task) => task.id === taskId)).toBe(false);
    expect(repository.read().projects).toEqual(before.projects);
    expect(repository.read().people).toEqual(before.people);
    expect(before.tasks.some((task) => task.id === taskId)).toBe(true);
  });

  test(
    'reports an unknown task instead of treating deletion as idempotent',
    async () => {
      // Arrange: use a valid repository and an absent task ID.
      const { fetcher } = arrange();

      // Act: attempt to delete the missing row.
      const pending = fetchTaskDelete({
        endpoint: 'http://localhost/graphql',
        id: 'missing',
        fetcher
      });

      // Assert: the server surfaces the missing entity.
      await expect(pending).rejects.toThrow('Unknown task: missing.');
    }
  );

  test('leaves the task intact when the server rejects a delete', async () => {
    // Arrange: retain the original server snapshot.
    const { repository, remove } = arrange();
    const before = repository.read();

    // Act: request a deliberate failure.
    const pending = remove({ fail: true });

    // Assert: failed CRUD does not mutate server data.
    await expect(pending).rejects.toThrow('Simulated task deletion failure. Retry this deletion.');
    expect(repository.read()).toBe(before);
  });

  test('does not commit delayed deletion after reset', async () => {
    // Arrange: deletion is waiting against the current repository generation.
    vi.useFakeTimers();

    const { repository, remove } = arrange();
    const pending = remove({ delayMs: 700 });
    const rejected = expect(pending).rejects.toThrow('Demo was reset. Retry this operation.');

    await vi.advanceTimersByTimeAsync(0);

    // Act: reset before the write reaches its commit point.
    repository.reset();
    await vi.advanceTimersByTimeAsync(700);

    // Assert: reset data remains untouched by the obsolete request.
    await rejected;
    expect(repository.read().tasks).toHaveLength(200);
  });
});
