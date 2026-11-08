import type { TrackerData } from '@repo/project-tracker';

import {
  beforeEach,
  describe,
  expect,
  test
} from 'vitest';

import {
  createRestHandler,
  createTrackerRepository
} from './server.js';

function fixture(): TrackerData {
  return {
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
      description: '',
    }],
  };
}

let handleRestRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  handleRestRequest = createRestHandler({ repository: createTrackerRepository({ seed: fixture() }) });
});

function request(path: string, init?: RequestInit): Promise<Response> {
  return handleRestRequest(new Request(`http://localhost${path}`, init));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCreatedTask(value: unknown): { readonly id: string } {
  if (!isRecord(value)) {
    throw new Error('Expected a task creation object.');
  }

  const task = value.task;

  if (!isRecord(task)) {
    throw new Error('Expected a created task.');
  }

  const id = task.id;

  if (typeof id !== 'string')
    throw new Error('Expected task identity.');

  return { id };
}

describe('REST endpoint', () => {
  test('returns a paginated tracker page', async () => {
    // Arrange: the handler owns a single seeded repository.

    // Act: request its first task page over HTTP.
    const response = await request('/api/tracker?first=1');

    // Assert: REST returns the same page contract used by the app stores.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: fixture().projects,
      people: fixture().people,
      tasks: fixture().tasks,
      pageInfo: { endCursor: expect.any(String), hasNextPage: false },
      totalCount: 1,
      statusCounts: [
        { status: 'todo', total: 1 },
        { status: 'in-progress', total: 0 },
        { status: 'done', total: 0 },
      ],
    });
  });

  test('updates a task without revision preconditions', async () => {
    // Arrange: submit an ordinary task-field patch.

    // Act: patch one task field.
    const response = await request('/api/tasks/task', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: { status: 'done' },
      }),
    });

    // Assert: the response and repository expose the updated value.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'task', status: 'done' });
  });

  test('rejects invalid task fields without changing server data', async () => {
    // Arrange: provide a task field that fails domain validation.

    // Act: submit a conflicting write.
    const response = await request('/api/tasks/task', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: { title: '' },
      }),
    });

    // Assert: the API reports invalid data and preserves the task.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Task title must contain between 1 and 200 characters.' });
    expect((await request('/api/tasks/task').then((result) => result.json())).status).toBe('todo');
  });

  test('updates people through the REST-owned endpoint', async () => {
    // Arrange: send a valid person name.

    // Act: update the person.
    const response = await request('/api/people/person', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rae Designer' }),
    });

    // Assert: the normalized person fields are returned authoritatively.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'person',
      name: 'Rae Designer',
      initials: 'RD',
      role: 'Designer',
    });
  });

  test('creates, reads, and deletes a task through REST', async () => {
    // Arrange: prepare a valid task creation request.
    const creation = await request('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'rest-create-1',
        input: {
          title: 'REST-created task',
          status: 'todo',
          priority: 'high',
          projectId: 'project',
          assigneeId: null,
        },
      }),
    });
    const task = getCreatedTask(await creation.json());

    // Act: read the new task, then delete it.
    const detail = await request(`/api/tasks/${task.id}`);
    const deletion = await request(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Assert: REST exposes each CRUD result.
    expect(creation.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ title: 'REST-created task' });
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({ id: task.id });
  });
});
