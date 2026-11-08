import {
  createContext,
  useContext,
  useState,
  type ReactNode
} from 'react';

import { useStoreSnapshot } from '@repo/effect-store-react';
import { ProjectTracker } from '@repo/project-tracker/react';
import {
  createLocalActions,
  type TrackerState
} from '@repo/project-tracker';

import {
  createAppStore,
  type AppStore
} from '../store';
import {
  createTask,
  deleteTask,
  loadMoreTasks,
  refreshTasks,
  saveStatus,
  savePriority,
  saveAssignee,
  renamePerson,
  selectSourceMode
} from '../flows';
import { trackerActions } from '../reducer';
import { useDemoRuntime } from '../runtime';

const StoreContext = createContext<AppStore<never> | null>(null);

export function useEffectAppStore(): AppStore<never> {
  const store = useContext(StoreContext);

  if (!store)
    throw new Error('Effect app store is unavailable outside its root provider.');

  return store;
}

export function EffectClientApp({ initial, children }: Readonly<{
  initial: TrackerState;
  children?: ReactNode
}>) {
  const runtime = useDemoRuntime();

  const [store] = useState(() => createAppStore(runtime, initial));

  return (
    <StoreContext.Provider value={store}>
      {children ?? <EffectHome onOpenTask={() => { }} />}
    </StoreContext.Provider>
  );
}

export function EffectHome({ onOpenTask }: Readonly<{ onOpenTask: (taskId: string, sourceMode: import('@repo/project-tracker').TrackerSourceMode) => void }>) {
  const store = useEffectAppStore();

  const state = useStoreSnapshot(store);
  const local = createLocalActions({
    getState: store.getSnapshot,
    dispatch: store.dispatch,
    createId: () => crypto.randomUUID(),
  });

  return <ProjectTracker
    implementation="Effect First"
    source={store}
    state={state}
    onDelete={(input) => store.dispatch(deleteTask(input))}
    onDismissDeletionError={(taskId) => {
      store.dispatch(trackerActions.deletionErrorDismissed(taskId));
    }}
    onCreate={(input, fail) => store.dispatch(createTask({
      kind: 'new',
      input,
      fail
    }))}
    onRetry={(operationId, fail) => store.dispatch(createTask({
      kind: 'retry',
      operationId,
      fail
    }))}
    onDiscard={(operationId) => {
      store.dispatch(trackerActions.creationDiscarded(operationId));
    }}
    onQueryChange={(query, fail) => store.dispatch(loadMoreTasks({ query, fail }))}
    onLoadMore={(fail) => store.dispatch(loadMoreTasks({ fail }))}
    onRefresh={(fail) => store.dispatch(refreshTasks({ fail }))}
    onSaveStatus={(input) => store.dispatch(saveStatus(input))}
    onSavePriority={(input) => store.dispatch(savePriority(input))}
    onSaveAssignee={(input) => store.dispatch(saveAssignee(input))}
    onRenamePerson={(input) => store.dispatch(renamePerson(input))}
    onSelectSourceMode={(mode) => store.dispatch(selectSourceMode(mode))}
    onOpenTask={onOpenTask}
    onSetStarred={local.setStarred}
    onAddNote={local.addNote}
    onDeleteNote={local.deleteNote}
  />;
}
