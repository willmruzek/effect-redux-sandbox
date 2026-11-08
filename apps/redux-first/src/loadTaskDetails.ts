import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/react-start/server';

import type { Task } from '@repo/project-tracker';
import { fetchTaskById } from '@repo/tracker-graphql/client';
import { fetchRestTaskById } from '@repo/tracker-graphql/rest-client';
import type { TrackerSourceMode } from '@repo/project-tracker';

const endpoint = createIsomorphicFn()
  .server(() => new URL('/graphql', getRequestUrl()).href)
  .client(() => '/graphql');

const restEndpoint = createIsomorphicFn()
  .server(() => new URL('/api', getRequestUrl()).href)
  .client(() => '/api');

export type TaskDetailLoadResult =
  | {
    readonly status: 'loaded';
    readonly task: Task | null
  }
  | {
    readonly status: 'error';
    readonly error: string
  };

export async function loadTaskDetails(taskId: string, sourceMode: TrackerSourceMode = 'graphql'): Promise<TaskDetailLoadResult> {
  try {
    const task = sourceMode === 'rest'
      ? await fetchRestTaskById({ endpoint: restEndpoint(), id: taskId })
      : await fetchTaskById({ endpoint: endpoint(), id: taskId });

    return { status: 'loaded', task };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
