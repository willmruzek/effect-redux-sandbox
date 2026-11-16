import { createEntityTable, variablesKey } from '@repo/gql-api';
import {
  createOptimisticOwnership,
  createGraphqlApi,
  createRestApi,
  cursorChainKey,
  validateCursorPage,
} from '@repo/redux-toolkit';
import {
  createInitialState,
  type TrackerState,
  type TaskPage,
  type TaskQuery,
  type Project,
  type Person,
  type Task,
  type NormalizedTaskPage,
  type TrackerSourceMode,
} from '@repo/project-tracker';
import {
  decodeTaskUpdate,
  decodeTrackerPage,
  taskUpdateOperation,
  trackerPageOperation
} from '@repo/tracker-graphql/client';
import {
  decodeRestPeople,
  decodeRestPersonUpdate,
  decodeRestTask,
  decodeRestTrackerPage,
} from '@repo/tracker-graphql/rest-client';

import type { TrackerApiState } from './trackerApiState';
import { TrackerApiStore } from './trackerApiStore';
import {
  createTrackerInvalidation,
  pageTags,
  taskPageTags,
} from './trackerInvalidation';

export type { TrackerApiState } from './trackerApiState';

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

export function createTrackerApiState(
  initial: TrackerState = createInitialState(),
  invalidation: ReturnType<typeof createTrackerInvalidation> = createTrackerInvalidation(),
): TrackerApiState {
  const identity = variablesKey({ query: initial.result.query, sourceMode: 'graphql' });
  const state: TrackerApiState = {
    ...initial,
    api: { requests: {}, latest: {} },
    invalidation: { revision: 0, queries: {}, history: [] },
    pagination: {
      identity,
      cursor: initial.result.pageInfo.endCursor,
      exhausted: initial.request.status === 'complete',
      pending: null,
      error: null,
    },
    sourceMode: 'graphql',
    peopleRequest: { status: 'idle' },
    creations: {},
    deletions: {},
    detail: { status: 'idle' },
  };

  return invalidation.reducer(state, invalidation.actions.seed({
    identity: cursorChainKey('trackerTasks', identity),
    tags: pageTags(initial.result.ids, Object.keys(initial.people)),
  }));
}

function normalizePage({ page, loadedPages }: TrackerRead, variables: TaskVariables): NormalizedTaskPage {
  validateCursorPage({
    after: variables.after,
    endCursor: page.pageInfo.endCursor,
    hasNextPage: page.pageInfo.hasNextPage,
  });

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

export type TrackerApiFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type TrackerApiTransportOptions = Readonly<{
  graphqlFetcher?: TrackerApiFetcher;
  restFetcher?: TrackerApiFetcher;
}>;

type AssigneeVariables = {
  readonly id: string;
  readonly patch: { readonly assigneeId: string | null };
  readonly fail: boolean;
  readonly delayMs: number;
  readonly sourceMode: TrackerSourceMode;
};

export function createTrackerApiDefinitions(input: TrackerApiTransportOptions & Readonly<{
  invalidation: ReturnType<typeof createTrackerInvalidation>;
}>) {
  const ownership = createOptimisticOwnership();

  const graphql = createGraphqlApi({
    name: 'trackerGraphql',
    endpoint: '/graphql',
    storeService: TrackerApiStore,
    ...(input.graphqlFetcher ? { fetcher: input.graphqlFetcher } : {}),
    state: (state) => state.api,
    getState: (state: TrackerApiState) => state.api,
    endpoints: (api) => ({
      tasks: api.query('tasks', {
        document: trackerPageOperation,
        operationName: 'TrackerPage',
        decode: (data, variables: TaskVariables): TrackerRead => ({
          page: decodeTrackerPage({ data }, variables),
          loadedPages: 1,
        }),
        normalize: normalizePage,
        scope: () => 'tasks',
        provides: {
          registry: input.invalidation,
          fromVariables: () => [{ type: 'TaskList' }],
          fromResult: taskPageTags,
        },
      }),
      assignee: api.mutation('assignee', {
        document: taskUpdateOperation,
        operationName: 'UpdateTask',
        decode: (data, variables: AssigneeVariables) => decodeTaskUpdate(data, variables.id),
        normalize: (task) => task,
        scope: (variables) => variables.id,
        invalidation: {
          registry: input.invalidation,
          tags: (variables) => [
            { type: 'TaskList' },
            { type: 'Task', id: variables.id },
          ],
        },
        optimistic: {
          ownership,
          targets: (_state, variables: AssigneeVariables) => [{
            table: 'tasks',
            id: variables.id,
            incarnation: variables.id,
            field: 'assigneeId',
          }],
          read: (state, target) => target.field === 'assigneeId'
            ? state.tasks[target.id]?.assigneeId
            : undefined,
          proposed: (_state, variables: AssigneeVariables) => variables.patch.assigneeId,
          confirmed: (task) => task.assigneeId,
          write: (state, target, value) => {
            const task = state.tasks[target.id];

            if (!task || target.field !== 'assigneeId' || (value !== null && typeof value !== 'string'))
              throw new Error('Invalid optimistic assignee target.');

            task.assigneeId = value;
          },
        },
      }),
    }),
  });

  const rest = createRestApi({
    name: 'trackerRest',
    basePath: '/api',
    storeService: TrackerApiStore,
    ...(input.restFetcher ? { fetcher: input.restFetcher } : {}),
    state: (state) => state.api,
    getState: (state: TrackerApiState) => state.api,
    endpoints: (api) => ({
      people: api.query('people', {
        request: () => ({
          path: '/people',
          method: 'GET',
          response: 'json',
        }),
        decode: (data) => decodeRestPeople(data),
        normalize: (result) => result,
        scope: () => 'people',
      }),
      tasks: api.query('tasks', {
        request: (variables: TaskVariables) => ({
          path: '/tracker',
          method: 'GET',
          query: {
            first: 20,
            status: variables.query.status,
            search: variables.query.search,
            assigneeId: variables.query.assigneeId,
            sort: variables.query.sort,
            projectId: variables.query.projectId,
            after: variables.after,
            fail: variables.fail,
          },
          response: 'json',
        }),
        decode: (data, variables: TaskVariables): TrackerRead => ({
          page: decodeRestTrackerPage(data, variables.after),
          loadedPages: 1,
        }),
        normalize: normalizePage,
        scope: () => 'tasks',
        provides: {
          registry: input.invalidation,
          fromVariables: () => [{ type: 'TaskList' }],
          fromResult: taskPageTags,
        },
      }),
      assignee: api.mutation('assignee', {
        request: (variables: AssigneeVariables) => ({
          path: `/tasks/${encodeURIComponent(variables.id)}`,
          method: 'PATCH',
          body: {
            patch: variables.patch,
            fail: variables.fail,
            delayMs: variables.delayMs,
          },
          response: 'json',
        }),
        decode: (data, variables: AssigneeVariables) => decodeRestTask(data, variables.id),
        normalize: (task) => task,
        scope: (variables) => variables.id,
        invalidation: {
          registry: input.invalidation,
          tags: (variables) => [
            { type: 'TaskList' },
            { type: 'Task', id: variables.id },
          ],
        },
        optimistic: {
          ownership,
          targets: (_state, variables: AssigneeVariables) => [{
            table: 'tasks',
            id: variables.id,
            incarnation: variables.id,
            field: 'assigneeId',
          }],
          read: (state, target) => target.field === 'assigneeId'
            ? state.tasks[target.id]?.assigneeId
            : undefined,
          proposed: (_state, variables: AssigneeVariables) => variables.patch.assigneeId,
          confirmed: (task) => task.assigneeId,
          write: (state, target, value) => {
            const task = state.tasks[target.id];

            if (!task || target.field !== 'assigneeId' || (value !== null && typeof value !== 'string'))
              throw new Error('Invalid optimistic assignee target.');

            task.assigneeId = value;
          },
        },
      }),
      renamePerson: api.mutation('renamePerson', {
        request: (variables: {
          readonly personId: string;
          readonly name: string;
        }) => ({
          path: `/people/${encodeURIComponent(variables.personId)}`,
          method: 'PATCH',
          body: { name: variables.name },
          response: 'json',
        }),
        decode: (data, variables) => decodeRestPersonUpdate(data, variables.personId),
        normalize: (person) => person,
        scope: (variables) => variables.personId,
        invalidation: {
          registry: input.invalidation,
          tags: (variables, person) => [
            { type: 'Person', id: variables.personId },
            { type: 'Person', id: person.id },
          ],
        },
        optimistic: {
          ownership,
          targets: (_state, variables) => [{
            table: 'people',
            id: variables.personId,
            incarnation: variables.personId,
            field: 'name',
          }],
          read: (state, target) => target.field === 'name'
            ? state.people[target.id]?.name
            : undefined,
          proposed: (_state, variables) => variables.name,
          confirmed: (person) => person.name,
          write: (state, target, value) => {
            const person = state.people[target.id];

            if (!person || target.field !== 'name' || typeof value !== 'string')
              throw new Error('Invalid optimistic person target.');

            person.name = value;
          },
        },
      }),
    }),
  });

  return { graphql, rest };
}

export type TrackerApiDefinitions = ReturnType<typeof createTrackerApiDefinitions>;
