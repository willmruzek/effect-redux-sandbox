import {
  defaultTaskQuery,
  type TrackerData
} from '@repo/project-tracker';

import {
  beforeEach,
  describe,
  expect,
  test
} from 'vitest';

import {
  fetchRestPeople,
  fetchRestTaskById,
  fetchRestTrackerPage,
} from './rest-client.js';
import {
  createRestHandler,
  createTrackerRepository
} from './server.js';

const seed: TrackerData = {
  projects: [{
    id: 'project',
    name: 'Project',
    code: 'PRJ',
    description: 'Demo'
  }],
  people: [{
    id: 'person',
    name: 'Pat Person',
    initials: 'PP',
    role: 'Designer'
  }],
  tasks: [{
    id: 'task',
    projectId: 'project',
    assigneeId: 'person',
    title: 'Original task',
    status: 'todo',
    priority: 'medium',
    description: 'Detail',
  }],
};

let handleRestRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  handleRestRequest = createRestHandler({ repository: createTrackerRepository({ seed }) });
});

const fetcher = (url: string, init: RequestInit) => handleRestRequest(new Request(url, init));

describe('REST client', () => {
  test('decodes task pages and REST people', async () => {
    // Arrange: use the real REST handler at the network boundary.

    // Act: request a page and the people collection.
    const [page, people] = await Promise.all([
      fetchRestTrackerPage({
        endpoint: 'http://localhost/api',
        after: null,
        query: defaultTaskQuery,
        fetcher,
      }),
      fetchRestPeople({ endpoint: 'http://localhost/api', fetcher }),
    ]);

    // Assert: both response shapes are decoded into domain values.
    expect(page.tasks.map((task) => task.id)).toEqual(['task']);
    expect(page.tasks[0]?.description).toBe('Detail');
    expect(people).toEqual(seed.people);
  });

  test('returns null when the requested task is not found', async () => {
    // Arrange: use an ID absent from the REST repository.

    // Act: request its detail.
    const task = await fetchRestTaskById({
      endpoint: 'http://localhost/api',
      id: 'missing',
      fetcher,
    });

    // Assert: a REST 404 becomes the same explicit not-found result as GraphQL.
    expect(task).toBeNull();
  });
});
