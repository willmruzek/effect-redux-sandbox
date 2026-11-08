import {
  describe,
  expect,
  test
} from 'vitest';

import {
  createGraphqlHandler,
  createTrackerRepository
} from './server.js';
import {
  fetchInitialTrackerData,
  fetchTaskById
} from './client.js';

describe('normalized task details transport', () => {
  test(
    'fetches a detail-only description without adding it to list payloads',
    async () => {
      // Arrange: repository owns a description absent from the list query.
      const repository = createTrackerRepository();
      const handler = createGraphqlHandler({ repository });
      const fetcher = (url: string, init: RequestInit) => handler(new Request(url, init));
      const id = repository.read().tasks[0]?.id;

      if (!id)
        throw new Error('Missing seeded task.');

      // Act: read list and detail from the same API.
      const [page, detail] = await Promise.all([
        fetchInitialTrackerData({ endpoint: 'http://localhost/graphql', fetcher }),
        fetchTaskById({
          endpoint: 'http://localhost/graphql',
          id,
          fetcher
        }),
      ]);

      // Assert: only the detail response contains its optional field.
      expect(page.tasks[0]).not.toHaveProperty('description');
      expect(detail).toMatchObject({ id, description: '' });
    }
  );

  test('returns an explicit null for an unknown task ID', async () => {
    // Arrange: a valid repository and GraphQL transport.
    const handler = createGraphqlHandler({ repository: createTrackerRepository() });
    const fetcher = (url: string, init: RequestInit) => handler(new Request(url, init));
    // Act: request a task that does not exist.
    const detail = await fetchTaskById({
      endpoint: 'http://localhost/graphql',
      id: 'missing',
      fetcher
    });

    // Assert: not-found is distinct from transport or decode failure.
    expect(detail).toBeNull();
  });
});
