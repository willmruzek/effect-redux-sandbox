import {
  createFileRoute,
  useNavigate,
  useRouter
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { TaskDetail } from '@repo/project-tracker/react';

import { loadTaskDetails } from '../loadTaskDetails';
import {
  useAppDispatch,
  useAppSelector
} from '../hooks';
import { trackerActions } from '../reducer';
import { saveTaskDetails } from '../store';

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

  const dispatch = useAppDispatch();

  const navigate = useNavigate();

  const router = useRouter();

  const taskFromStore = useAppSelector((state) => state.tasks[taskId]);
  const detail = useAppSelector((state) => state.detail);
  const write = useAppSelector((state) => state.detailWrites[taskId]);

  useEffect(() => {
    if (loadResult.status === 'loaded') {
      dispatch(trackerActions.taskDetailReceived({ taskId, task: loadResult.task }));
    } else {
      dispatch(trackerActions.taskDetailLoadFailed({ taskId, error: loadResult.error }));
    }
  }, [dispatch, loadResult, taskId]);

  const loadedTask = loadResult.status === 'loaded' ? loadResult.task : null;
  const task = loadResult.status === 'loaded' &&
    loadedTask &&
    detail.status === 'ready' &&
    detail.taskId === taskId
    ? taskFromStore ?? loadedTask : loadedTask;

  return <TaskDetail
    key={taskId}
    task={task}
    write={task ? write : undefined}
    {...(loadResult.status === 'error' ? { loadError: loadResult.error } : {})}
    onBack={() => navigate({ to: '/' })}
    onRetryLoad={() => router.invalidate()}
    onSave={(values) => dispatch(saveTaskDetails({
      taskId,
      values,
      sourceMode
    }))}
  />;
}
