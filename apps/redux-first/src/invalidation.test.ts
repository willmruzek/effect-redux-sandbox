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

import {
  createAppStore,
  saveStatus
} from './store';

const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

function arrange() {
  const runtime = ManagedRuntime.make(Layer.empty);

  runtimes.push(runtime);

  const repository = createTrackerRepository();
  const app = createAppStore(runtime);
  const handler = createGraphqlHandler({ repository });
  const fetcher = vi.fn((url: string, init: RequestInit) =>
    handler(new Request(new URL(url, 'http://localhost'), init)));

  vi.stubGlobal('fetch', fetcher);

  return {
    app,
    repository,
    fetcher
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CRUD refresh', () => {
  test('refreshes one backend page after a successful field update', async () => {
    // Arrange: the store and GraphQL handler share a server repository.
    vi.useFakeTimers();

    const {
      app,
      repository,
      fetcher
    } = arrange();

    // Act: save a task status and settle the server request.
    const pending = app.dispatch(saveStatus({ taskId: 'ATL-01', value: 'done' }));

    await vi.advanceTimersByTimeAsync(700);
    await pending;

    // Assert: the server and normalized store agree after one first-page refresh.
    expect(repository.read().tasks.find((task) => task.id === 'ATL-01')?.status).toBe('done');
    expect(app.getState().tasks['ATL-01']?.status).toBe('done');
    expect(fetcher.mock.calls.filter(([, init]) => typeof init.body === 'string'
      && init.body.includes('TrackerPage'))).toHaveLength(1);
  });

  test('does not refresh after a rejected field update', async () => {
    // Arrange: configure the server to reject this update.
    vi.useFakeTimers();

    const { app, fetcher } = arrange();

    // Act: attempt the failed status write.
    const pending = app.dispatch(saveStatus({
      taskId: 'ATL-01',
      value: 'done',
      fail: true
    }));

    await vi.advanceTimersByTimeAsync(700);
    await pending;

    // Assert: no follow-up read is started for a failed mutation.
    expect(fetcher.mock.calls.filter(([, init]) => typeof init.body === 'string'
      && init.body.includes('TrackerPage'))).toHaveLength(0);
    expect(app.getState().tasks['ATL-01']?.status).toBe('in-progress');
  });
});
