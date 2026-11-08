import {
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  Provider,
  shallowEqual,
  useStore
} from 'react-redux';

import type {
  TrackerSource,
  TrackerState
} from '@repo/project-tracker';
import { ProjectTracker } from '@repo/project-tracker/react';

import {
  createAppStore,
  createTask,
  deleteTask,
  trackerActions,
  loadMoreTasks,
  refreshTasks,
  saveStatus,
  savePriority,
  saveAssignee,
  renamePerson,
  selectSourceMode,
  type AppStore
} from '../store';
import {
  useAppDispatch,
  useAppSelector
} from '../hooks';
import { useDemoRuntime } from '../runtime';

export function ReduxClientApp({ initial, children }: Readonly<{
  initial: TrackerState;
  children?: ReactNode
}>) {
  const runtime = useDemoRuntime();

  const [store] = useState(() => createAppStore(runtime, initial));

  return (
    <Provider store={store} serverState={store.getState()}>
      {children ?? <ReduxHome onOpenTask={() => { }} />}
    </Provider>
  );
}

export function ReduxHome({ onOpenTask }: Readonly<{ onOpenTask: (taskId: string, sourceMode: import('@repo/project-tracker').TrackerSourceMode) => void }>) {
  const store = useStore.withTypes<AppStore>()();

  const source = useMemo<TrackerSource>(() => ({
    getSnapshot: store.getState,
    subscribe: store.subscribe,
  }), [store]);

  const state = useAppSelector((state) => ({ ...state }), shallowEqual);

  const dispatch = useAppDispatch();

  return (
    <ProjectTracker
      implementation="Redux First"
      source={source}
      state={state}
      onDelete={(input) => dispatch(deleteTask(input))}
      onDismissDeletionError={(taskId) => {
        dispatch(trackerActions.deletionErrorDismissed(taskId));
      }}
      onCreate={(input, fail) => dispatch(createTask({
        kind: 'new',
        input,
        fail
      }))}
      onRetry={(operationId, fail) => dispatch(createTask({
        kind: 'retry',
        operationId,
        fail
      }))}
      onDiscard={(operationId) => {
        dispatch(trackerActions.creationDiscarded(operationId));
      }}
      onQueryChange={(query, fail) => dispatch(loadMoreTasks({ query, fail }))}
      onLoadMore={(fail) => dispatch(loadMoreTasks({ fail }))}
      onRefresh={(fail) => dispatch(refreshTasks({ fail }))}
      onSaveStatus={(input) => dispatch(saveStatus(input))}
      onSavePriority={(input) => dispatch(savePriority(input))}
      onSaveAssignee={(input) => dispatch(saveAssignee(input))}
      onRenamePerson={(input) => dispatch(renamePerson(input))}
      onSelectSourceMode={(mode) => dispatch(selectSourceMode(mode))}
      onOpenTask={onOpenTask}
    />
  );
}
