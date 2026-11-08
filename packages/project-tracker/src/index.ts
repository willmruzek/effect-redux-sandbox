export {
  validateTaskDeletion,
  validateTaskEdit,
  type TaskEditValidationInput,
  type TaskValidationResult,
  type TaskValidationState,
} from './taskValidation.js';

export {
  createLocalActions,
  isLocalAction,
  reduceLocalData,
  remapTaskPreference,
  trackerTables,
  type LocalAction,
  type LocalResult,
  type LocalState,
  type ScratchNote,
  type TaskPreference,
} from './localData.js';

import type {
  ScratchNote,
  TaskPreference
} from './localData.js';

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly description: string;
};

export type Person = {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly role: string;
};

export type TaskStatus = 'todo' | 'in-progress' | 'done';

export type TaskPriority = 'high' | 'medium' | 'low';

export type TrackerSourceMode = 'graphql' | 'rest' | 'mixed';

export type TaskField = 'title' | 'status' | 'priority' | 'projectId' | 'assigneeId';

export type Task = {
  readonly id: string;
  readonly projectId: string;
  readonly assigneeId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  /** Omitted by list responses; null or a string is authoritative when present. */
  readonly description?: string | null;
};

export type TaskCreateInput = Pick<Task, TaskField>;

export type TaskCreationInput = {
  readonly operationId: string;
  readonly task: Task
};

export type PersonNameInput = {
  readonly personId: string;
  readonly name: string
};

export type TaskCreation =
  | {
    readonly status: 'saving';
    readonly taskId: string;
    readonly requestId: string
  }
  | {
    readonly status: 'error';
    readonly taskId: string;
    readonly requestId: string;
    readonly error: string
  }
  | {
    readonly status: 'created';
    readonly taskId: string
  };

export type CreateOptions = (
  | {
    readonly kind: 'new';
    readonly input: TaskCreateInput
  }
  | {
    readonly kind: 'retry';
    readonly operationId: string
  }
) & { readonly fail?: boolean };

export type TaskDeletion =
  | {
    readonly status: 'saving';
    readonly requestId: string;
    readonly title: string
  }
  | {
    readonly status: 'error';
    readonly requestId: string;
    readonly title: string;
    readonly error: string
  };

export type TaskDeletionInput = {
  readonly taskId: string;
};

export type DeleteOptions = TaskDeletionInput & { readonly fail?: boolean };

export type PendingWrite<Value> =
  | {
    readonly status: 'saving';
    readonly requestId: string;
    readonly original: Value
  }
  | {
    readonly status: 'error';
    readonly error: string
  };

export type StatusWrite = PendingWrite<TaskStatus>;

export type PriorityWrite = PendingWrite<TaskPriority>;

export type AssigneeWrite = PendingWrite<string | null>;

export type PersonWrite = PendingWrite<string>;

export type TaskDetailValues = Readonly<{
  title: string;
  description: string | null
}>;

export type TaskDetailWrite = PendingWrite<TaskDetailValues>;

export type TaskDetailWriteInput = {
  readonly taskId: string;
  readonly values: TaskDetailValues;
};

export type DetailWriteOptions = TaskDetailWriteInput & {
  readonly fail?: boolean;
  readonly sourceMode?: TrackerSourceMode;
};

export type TaskDetailState =
  | { readonly status: 'idle' }
  | {
    readonly status: 'loading';
    readonly taskId: string
  }
  | {
    readonly status: 'ready';
    readonly taskId: string
  }
  | {
    readonly status: 'not-found';
    readonly taskId: string
  }
  | {
    readonly status: 'error';
    readonly taskId: string;
    readonly error: string
  };

export type TaskDetailReceived = {
  readonly taskId: string;
  readonly task: Task | null
};

export type TaskDetailLoadFailed = {
  readonly taskId: string;
  readonly error: string
};

export type TaskFieldInput<Value> = {
  readonly taskId: string;
  readonly value: Value;
};

export type FieldWrite<Value> = TaskFieldInput<Value> & { readonly fail?: boolean };

export type PersistField<Value> = (input: FieldWrite<Value>) => Promise<TaskFieldInput<Value>>;

export type WriteOptions<Value> = FieldWrite<Value> & { readonly persist?: PersistField<Value> };

export type RequestState =
  | { readonly status: 'idle' | 'complete' }
  | {
    readonly status: 'loading';
    readonly after: string | null;
    readonly query: TaskQuery;
    readonly requestId: string;
    readonly sourceMode: TrackerSourceMode
  }
  | {
    readonly status: 'refreshing';
    readonly after: null;
    readonly query: TaskQuery;
    readonly requestId: string;
    readonly sourceMode: TrackerSourceMode
  }
  | {
    readonly status: 'error' | 'refresh-error';
    readonly after: string | null;
    readonly query: TaskQuery;
    readonly error: string;
    readonly sourceMode: TrackerSourceMode
  };

export type TaskQuery = {
  readonly projectId: string | null;
  readonly status: TaskStatus | 'all';
  readonly search: string;
  readonly assigneeId: string;
  readonly sort: 'id' | 'title' | 'priority';
};

export const defaultTaskQuery: TaskQuery = {
  projectId: null,
  status: 'all',
  search: '',
  assigneeId: '',
  sort: 'id',
};

export type PageInfo = {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean
};

export type StatusCount = {
  readonly status: TaskStatus;
  readonly total: number
};

export type TaskResult = {
  readonly query: TaskQuery;
  readonly ids: readonly string[];
  /** Successful backend pages in this window; never the five-row UI page count. */
  readonly loadedPages: number;
  readonly pageInfo: PageInfo;
  readonly totalCount: number;
  readonly statusCounts: readonly StatusCount[];
};

export type TrackerState = {
  readonly projects: Readonly<Record<string, Project>>;
  readonly people: Readonly<Record<string, Person>>;
  readonly tasks: Readonly<Record<string, Task>>;
  readonly taskPreferences: Readonly<Record<string, TaskPreference>>;
  readonly scratchNotes: Readonly<Record<string, ScratchNote>>;
  readonly selectedProjectId: string | null;
  readonly statusFilter: TaskStatus | 'all';
  readonly request: RequestState;
  readonly result: TaskResult;
  readonly statusWrites: Readonly<Record<string, StatusWrite>>;
  readonly priorityWrites: Readonly<Record<string, PriorityWrite>>;
  readonly assigneeWrites: Readonly<Record<string, AssigneeWrite>>;
  readonly personWrites: Readonly<Record<string, PersonWrite>>;
  readonly detailWrites: Readonly<Record<string, TaskDetailWrite>>;
};

export type PeopleRequestState =
  | { readonly status: 'idle' | 'complete' }
  | {
    readonly status: 'loading';
    readonly requestId: string
  }
  | {
    readonly status: 'error';
    readonly requestId: string;
    readonly error: string
  };

export type TrackerViewState = TrackerState & {
  readonly sourceMode: TrackerSourceMode;
  readonly peopleRequest: PeopleRequestState;
  readonly creations: Readonly<Record<string, TaskCreation>>;
  readonly deletions: Readonly<Record<string, TaskDeletion>>;
};

export type TaskPage = {
  readonly projects: readonly Project[];
  readonly people: readonly Person[];
  readonly tasks: readonly Task[];
  readonly pageInfo: PageInfo;
  readonly totalCount: number;
  readonly statusCounts: readonly StatusCount[];
};

export type TrackerData = Pick<TaskPage, 'projects' | 'people' | 'tasks'>;

export type NormalizedTaskPage = Pick<TaskPage, 'pageInfo' | 'totalCount' | 'statusCounts'> & {
  readonly entities: Pick<TrackerState, 'projects' | 'people' | 'tasks'>;
  readonly ids: readonly string[];
  readonly loadedPages: number;
};

export type FetchPage = (input: Readonly<{
  after: string | null;
  query: TaskQuery;
  fail: boolean
}>) => Promise<TaskPage>;

export type LoadOptions = {
  readonly fail?: boolean;
  readonly query?: Partial<TaskQuery>;
  readonly fetchPage?: FetchPage;
  readonly sourceMode?: TrackerSourceMode;
};

export type RefreshOptions = Pick<LoadOptions, 'fail' | 'fetchPage' | 'sourceMode'>;

export type LoadStarted = {
  readonly requestId: string;
  readonly after: string | null;
  readonly query: TaskQuery
};

export type LoadSucceeded = {
  readonly requestId: string;
  readonly page: TaskPage
};

export type TrackerSource = {
  readonly getSnapshot: () => TrackerState;
  readonly subscribe: (listener: () => void) => () => void;
};

const projects: readonly Project[] = [
  {
    id: 'atlas',
    name: 'Atlas website',
    code: 'ATL',
    description: 'A clearer home for our next chapter.'
  },
  {
    id: 'studio',
    name: 'Studio toolkit',
    code: 'STU',
    description: 'Better tools for thoughtful work.'
  },
  {
    id: 'field',
    name: 'Field research',
    code: 'FLD',
    description: 'Turn observations into useful direction.'
  },
  {
    id: 'ideas',
    name: 'Ideas inbox',
    code: 'IDE',
    description: 'Room for the next good idea. No tasks yet.'
  },
];

const people: readonly Person[] = [
  {
    id: 'mara',
    name: 'Mara Chen',
    initials: 'MC',
    role: 'Design'
  },
  {
    id: 'eli',
    name: 'Eli Brooks',
    initials: 'EB',
    role: 'Engineering'
  },
  {
    id: 'nia',
    name: 'Nia Patel',
    initials: 'NP',
    role: 'Research'
  },
  {
    id: 'owen',
    name: 'Owen Reed',
    initials: 'OR',
    role: 'Product'
  },
];

const tasks: readonly Task[] = [
  {
    id: 'ATL-01',
    projectId: 'atlas',
    assigneeId: 'mara',
    title: 'Map the new information architecture',
    status: 'in-progress',
    priority: 'high'
  },
  {
    id: 'ATL-02',
    projectId: 'atlas',
    assigneeId: 'eli',
    title: 'Build the accessible navigation shell',
    status: 'todo',
    priority: 'high'
  },
  {
    id: 'STU-01',
    projectId: 'studio',
    assigneeId: 'mara',
    title: 'Document the color foundations',
    status: 'done',
    priority: 'medium'
  },
  {
    id: 'STU-02',
    projectId: 'studio',
    assigneeId: null,
    title: 'Audit component usage across teams',
    status: 'todo',
    priority: 'low'
  },
  {
    id: 'FLD-01',
    projectId: 'field',
    assigneeId: 'nia',
    title: 'Synthesize the first interview round',
    status: 'in-progress',
    priority: 'high'
  },
  {
    id: 'FLD-02',
    projectId: 'field',
    assigneeId: 'owen',
    title: 'Share the research brief',
    status: 'done',
    priority: 'medium'
  },
];

export function indexById<T extends { readonly id: string }>(rows: readonly T[]): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

export function createInitialState(data: TrackerData = {
  projects,
  people,
  tasks
}, page?: TaskPage): TrackerState {
  return {
    projects: indexById(data.projects.map((row) => ({ ...row }))),
    people: indexById(data.people.map((row) => ({ ...row }))),
    tasks: indexById(data.tasks.map((row) => ({ ...row }))),
    taskPreferences: {},
    scratchNotes: {},
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: page && !page.pageInfo.hasNextPage ? 'complete' : 'idle' },
    result: {
      query: defaultTaskQuery,
      ids: data.tasks.map((task) => task.id).sort(),
      loadedPages: 1,
      pageInfo: page?.pageInfo ?? { endCursor: null, hasNextPage: false },
      totalCount: page?.totalCount ?? data.tasks.length,
      statusCounts: page?.statusCounts ?? ['todo', 'in-progress', 'done'].map((status): StatusCount => ({
        status: status === 'todo' ? 'todo' : status === 'done' ? 'done' : 'in-progress',
        total: data.tasks.filter((task) => task.status === status).length,
      })),
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
  };
}

export function requestedQuery(state: TrackerState): TaskQuery {
  return state.request.status === 'loading' ||
    state.request.status === 'error' ||
    state.request.status === 'refreshing' ||
    state.request.status === 'refresh-error'
    ? state.request.query : state.result.query;
}

/** Replaces only the visible result IDs; cached entities keep pending writes settleable. */
export function receiveTaskPage(state: TrackerState, { requestId, page }: LoadSucceeded): TrackerState {
  return receiveNormalizedTaskPage(state, {
    requestId,
    page: {
      entities: {
        projects: indexById(page.projects),
        people: indexById(page.people),
        tasks: indexById(page.tasks)
      },

      ids: page.tasks.map((task) => task.id),

      loadedPages: 1,
      pageInfo: page.pageInfo,
      totalCount: page.totalCount,
      statusCounts: page.statusCounts,
    },
  });
}

/** Transport-independent merge; pending optimistic fields take precedence over reads. */
export function receiveNormalizedTaskPage(
  state: TrackerState,
  { requestId, page }: Readonly<{
    requestId: string;
    page: NormalizedTaskPage
  }>,
): TrackerState {
  const request = state.request;

  if (
    (request.status !== 'loading' && request.status !== 'refreshing') ||
    request.requestId !== requestId
  )
    return state;

  const tasks = { ...state.tasks };

  for (const task of Object.values(page.entities.tasks)) {
    const previous = tasks[task.id];
    const hasDescription = task.description !== undefined;

    const keepStatus = previous && state.statusWrites[task.id]?.status === 'saving';
    const keepPriority = previous && state.priorityWrites[task.id]?.status === 'saving';
    const keepAssignee = previous && state.assigneeWrites[task.id]?.status === 'saving';
    const keepTitle = previous && state.detailWrites[task.id]?.status === 'saving';
    const keepDescription = previous && (state.detailWrites[task.id]?.status === 'saving' || !hasDescription);

    tasks[task.id] = {
      ...task,
      ...(keepStatus ? { status: previous.status } : {}),
      ...(keepPriority ? { priority: previous.priority } : {}),
      ...(keepAssignee ? { assigneeId: previous.assigneeId } : {}),
      ...(keepTitle ? { title: previous.title } : {}),
      ...(keepDescription ? { description: previous.description } : {}),
    };
  }

  return {
    ...state,
    projects: { ...state.projects, ...page.entities.projects },

    people: Object.entries(page.entities.people).reduce<Record<string, Person>>(
      (people, [id, person]) => {
        const previous = state.people[id];

        people[id] = previous && state.personWrites[id]?.status === 'saving'
          ? previous
          : person;

        return people;
      },
      { ...state.people }
    ),

    tasks,
    selectedProjectId: request.query.projectId,
    statusFilter: request.query.status,
    result: {
      query: request.query,
      ids: [...new Set([...(request.after === null ? [] : state.result.ids), ...page.ids])],
      loadedPages: (request.after === null ? 0 : state.result.loadedPages) + page.loadedPages,
      pageInfo: page.pageInfo,
      totalCount: page.totalCount,
      statusCounts: page.statusCounts,
    },
    request: { status: page.pageInfo.hasNextPage ? 'idle' : 'complete' },
  };
}
