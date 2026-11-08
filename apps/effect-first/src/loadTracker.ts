import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/react-start/server';

import {
  createInitialState,
  type TrackerState
} from '@repo/project-tracker';
import { fetchInitialTrackerData } from '@repo/tracker-graphql/client';

import {
  Effect,
  Layer,
  ManagedRuntime
} from 'effect';

const endpoint = createIsomorphicFn()
  .server(() => new URL('/graphql', getRequestUrl()).href)
  .client(() => '/graphql');

export async function loadTracker(): Promise<TrackerState> {
  const runtime = ManagedRuntime.make(Layer.empty);

  try {
    const data = await runtime.runPromise(Effect.tryPromise({
      try: () => fetchInitialTrackerData({ endpoint: endpoint() }),

      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    }));

    return createInitialState(data, data);
  } finally {
    await runtime.dispose();
  }
}
