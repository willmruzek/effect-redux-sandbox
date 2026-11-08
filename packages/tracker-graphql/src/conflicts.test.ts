import type {
  TaskPriority,
  TaskStatus,
  TrackerData
} from '@repo/project-tracker';

import {
  describe,
  expect,
  test
} from 'vitest';

import { fetchTaskUpdate } from './client.js';
import {
  createGraphqlHandler,
  createTrackerRepository
} from './server.js';

function arrange() {
  const seed: TrackerData = {
    projects: [{
      id: 'p',
      code: 'P',
      name: 'Project',
      description: ''
    }],
    people: [],
    tasks: [{
      id: 't',
      projectId: 'p',
      assigneeId: null,
      title: 'Task',
      status: 'todo',
      priority: 'low'
    }],
  };
  const repository = createTrackerRepository({ seed });
  const handler = createGraphqlHandler({ repository });
  const fetcher = (url: string, init: RequestInit) => handler(new Request(url, init));
  const update = (patch: Readonly<{
    status?: TaskStatus;
    priority?: TaskPriority
  }>) =>
    fetchTaskUpdate({
      endpoint: 'http://localhost/graphql',
      id: 't',
      patch,
      fetcher
    });

  return { repository, update };
}

describe('plain task updates', () => {
  test('applies independent field updates without revision contracts', async () => {
    // Arrange: two updates target different fields on one task.
    const { repository, update } = arrange();

    // Act: save both values through the GraphQL transport.
    await update({ status: 'done' });

    const result = await update({ priority: 'high' });

    // Assert: both server-owned values are retained.
    expect(result).toMatchObject({ status: 'done', priority: 'high' });
    expect(repository.read().tasks[0]).toMatchObject({ status: 'done', priority: 'high' });
  });

  test('allows a later field update to replace the current value', async () => {
    // Arrange: the first update changes status.
    const { repository, update } = arrange();

    await update({ status: 'done' });

    // Act: a later update sets another valid status.
    const result = await update({ status: 'in-progress' });

    // Assert: ordinary CRUD does not require conflict tokens.
    expect(result.status).toBe('in-progress');
    expect(repository.read().tasks[0]?.status).toBe('in-progress');
  });
});
