import {
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';

import {
  fetchInitialTrackerData,
  fetchTaskUpdate
} from './client.js';
import {
  createGraphqlHandler,
  createTrackerRepository
} from './server.js';

let handleApiRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  handleApiRequest = createGraphqlHandler({ repository: createTrackerRepository() });
});

describe('shared fake GraphQL endpoint', () => {
  test('executes GraphQL field selection', async () => {
    // Arrange: ask for only project codes, not a canned response.
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ tracker { projects { code } } }' }),
    });

    // Act: execute through the shared HTTP handler.
    const response = await handleApiRequest(request);

    // Assert: GraphQL respects the selection set.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        tracker: {
          projects: [
            { code: 'ATL' }, { code: 'STU' }, { code: 'FLD' }, { code: 'IDE' },
            ...Array.from({ length: 8 }, (_, index) => ({ code: `P${String(index + 1).padStart(2, '0')}` })),
          ]
        }
      },
    });
  });

  test('reports invalid GraphQL fields', async () => {
    // Arrange: send a schema-invalid query.
    const request = new Request('http://localhost/graphql', {
      method: 'POST', body: JSON.stringify({ query: '{ missing }' }),
    });

    // Act: execute the invalid operation.
    const response = await handleApiRequest(request);

    // Assert: the endpoint returns GraphQL errors, not seed data.
    expect(await response.json()).toEqual({
      errors: [expect.objectContaining({ message: expect.stringContaining('Cannot query field') })],
    });
  });

  test.each(['not JSON', '{}', '{"query":42}'])(
    'rejects malformed request bodies: %s',
    async (body) => {
      // Arrange: invalid transport input.
      const request = new Request('http://localhost/graphql', { method: 'POST', body });

      // Act: validate before executing.
      const response = await handleApiRequest(request);

      // Assert: invalid requests fail explicitly.
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('errors');
    }
  );

  test('rejects unsupported HTTP methods', async () => {
    // Arrange: this demo endpoint accepts POST only.
    const request = new Request('http://localhost/graphql');

    // Act: issue GET.
    const response = await handleApiRequest(request);

    // Assert: clients can discover the accepted method.
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('minimal GraphQL client', () => {
  test('decodes authoritative task mutation responses', async () => {
    // Arrange: execute against a real server-owned repository.
    const fetcher = vi.fn(async (url: string, init: RequestInit) => handleApiRequest(new Request(url, init)));

    // Act: change one field through the validated transport boundary.
    const task = await fetchTaskUpdate({
      endpoint: 'http://localhost/graphql',
      id: 'ATL-01',
      patch: { priority: 'low' },
      fetcher,
    });

    // Assert: the complete authoritative response includes unchanged fields.
    expect(task).toMatchObject({
      id: 'ATL-01',
      priority: 'low',
      status: 'in-progress'
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost/graphql',
      expect.objectContaining({
        body: expect.stringContaining('UpdateTask'),
      })
    );
  });

  test.each([
    { data: { updateTask: { id: 'ATL-01' } } },
    {
      data: {
        updateTask: {
          id: 'other',
          projectId: 'atlas',
          assigneeId: null,
          title: 'Task',
          status: 'todo',
          priority: 'low',
        }
      }
    },
    { data: { updateTask: null } },
    { errors: [{ message: 'Mutation rejected' }], data: { updateTask: null } },
  ])('rejects malformed or failed mutation responses: %j', async (body) => {
    // Arrange: replace only the HTTP response.
    const fetcher = async () => Response.json(body);

    // Act: request a task update.
    const pending = fetchTaskUpdate({
      endpoint: '/graphql',
      id: 'ATL-01',
      patch: { status: 'done' },
      fetcher
    });

    // Assert: a failure never becomes a successful field confirmation.
    await expect(pending).rejects.toThrow();
  });

  test(
    'preserves empty initial collections without substituting seed data',
    async () => {
      // Arrange: a valid empty workspace response.
      const empty = {
        projects: [],
        people: [],
        tasks: []
      };
      const fetcher = async () => Response.json({
        data: {
          tracker: {
            ...empty,
            tasks: {
              edges: [],
              pageInfo: { endCursor: null, hasNextPage: false },
              totalCount: 0,
              statusCounts: []
            },
          }
        }
      });

      // Act: decode the response.
      const data = await fetchInitialTrackerData({ endpoint: '/graphql', fetcher });

      // Assert: empty is valid data, not a reason to fall back.
      expect(data.tasks).toEqual([]);
      expect(data.pageInfo.hasNextPage).toBe(false);
    }
  );

  test('loads initial entities through the real endpoint', async () => {
    // Arrange: replace only HTTP transport with an in-process request.
    const fetcher = vi.fn(async (url: string, init: RequestInit) =>
      handleApiRequest(new Request(url, init)));

    // Act: execute the client operation.
    const data = await fetchInitialTrackerData({ endpoint: 'http://localhost/graphql', fetcher });

    // Assert: the typed response retains nullable relationships.
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost/graphql',
      expect.objectContaining({ method: 'POST' })
    );
    expect(data.projects).toHaveLength(12);
    expect(data.people).toHaveLength(20);
    expect(data.tasks).toHaveLength(20);
    expect(data.totalCount).toBe(200);
    expect(data.tasks.some((task) => task.assigneeId === null)).toBe(true);
  });

  test.each([
    {
      body: { errors: [{ message: 'Unavailable' }] },
      status: 200,
      message: 'Unavailable'
    },
    {
      body: {},
      status: 503,
      message: '503'
    },
    {
      body: {
        data: {
          tracker: {
            projects: [],
            people: [],
            tasks: [{ id: 'invalid' }]
          }
        }
      },
      status: 200,
      message: 'Invalid GraphQL response'
    },
    {
      body: { data: null },
      status: 200,
      message: 'Invalid GraphQL response'
    },
  ])('surfaces invalid responses: %j', async ({
    body,
    status,
    message
  }) => {
    // Arrange: a failing transport or GraphQL response.
    const fetcher = async () => Response.json(body, { status });

    // Act: request initial data.
    const result = fetchInitialTrackerData({ endpoint: '/graphql', fetcher });

    // Assert: no successful seed fallback masks the failure.
    await expect(result).rejects.toThrow(message);
  });
});
