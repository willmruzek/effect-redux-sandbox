import {
  createFileRoute,
  useNavigate,
  useRouter
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { TaskDetail } from '@repo/project-tracker/react';

import { loadTaskDetails } from '../loadTaskDetails';

import { useStoreSnapshot } from '@repo/effect-store-react';

import { useEffectAppStore } from '../components/EffectClientApp';
import { trackerActions } from '../reducer';
import { saveTaskDetails } from '../flows';

import type { TrackerSourceMode } from '@repo/project-tracker';

function parseSourceMode(value: unknown): TrackerSourceMode {
  return value === 'rest' || value === 'mixed' ? value : 'graphql';
}

export const Route = createFileRoute('/tasks/$taskId')({
  validateSearch: (search) => ({
    sourceMode: parseSourceMode(search.sourceMode),
  }),

  loaderDeps: ({ search }) => ({ sourceMode: search.sourceMode }),

  loader: ({ params, deps }) => loadTaskDetails(params.taskId, deps.sourceMode),

  component: TaskPage,
});

function TaskPage() {
  const { taskId } = Route.useParams();
  const loadResult = Route.useLoaderData();
  const { sourceMode } = Route.useSearch();

  const store = useEffectAppStore();

  const state = useStoreSnapshot(store);

  const navigate = useNavigate();

  const router = useRouter();

  useEffect(() => {
    if (loadResult.status === 'loaded') {
      void store.dispatch(trackerActions.taskDetailReceived({ taskId, task: loadResult.task }));
    } else {
      void store.dispatch(trackerActions.taskDetailLoadFailed({ taskId, error: loadResult.error }));
    }
  }, [loadResult, store, taskId]);

  const loadedTask = loadResult.status === 'loaded' ? loadResult.task : null;
  const task = loadResult.status === 'loaded' &&
    loadedTask &&
    state.detail.status === 'ready' &&
    state.detail.taskId === taskId
    ? state.tasks[taskId] ?? loadedTask : loadedTask;

  return <TaskDetail
    key={taskId}
    task={task}
    write={task ? state.detailWrites[task.id] : undefined}
    {...(loadResult.status === 'error' ? { loadError: loadResult.error } : {})}
    onBack={() => navigate({ to: '/' })}
    onRetryLoad={() => router.invalidate()}
    onSave={(values) => store.dispatch(saveTaskDetails({
      taskId,
      values,
      sourceMode
    }))}
  />;
}
