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
import { saveTaskDetails } from './flows';
import { trackerActions } from './reducer';
import { createTrackerApiState } from './api';

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange() {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  const repository = createTrackerRepository();
  const app = createAppStore(runtime, createTrackerApiState());
  const handler = createGraphqlHandler({ repository });
  const fetcher = vi.fn((url: string, init: RequestInit) => handler(new Request(new URL(url, 'http://localhost'), init)));

  vi.stubGlobal('fetch', fetcher);

  const task = repository.read().tasks[0];

  if (!task)
    throw new Error('Missing seed task.');

  app.dispatch(trackerActions.taskDetailReceived({
    taskId: task.id, task: { ...task, description: '' },
  }));

  return {
    app,
    repository,
    task,
    fetcher
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('task detail workflow', () => {
  test(
    'saves title and detail-only description through the normalized entity',
    async () => {
      // Arrange: a normalized task has an explicitly loaded description.
      vi.useFakeTimers();

      const {
        app,
        repository,
        task
      } = arrange();
      const pending = app.dispatch(saveTaskDetails({
        taskId: task.id,
        values: { title: 'Revised title', description: 'Useful detail' },
      }));

      expect(app.getSnapshot().tasks[task.id]).toMatchObject({ title: 'Revised title', description: 'Useful detail' });
      // Act: settle the server write.
      await vi.advanceTimersByTimeAsync(700);
      await pending;
      // Assert: the normalized entity carries the server-confirmed values.
      expect(app.getSnapshot().tasks[task.id]).toMatchObject({
        title: 'Revised title', description: 'Useful detail',
      });
      expect(repository.read().tasks.find((row) => row.id === task.id)).toMatchObject({
        title: 'Revised title', description: 'Useful detail',
      });
      expect(app.getSnapshot().detail).toEqual({ status: 'ready', taskId: task.id });
    }
  );

  test(
    'preserves description and newer field values when a list read omits detail fields',
    async () => {
      // Arrange: description has been fetched and edited.
      vi.useFakeTimers();

      const { app, task } = arrange();
      const pending = app.dispatch(saveTaskDetails({
        taskId: task.id,
        values: { title: task.title, description: 'Keep me' },
      }));

      await vi.advanceTimersByTimeAsync(700);
      await pending;

      // Act: merge a list entity without description.
      const before = app.getSnapshot().tasks[task.id];

      expect(before).toBeDefined();
      app.dispatch(trackerActions.taskDetailReceived({
        taskId: task.id,
        task: {
          id: task.id,
          projectId: task.projectId,
          assigneeId: task.assigneeId,
          title: task.title,
          status: task.status,
          priority: task.priority,
        }
      }));
      // Assert: absent is not interpreted as an explicit clear.
      expect(app.getSnapshot().tasks[task.id]).toMatchObject({
        description: 'Keep me',
      });
    }
  );

  test('rolls back an invalid title and preserves the description', async () => {
    // Arrange: an invalid title should not change server data.
    vi.useFakeTimers();

    const {
      app,
      task,
      repository
    } = arrange();
    const pending = app.dispatch(saveTaskDetails({
      taskId: task.id, values: { title: '', description: 'New note' },
    }));

    await vi.advanceTimersByTimeAsync(700);
    await pending;
    // Act / Assert: validation is visible and rollback is field-paired.
    expect(app.getSnapshot().tasks[task.id]?.title).toBe(task.title);
    expect(app.getSnapshot().tasks[task.id]?.description).toBe('');
    expect(repository.read().tasks[0]?.description).toBe('');
    expect(app.getSnapshot().detailWrites[task.id]).toMatchObject({ status: 'error' });
  });
});
