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
import { fetchTaskCreate } from './client.js';

function arrange() {
  const repository = createTrackerRepository({
    seed: {
      projects: [{
        id: 'p',
        name: 'Project',
        code: 'P',
        description: ''
      }],
      people: [],
      tasks: [],
    }
  });
  const handler = createGraphqlHandler({ repository });
  const fetcher = (url: string, init: RequestInit) => handler(new Request(url, init));
  const input = {
    title: 'New task',
    projectId: 'p',
    assigneeId: null,
    status: 'todo',
    priority: 'low'
  } satisfies
    Parameters<typeof fetchTaskCreate>[0]['input'];
  const create = (operationId = 'op') => fetchTaskCreate({
    endpoint: 'http://localhost/graphql',
    operationId,
    input,
    fetcher
  });

  return {
    repository,
    fetcher,
    input,
    create
  };
}

afterEach(() => vi.useRealTimers());

describe('task creation', () => {
  test('treats concurrent attempts as separate creates', async () => {
    // Arrange: two requests carry the same client correlation ID.
    vi.useFakeTimers();

    const {
      repository,
      fetcher,
      input
    } = arrange();
    const first = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input,
      delayMs: 700,
      fetcher
    });
    const second = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input,
      delayMs: 700,
      fetcher
    });

    // Act: settle both at their commit boundaries.
    await vi.advanceTimersByTimeAsync(700);

    const results = await Promise.all([first, second]);

    // Assert: the server does not keep retry receipts or deduplicate creates.
    expect(results[0]?.id).not.toBe(results[1]?.id);
    expect(repository.read().tasks).toHaveLength(2);
  });

  test('trims a title at the two-hundred-character boundary', async () => {
    // Arrange: surrounding whitespace should not affect title validation.
    const {
      repository,
      fetcher,
      input
    } = arrange();

    // Act: submit the longest valid trimmed title.
    const result = await fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input: { ...input, title: ` ${'x'.repeat(200)} ` },
      fetcher,
    });

    // Assert: authoritative title has the required exact shape.
    expect(result.title).toBe('x'.repeat(200));
    expect(repository.read().tasks[0]?.title.length).toBe(200);
  });

  test('returns a complete server-owned task', async () => {
    // Arrange: an empty repository with a valid project.
    const {
      create,
      repository,
      input
    } = arrange();

    // Act: create through the real validated GraphQL boundary.
    const result = await create();

    // Assert: the new ID and authoritative fields are persisted.
    expect(result).toMatchObject(input);
    expect(result.id).not.toContain('temp:');
    expect(repository.read().tasks).toEqual([result]);
  });

  test('creates a new task when the client repeats a correlation ID', async () => {
    // Arrange: a completed create with a client-only correlation ID.
    const { create, repository } = arrange();
    const first = await create();

    // Act: repeat the request with the same correlation ID.
    const retry = await create();

    // Assert: the server treats both requests as independent CRUD operations.
    expect(retry.id).not.toBe(first.id);
    expect(repository.read().tasks).toHaveLength(2);
  });

  test('accepts different content with a repeated client correlation ID', async () => {
    // Arrange: the ID is only used to correlate local client state.
    const {
      create,
      repository,
      fetcher,
      input
    } = arrange();

    await create();

    // Act: submit different content using the same correlation ID.
    const retry = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input: { ...input, title: 'Different' },
      fetcher,
    });

    // Assert: the second request creates its own row.
    await expect(retry).resolves.toMatchObject({ title: 'Different' });
    expect(repository.read().tasks).toHaveLength(2);
  });

  test.each([
    { title: '' }, { title: 'x'.repeat(201) }, { projectId: 'missing' }, { assigneeId: 'missing' },
  ])('rejects invalid create input atomically: %j', async (patch) => {
    // Arrange: an empty server dataset.
    const {
      repository,
      fetcher,
      input
    } = arrange();

    // Act: request an invalid creation.
    const pending = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input: { ...input, ...patch },
      fetcher,
    });

    // Assert: validation cannot insert a partial entity.
    await expect(pending).rejects.toThrow();
    expect(repository.read().tasks).toEqual([]);
  });

  test('creates a task after a failed attempt is explicitly retried', async () => {
    // Arrange: failure control applies only to the first attempt.
    const {
      repository,
      fetcher,
      input,
      create
    } = arrange();
    const failed = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input,
      fail: true,
      fetcher,
    });

    await expect(failed).rejects.toThrow('Simulated task creation failure. Retry this draft.');

    // Act: retry without changing identity or input.
    await create();

    // Assert: one row is inserted by the successful attempt.
    expect(repository.read().tasks).toHaveLength(1);
  });

  test('delayed creation cannot commit after reset', async () => {
    // Arrange: creation is pending against the old generation.
    vi.useFakeTimers();

    const {
      repository,
      fetcher,
      input
    } = arrange();
    const pending = fetchTaskCreate({
      endpoint: 'http://localhost/graphql',
      operationId: 'op',
      input,
      delayMs: 700,
      fetcher,
    });
    const rejected = expect(pending).rejects.toThrow('Demo was reset. Retry this operation.');

    await vi.advanceTimersByTimeAsync(0);

    // Act: reset before settlement.
    repository.reset();
    await vi.advanceTimersByTimeAsync(700);
    await rejected;

    // Assert: old delayed work never repopulates the reset dataset.
    expect(repository.read().tasks).toEqual([]);
  });

  test('allows a new create after resetting the repository', async () => {
    const { create, repository } = arrange();
    const first = await create();

    repository.reset();

    // Act: use the identity in the newly reset dataset.
    const second = await create();

    // Assert: the new request creates a row in the reset repository.
    expect(second.id).not.toBe(first.id);
    expect(repository.read().tasks).toEqual([second]);
  });

  test('rejects a response with the wrong operation identity', async () => {
    // Arrange: a valid-shaped response belongs to another operation.
    const { input } = arrange();
    const fetcher = async () => Response.json({
      data: { createTask: { operationId: 'other', task: { ...input, id: 'server-id' } } },
    });

    // Act: decode the mismatched response.
    const pending = fetchTaskCreate({
      endpoint: '/graphql',
      operationId: 'op',
      input,
      fetcher
    });

    // Assert: no unrelated task becomes a creation confirmation.
    await expect(pending).rejects.toThrow('Invalid GraphQL response for CreateTask.');
  });
});
