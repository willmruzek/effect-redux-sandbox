import { createEntityTable } from '@repo/gql-api';
import type {
  RequestApiOptions,
  RequestApiState
} from '@repo/effect-store-toolkit';
import {
  createInitialState,
  type TrackerState,
  type TrackerViewState,
  type TaskPage,
  type TaskQuery,
  type Project,
  type Person,
  type Task,
  type TaskDetailState,
  type NormalizedTaskPage,
  type TrackerSourceMode,
} from '@repo/project-tracker';
import {
  decodeTrackerPage,
  trackerPageOperation
} from '@repo/tracker-graphql/client';

export type TrackerApiState = TrackerViewState & {
  readonly api: RequestApiState;
  readonly detail: TaskDetailState;
};

type TaskVariables = {
  readonly after: string | null;
  readonly query: TaskQuery;
  readonly fail: boolean;
  readonly sourceMode: TrackerSourceMode;
} & { readonly mode: 'page' | 'refresh' };

type TrackerRead = {
  readonly page: TaskPage;
  readonly loadedPages: number
};

const projects = createEntityTable({
  name: 'projects',

  key: (project: Project) => project.id
});

const people = createEntityTable({
  name: 'people',

  key: (person: Person) => person.id
});

const tasks = createEntityTable({
  name: 'tasks',

  key: (task: Task) => task.id
});

export function createTrackerApiState(initial: TrackerState = createInitialState()): TrackerApiState {
  return {
    ...initial,
    api: { requests: {}, latest: {} },
    sourceMode: 'graphql',
    peopleRequest: { status: 'idle' },
    creations: {},
    deletions: {},
    detail: { status: 'idle' },
  };
}

function normalizePage({ page, loadedPages }: TrackerRead, variables: TaskVariables): NormalizedTaskPage {
  // The decoder supplies projectId/assigneeId foreign keys; no response tree is cached.
  return {
    entities: {
      projects: projects.normalize(page.projects),
      people: variables.sourceMode === 'mixed' ? {} : people.normalize(page.people),
      tasks: tasks.normalize(page.tasks),
    },

    ids: page.tasks.map((task) => task.id),

    loadedPages,
    pageInfo: page.pageInfo,
    totalCount: page.totalCount,
    statusCounts: page.statusCounts,
  };
}

export const trackerApiOptions = {
  name: 'trackerApi',
  endpoint: '/graphql',

  state: (state) => state.api,

  getState: (state) => state.api,

  operations: (api) => ({
    tasks: api.query('tasks', {
      document: trackerPageOperation,
      operationName: 'TrackerPage',

      decode: (data, variables: TaskVariables): TrackerRead => ({
        page: decodeTrackerPage({ data }, variables), loadedPages: 1,
      }),

      normalize: normalizePage,

      scope: () => 'tasks',
    }),
  }),
} satisfies RequestApiOptions<TrackerApiState, 'trackerApi', Readonly<Record<string, unknown>>>;
