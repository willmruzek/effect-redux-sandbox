import {
  BasicIndex,
  caseWhen,
  count,
  eq,
  sum,
  useLiveQuery
} from '@tanstack/react-db';
import {
  useEffect,
  useRef,
  useState
} from 'react';

import {
  createTrackerDatabase,
  type TrackerDatabase
} from './database.js';
import {
  requestedQuery,
  type DeleteOptions,
  type FieldWrite,
  type TaskPriority,
  type TaskStatus,
  type TaskQuery,
  type TrackerSource,
  type TrackerViewState,
  type PersonNameInput,
  type TrackerSourceMode
} from './index.js';
import {
  TaskCreationPanel,
  type TaskCreationPanelProps
} from './TaskCreationPanel.js';

type Props = Pick<TaskCreationPanelProps, 'onCreate' | 'onRetry' | 'onDiscard'> & {
  readonly implementation: 'Redux First' | 'Effect First';
  readonly source: TrackerSource;
  readonly state: TrackerViewState;
  readonly onDelete: (input: DeleteOptions) => Promise<unknown>;
  readonly onDismissDeletionError: (taskId: string) => void;
  readonly onQueryChange: (query: Partial<TaskQuery>, fail: boolean) => Promise<unknown>;
  readonly onLoadMore: (fail: boolean) => Promise<unknown>;
  readonly onRefresh: (fail: boolean) => Promise<unknown>;
  readonly onSaveStatus: (input: FieldWrite<TaskStatus>) => Promise<unknown>;
  readonly onSavePriority: (input: FieldWrite<TaskPriority>) => Promise<unknown>;
  readonly onOpenTask: (taskId: string, sourceMode: TrackerSourceMode) => void;
  readonly onSelectSourceMode: (sourceMode: TrackerSourceMode) => Promise<unknown>;
  readonly onSaveAssignee: (input: FieldWrite<string | null>) => Promise<unknown>;
  readonly onRenamePerson: (input: PersonNameInput) => Promise<unknown>;
};

const statuses: readonly {
  readonly value: TaskStatus | 'all';
  readonly label: string
}[] = [
    { value: 'all', label: 'All statuses' },
    { value: 'todo', label: 'To do' },
    { value: 'in-progress', label: 'In progress' },
    { value: 'done', label: 'Done' },
  ];

const pageSize = 5;

export function ProjectTracker(props: Props) {
  const [scope, setScope] = useState({ source: props.source, version: 0 });

  if (scope.source !== props.source) {
    setScope({ source: props.source, version: scope.version + 1 });
  }

  return <TrackerSession key={scope.version} {...props} />;
}

function TrackerSession(props: Props) {
  const [session] = useState(() => {
    const listeners = new Set<() => void>();
    // Render may be discarded. Only the committed effect subscribes to the store.
    const database = createTrackerDatabase({
      getSnapshot: props.source.getSnapshot,

      subscribe: (listener) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    });

    return {
      database,

      notify: () => {
        for (const listener of listeners)
          listener();
      }
    };
  });

  const { database } = session;

  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;

    const unsubscribe = props.source.subscribe(session.notify);

    session.notify();

    return () => {
      unsubscribe();
      mounted.current = false;
      // Strict Mode replays setup before this microtask; do not dispose a reclaimed scope.
      queueMicrotask(() => {
        if (!mounted.current) {
          void database.dispose().catch((error: unknown) => {
            console.error('Could not dispose project tracker database.', error);
          });
        }
      });
    };
  }, [database, props.source, session]);

  return <TrackerWorkspace {...props} database={database} />;
}

function TrackerWorkspace({
  implementation,
  state,
  database,
  onCreate,
  onRetry,
  onDiscard,
  onDelete,
  onDismissDeletionError,
  onQueryChange,
  onLoadMore,
  onRefresh,
  onSaveStatus,
  onSavePriority,
  onSaveAssignee,
  onRenamePerson,
  onSelectSourceMode,
  onOpenTask,
}: Props & Readonly<{ database: TrackerDatabase }>) {
  const { sourceMode, peopleRequest, creations, deletions } = state;
  const peopleLoading = peopleRequest.status === 'loading';
  const peopleError = peopleRequest.status === 'error' ? peopleRequest.error : undefined;

  const [failRequest, setFailRequest] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failStatus, setFailStatus] = useState(false);
  const [failPriority, setFailPriority] = useState(false);
  const [failDeletion, setFailDeletion] = useState(false);
  const [personNames, setPersonNames] = useState<Readonly<Record<string, string>>>({});
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);

  const keepTaskButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (deleteConfirmation !== null)
      keepTaskButton.current?.focus();
  }, [deleteConfirmation]);

  const [search, setSearch] = useState(state.result.query.search);

  const normalizedSearch = search.trim().toLowerCase();
  const desired = requestedQuery(state);
  const selectedProjectId = desired.projectId;
  const statusFilter = desired.status;
  const assigneeId = desired.assigneeId;
  const sort = desired.sort;

  useEffect(() => {
    if (normalizedSearch === desired.search)
      return;

    const timer = setTimeout(() => {
      run(() => onQueryChange({ search: normalizedSearch }, failRequest));
    }, 300);

    return () => clearTimeout(timer);
  }, [normalizedSearch, desired.search, onQueryChange, failRequest]);

  const order = new Map(state.result.ids.map((id, index) => [id, index]));

  const projectsQuery = useLiveQuery({
    query: (q) => q.from({ project: database.projects }).orderBy(({ project }) => project.name, 'asc'),
  });
  const peopleQuery = useLiveQuery({
    query: (q) => q.from({ person: database.people }).orderBy(({ person }) => person.name, 'asc'),
  });
  const peopleCountQuery = useLiveQuery({
    query: (q) => q.from({ person: database.people }).select(({ person }) => ({ total: count(person.id) })),
  });
  const taskCountsQuery = useLiveQuery({
    query: (q) => q.from({ task: database.tasks })
      .groupBy(({ task }) => task.status)
      .select(({ task }) => ({ status: task.status, total: count(task.id) })),
  });
  const projectSummariesQuery = useLiveQuery({
    query: (q) => q.from({ project: database.projects })
      .join({ task: database.tasks }, ({ project, task }) => eq(project.id, task.projectId), 'left')
      .groupBy(({ project }) => [project.id, project.name])
      .select(({ project, task }) => ({
        projectId: project.id,
        name: project.name,
        total: count(task?.id),
        done: sum(caseWhen(eq(task?.status, 'done'), 1, 0)),
      }))
      .orderBy(({ project }) => project.name, 'asc'),
  });
  const matchingQuery = useLiveQuery({
    autoIndex: 'eager',
    defaultIndexType: BasicIndex,
    // Functional predicates need explicit identity, including their captured inputs.
    queryKey: ['tracker-matches', database.tasks.id, state.result.ids, deletions],

    query: (q) => q
      .from({ task: database.tasks })
      .join({ project: database.projects }, ({ task, project }) => eq(task.projectId, project.id), 'inner')
      .join({ person: database.people }, ({ task, person }) => eq(task.assigneeId, person.id), 'left')
      .fn.where(({ task }) => order.has(task.id) && deletions[task.id]?.status !== 'saving')
      .fn.select(({
        task,
        project,
        person
      }) => ({
        rank: order.get(task.id) ?? 0,
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        projectName: project.name,
        projectCode: project.code,
        assigneeId: task.assigneeId,
        assigneeName: person?.name,
        initials: person?.initials,
      })),
  });

  const matchingTotal = state.result.statusCounts.reduce((total, row) => total + row.total, 0);
  const statusCounts = new Map(state.result.statusCounts.map((row) => [row.status, row.total]));
  const filteredTotal = matchingQuery.data.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const viewKey = JSON.stringify(state.result.query);

  const [pagination, setPagination] = useState({ viewKey, page: 0 });

  const page = pagination.viewKey === viewKey ? Math.min(pagination.page, pageCount - 1) : 0;

  // Reset changed views and retain a clamped page after source-side deletions.
  if (pagination.viewKey !== viewKey || pagination.page !== page)
    setPagination({ viewKey, page });

  const tasksQuery = useLiveQuery({
    query: (q) => q.from({ task: matchingQuery.collection })
      .orderBy(({ task }) => task.rank, 'asc')
      .offset(page * pageSize)
      .limit(pageSize),
  });

  const projects = projectsQuery.data;
  const tasks = tasksQuery.data;
  const taskTotal = taskCountsQuery.data.reduce((total, row) => total + row.total, 0);
  const done = taskCountsQuery.data.find((row) => row.status === 'done')?.total ?? 0;
  const peopleTotal = peopleCountQuery.data[0]?.total ?? 0;
  const projectCounts = new Map(projectSummariesQuery.data.map((row) => [row.projectId, row.total]));
  const refreshing = state.request.status === 'refreshing';
  const refreshFailed = state.request.status === 'refresh-error';

  const loading = state.request.status === 'loading' || refreshing;

  const complete = state.request.status === 'complete';
  const requestError = state.request.status === 'error' || refreshFailed ? state.request.error : null;
  const project = projects.find((project) => project.id === selectedProjectId);
  const queryError = [
    projectsQuery, peopleQuery, peopleCountQuery, taskCountsQuery, projectSummariesQuery,
    matchingQuery, tasksQuery,
  ].some((query) => query.status === 'error');

  function run(action: () => void | Promise<unknown>): void {
    setActionError(null);
    void Promise.resolve().then(action).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <div className="notebook">
      <header className="notebook-header">
        <a className="wordmark" href="/" aria-label="Fieldwork home"><span className="brand-mark" aria-hidden="true">F</span>fieldwork<span className="wordmark-dot">.</span></a>
        <div className="implementation"><span className="connection-dot" />{implementation}<span className="implementation-divider">/</span>TanStack DB</div>
        <label className="source-selector">DATA EXAMPLE
          <select aria-label="Data source example" value={sourceMode} onChange={(event) => {
            const value = event.target.value;

            if (value !== 'graphql' && value !== 'rest' && value !== 'mixed')
              throw new Error(`Unknown data source mode: ${value}`);

            run(() => onSelectSourceMode(value));
          }}>
            <option value="graphql">GraphQL only</option>
            <option value="rest">REST only</option>
            <option value="mixed">Mixed: GraphQL tasks + REST people</option>
          </select>
        </label>
      </header>
      <div className="workspace">
        <aside className="sidebar" aria-label="Project navigation">
          <p className="eyebrow">THE WORKSPACE</p>
          <h2>Small teams.<br />Thoughtful work.</h2>
          <nav aria-label="Projects">
            <button className={`project-link ${selectedProjectId === null ? 'selected' : ''}`} aria-pressed={selectedProjectId === null} onClick={() => run(() => onQueryChange({ projectId: null }, failRequest))}>
              <span className="project-icon" aria-hidden="true">::</span><span>All projects</span><span className="project-count">{taskTotal}</span>
            </button>
            <p className="nav-label">PROJECTS <span>{projects.length.toString().padStart(2, '0')}</span></p>
            {projects.map((project) => (
              <button key={project.id} className={`project-link ${selectedProjectId === project.id ? 'selected' : ''}`} aria-pressed={selectedProjectId === project.id} onClick={() => run(() => onQueryChange({ projectId: project.id }, failRequest))}>
                <span className={`project-icon icon-${project.id}`} aria-hidden="true">{project.code.slice(0, 1)}</span>
                <span>{project.name}</span>
                <span className="project-count">{projectCounts.get(project.id) ?? 0}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <span className="note-number">01 / THE EXPERIMENT</span>
            <p>Same notebook.<br />Different engine.</p>
            <small>Store-owned records. Read-only DB views. GraphQL, REST & mixed sources.</small>
          </div>
        </aside>
        <main className="main-panel">
          <div className="page-intro">
            <div><p className="eyebrow">PROJECT NOTEBOOK / OVERVIEW</p><h1>{project?.name ?? 'The work, in view.'}</h1>
              <p className="intro-copy">{project?.description ?? 'A shared place for the details that move good projects forward.'}</p>
            </div>
            <span className="edition">LIVE EDITION<br /><strong>001</strong></span>
          </div>
          <section className="metrics" aria-label="Workspace totals">
            <div><span className="metric-label">TASKS IN THE NOTEBOOK</span><strong>{taskTotal.toString().padStart(2, '0')}</strong><small>Cached records across {projects.length} projects</small></div>
            <div><span className="metric-label">WORK COMPLETED</span><strong>{done.toString().padStart(2, '0')}<em> / {taskTotal}</em></strong><small>{Math.round(done / Math.max(1, taskTotal) * 100)}% of the details, taken care of</small></div>
            <div><span className="metric-label">PEOPLE IN THE LOOP</span><strong>{peopleTotal.toString().padStart(2, '0')}</strong><small>Design, engineering, research & product</small></div>
          </section>
          <section className="project-summaries" aria-label="Project summaries">
            <h2>Across the projects <span>LIVE LEFT JOIN / CACHED RECORDS</span></h2>
            <div className="summary-grid">
              {projectSummariesQuery.data.map((summary) => (
                <article key={summary.projectId} data-project-id={summary.projectId}>
                  <h3>{summary.name}</h3>
                  <p>{summary.total} {summary.total === 1 ? 'task' : 'tasks'} <span>/ {summary.done} done</span></p>
                  <small>{summary.total === 0 ? 'No cached tasks yet' : `${Math.round(summary.done / summary.total * 100)}% complete`}</small>
                </article>
              ))}
            </div>
          </section>
          <section className="task-section" aria-labelledby="task-heading">
            <div className="section-toolbar"><h2 id="task-heading">Task ledger <span>{state.result.totalCount}</span></h2>
              <div className="status-filters" role="group" aria-label="Filter by status">
                {statuses.map(({ value, label }) => <button key={value} aria-pressed={statusFilter === value} onClick={() => run(() => onQueryChange({ status: value }, failRequest))}>{label} <span>{value === 'all' ? matchingTotal : statusCounts.get(value) ?? 0}</span></button>)}
              </div>
            </div>
            <div className="ledger-controls">
              <label className="search-control">Search titles<input type="search" value={search} placeholder="Find a task..." onChange={(event) => setSearch(event.target.value)} /></label>
              <label>Assignee<select aria-label="Filter by assignee" value={assigneeId} onChange={(event) => {
                const value = event.target.value;

                run(() => onQueryChange({ assigneeId: value }, failRequest));
              }}><option value="">All people</option><option value="unassigned">Unassigned</option>{peopleQuery.data.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
              <label>Sort by<select aria-label="Sort tasks" value={sort} onChange={(event) => {
                const value = event.target.value;

                if (value !== 'id' && value !== 'title' && value !== 'priority')
                  throw new Error(`Unknown task sort: ${value}`);

                run(() => onQueryChange({ sort: value }, failRequest));
              }}><option value="id">Task ID</option><option value="title">Title A–Z</option><option value="priority">Priority: high first</option></select></label>
            </div>
            <p role="status">{state.result.ids.length} loaded / {state.result.totalCount} matching tasks on backend{loading ? ' — Loading backend results...' : ''}</p>
            <div className="relation-strip"><span className="connection-dot" /><strong>LIVE JOIN</strong><code>tasks.projectId → projects.id</code><span className="relation-divider">+</span><code>tasks.assigneeId → people.id</code><span className="relation-divider">/</span><code>{sourceMode === 'mixed' ? 'GraphQL + REST' : sourceMode.toUpperCase()}</code></div>
            <div className="write-experiment" aria-label="Optimistic write experiment">
              <p><strong>One store. Three source examples.</strong> Task edits update optimistically through store dispatch. DB stays read-only. Writes persist on this app server, then refresh the first backend page.</p>
              <label><input type="checkbox" aria-label="Fail status saves" checked={failStatus} onChange={(event) => setFailStatus(event.target.checked)} />Fail status saves</label>
              <label><input type="checkbox" aria-label="Fail priority saves" checked={failPriority} onChange={(event) => setFailPriority(event.target.checked)} />Fail priority saves</label>
              <label><input type="checkbox" aria-label="Fail task deletions" checked={failDeletion} onChange={(event) => setFailDeletion(event.target.checked)} />Fail task deletions</label>
            </div>
            {deleteConfirmation !== null ? <section className="deletion-confirmation" aria-label="Confirm task deletion">
              <h3>Delete {deleteConfirmation}?</h3>
              <p>{state.tasks[deleteConfirmation]?.title ?? 'Task no longer available.'} This cannot be undone after the server confirms.</p>
              <p>The pending row stays visible here until the server confirms the delete.</p>
              <button ref={keepTaskButton} onClick={() => setDeleteConfirmation(null)}>Keep task</button>
              <button disabled={!state.tasks[deleteConfirmation] ||
                deletions[deleteConfirmation]?.status === 'saving' ||
                state.statusWrites[deleteConfirmation]?.status === 'saving' ||
                state.priorityWrites[deleteConfirmation]?.status === 'saving'} onClick={() => {
                  const taskId = deleteConfirmation;

                  setDeleteConfirmation(null);
                  run(() => onDelete({ taskId, fail: failDeletion }));
                }}>Confirm deletion</button>
            </section> : null}
            {Object.keys(deletions).length > 0 ? <section className="deletion-notices" aria-label="Pending deletions and errors">
              <h3>Deletion requests</h3>
              <p>Pending rows are hidden while the server processes the delete. A failed request restores the row.</p>
              <p>If the outcome is unclear, refresh the first page before retrying.</p>
              {Object.entries(deletions).map(([id, deletion]) => <article key={id} data-deletion-id={id}>
                <strong>{deletion.title}</strong> <small>{id}</small>
                {deletion.status === 'saving' ? <p role="status">Deleting...</p> : <>
                  <p className="error-message" role="alert">{deletion.error}</p>
                  <button onClick={() => run(() => onRefresh(failRequest))} disabled={loading}>Refresh before retry</button>
                  <button onClick={() => setDeleteConfirmation(id)}>Retry deletion</button>
                  <button onClick={() => onDismissDeletionError(id)}>Dismiss error</button>
                </>}
              </article>)}
            </section> : null}
            {queryError ? <p role="alert" className="error-message">Could not read the project collections.</p> : null}
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Tasks joined to projects and optionally assigned people</caption>
                <thead><tr><th scope="col">TASK / PROJECT</th><th scope="col">ASSIGNEE</th><th scope="col">PRIORITY<small>Store optimistic</small></th><th scope="col">STATUS<small>Store optimistic</small></th><th scope="col">DELETE</th></tr></thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td><div className="task-identity"><div><button type="button" className="task-title task-title-link"
                        aria-label={`Open task ${task.id}: ${task.title}`} onClick={() => onOpenTask(task.id, sourceMode)}>{task.title}</button>
                        <small><span className="task-id">{task.id}</span>{task.projectName}</small></div></div></td>
                      <td>
                        <select className="task-write" aria-label={`Assignee for ${task.id}`}
                          value={task.assigneeId ?? ''}
                          disabled={state.assigneeWrites[task.id]?.status === 'saving'}
                          onChange={(event) => {
                            const value = event.target.value;

                            run(() => onSaveAssignee({ taskId: task.id, value: value || null }));
                          }}>
                          <option value="">Unassigned</option>
                          {peopleQuery.data.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                        </select>
                        <small className="write-state">{state.assigneeWrites[task.id]?.status === 'saving' ? 'Saving...' : 'Store optimistic'}</small>
                      </td>
                      <td>
                        <select className={`task-write priority-${task.priority}`} aria-label={`Priority for ${task.id}`} value={task.priority} disabled={state.priorityWrites[task.id]?.status === 'saving'} onChange={(event) => {
                          const value = event.target.value;

                          if (value !== 'high' && value !== 'medium' && value !== 'low')
                            throw new Error(`Unknown task priority: ${value}`);

                          run(() => onSavePriority({
                            taskId: task.id,
                            value,
                            fail: failPriority
                          }));
                        }}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
                        <small className="write-state">{state.priorityWrites[task.id]?.status === 'saving' ? 'Saving...' : 'Store optimistic'}</small>
                      </td>
                      <td>
                        <select className={`task-write status-${task.status}`} aria-label={`Status for ${task.id}`} value={task.status} disabled={state.statusWrites[task.id]?.status === 'saving'} onChange={(event) => {
                          const value = event.target.value;

                          if (value !== 'todo' && value !== 'in-progress' && value !== 'done')
                            throw new Error(`Unknown task status: ${value}`);

                          run(() => onSaveStatus({
                            taskId: task.id,
                            value,
                            fail: failStatus
                          }));
                        }}><option value="todo">To do</option><option value="in-progress">In progress</option><option value="done">Done</option></select>
                        <small className="write-state">{state.statusWrites[task.id]?.status === 'saving' ? 'Saving in store...' : 'Store optimistic'}</small>
                      </td>
                      <td><button className="task-delete" aria-label={`Delete ${task.id}`}
                        disabled={state.statusWrites[task.id]?.status === 'saving' ||
                          state.priorityWrites[task.id]?.status === 'saving' ||
                          state.assigneeWrites[task.id]?.status === 'saving'}
                        onClick={() => setDeleteConfirmation(task.id)}>Delete {task.id}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tasks.length === 0 && !tasksQuery.isLoading ? <p className="empty-state">No tasks match this view. Try changing the search or filters.</p> : null}
            </div>
            <div className="ledger-footer">
              <span role="status" aria-live="polite">{refreshing ? 'Refreshing source records; keeping the current view...' : loading ? 'Loading more source records...' : `Showing ${filteredTotal === 0 ? 0 : page * pageSize + 1}–${Math.min((page + 1) * pageSize, filteredTotal)} of ${filteredTotal} matching tasks (${taskTotal} loaded)`}</span>
              <nav className="ledger-pagination" aria-label="Task pages">
                <button disabled={page === 0} onClick={() => setPagination({ viewKey, page: page - 1 })}>Previous</button>
                <span>Page {page + 1} of {pageCount}</span>
                <button disabled={page + 1 >= pageCount} onClick={() => setPagination({ viewKey, page: page + 1 })}>Next</button>
              </nav>
            </div>
            {Object.entries(state.statusWrites).map(([id, write]) => write.status === 'error'
              ? <p key={`status-${id}`} role="alert" className="error-message">{id} / Store status: {write.error}</p> : null)}
            {Object.entries(state.priorityWrites).map(([id, write]) => write.status === 'error'
              ? <p key={`priority-${id}`} role="alert" className="error-message">{id} / Store priority: {write.error}</p> : null)}
          </section>
          {sourceMode !== 'graphql' ? <section className="people-directory" aria-labelledby="people-directory-heading">
            <div>
              <p className="eyebrow">REST-OWNED PEOPLE</p>
              <h2 id="people-directory-heading">Team directory</h2>
              <p>Person names save through REST; task assignments remain owned by the selected task transport.</p>
              {peopleLoading ? <p role="status">Loading people from REST...</p> : null}
              {peopleError ? <p role="alert" className="error-message">{peopleError}</p> : null}
            </div>
            <div className="people-directory-list">
              {peopleQuery.data.map((person) => {
                const write = state.personWrites[person.id];

                return <form key={person.id} onSubmit={(event) => {
                  event.preventDefault();
                  run(() => onRenamePerson({ personId: person.id, name: personNames[person.id] ?? person.name }));
                }}>
                  <span className="avatar" aria-hidden="true">{person.initials}</span>
                  <div><strong>{person.name}</strong><small>{person.role}</small></div>
                  <label className="visually-hidden" htmlFor={`person-name-${person.id}`}>Name for {person.name}</label>
                  <input id={`person-name-${person.id}`} value={personNames[person.id] ?? person.name}
                    disabled={write?.status === 'saving'}
                    onChange={(event) => setPersonNames({ ...personNames, [person.id]: event.target.value })} />
                  <button type="submit" disabled={write?.status === 'saving'}>
                    {write?.status === 'saving' ? 'Saving...' : 'Rename'}
                  </button>
                  {write?.status === 'error'
                    ? <small role="alert" className="error-message">{write.error}</small> : null}
                </form>;
              })}
            </div>
          </section> : null}
          <TaskCreationPanel projects={projects} people={peopleQuery.data} tasks={state.tasks}
            creations={creations} onCreate={onCreate} onRetry={onRetry} onDiscard={onDiscard} />
          <section className="load-panel" aria-labelledby="load-heading">
            <div className="load-copy"><span className="eyebrow">A LITTLE MORE TO EXPLORE</span><h2 id="load-heading">Bring more records into the notebook.</h2><p>The selected source fetches up to 20 matches after the last cursor.<br />Refresh reloads the first backend page; later pages can be loaded again. The current view stays while refresh is in progress.</p></div>
            <div className="load-controls">
              <button className="load-button" disabled={loading} onClick={() => run(() => onRefresh(failRequest))}>{refreshing ? 'Refreshing tasks...' : refreshFailed ? 'Retry refresh' : 'Refresh tasks'}</button>
              <button className="load-button" disabled={loading || complete || refreshFailed} onClick={() => run(() => onLoadMore(failRequest))}>{loading ? 'Loading tasks...' : complete ? 'All tasks loaded' : requestError ? 'Retry loading tasks' : 'Load more tasks'}<span aria-hidden="true">{loading ? '...' : '↗'}</span></button>
              <label className="failure-toggle"><input type="checkbox" checked={failRequest} disabled={loading} onChange={(event) => setFailRequest(event.target.checked)} />Simulate request failure</label>
            </div>
          </section>
          {requestError || actionError ? <p className="error-message" role="alert">{requestError ?? actionError}</p> : null}
          {refreshFailed ? <p className="workspace-footnote">Successful mutations remain committed. Remaining ledger rows and server totals stay from the previous window; retry refresh to reconcile them.</p> : null}
          <p className="workspace-footnote">APP-SERVER DEMO DATA <span>In-app refresh preserves loaded depth. Browser reload starts with one backend page. Server restart or explicit reset restores the seed.</span></p>
        </main>
      </div>
    </div>
  );
}

export { TaskDetail } from './TaskDetail.js';
