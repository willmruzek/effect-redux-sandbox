import {
  defaultTaskQuery,
  type Task,
  type TaskCreateInput,
  type TaskPage,
  type TaskQuery,
  type FetchPage
} from '@repo/project-tracker';
import { requestGraphql } from '@repo/gql-api';

import { Schema } from 'effect';

const taskSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  assigneeId: Schema.NullOr(Schema.String),
  title: Schema.String,
  status: Schema.Literals(['todo', 'in-progress', 'done']),
  priority: Schema.Literals(['high', 'medium', 'low']),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const trackerSchema = Schema.Struct({
  projects: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    code: Schema.String,
    description: Schema.String,
  })),
  people: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    initials: Schema.String,
    role: Schema.String,
  })),
  tasks: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ cursor: Schema.String, node: taskSchema })),
    pageInfo: Schema.Struct({ endCursor: Schema.NullOr(Schema.String), hasNextPage: Schema.Boolean }),
    totalCount: Schema.Number,
    statusCounts: Schema.Array(Schema.Struct({
      status: Schema.Literals(['todo', 'in-progress', 'done']),
      total: Schema.Number,
    })),
  }),
});

const responseSchema = Schema.Struct({
  data: Schema.Struct({ tracker: trackerSchema }),
});

const errorSchema = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
});

export const trackerPageOperation = `
  query TrackerPage($after: String, $query: TaskQuery!, $fail: Boolean!) {
    tracker(first: 20, after: $after, query: $query, fail: $fail) {
      projects { id name code description }
      people { id name initials role }
      tasks {
        edges { cursor node { id projectId assigneeId title status priority } }
        pageInfo { endCursor hasNextPage }
        totalCount
        statusCounts { status total }
      }
    }
  }
`;

export const taskByIdOperation = `
  query TaskById($id: ID!) {
    task(id: $id) { id projectId assigneeId title status priority description }
  }
`;

/** Fetch one authoritative normalized entity; null is an explicit not-found result. */
export async function fetchTaskById({
  endpoint,
  id,
  fetcher,
  signal,
}: Readonly<{
  endpoint: string;
  id: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>): Promise<Task | null> {
  const data = await requestGraphql({
    endpoint,
    document: taskByIdOperation,
    operationName: 'TaskById',
    variables: { id },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({
    task: Schema.NullOr(taskSchema),
  }))(data);

  if (decoded._tag === 'None')
    throw new Error('Invalid GraphQL response for TaskById.');

  const task = decoded.value.task;

  if (task === null)
    return null;

  if (task.id !== id || task.description === undefined) {
    throw new Error('Invalid GraphQL response for TaskById.');
  }

  return task;
}

export const taskUpdateOperation = `
  mutation UpdateTask($id: ID!, $patch: TaskPatch!, $fail: Boolean!, $delayMs: Int!) {
    updateTask(id: $id, patch: $patch, fail: $fail, delayMs: $delayMs) {
      id projectId assigneeId title status priority description
    }
  }
`;

export const taskCreateOperation = `
  mutation CreateTask($operationId: ID!, $input: TaskCreateInput!, $fail: Boolean!, $delayMs: Int!) {
    createTask(operationId: $operationId, input: $input, fail: $fail, delayMs: $delayMs) {
      operationId
      task { id projectId assigneeId title status priority description }
    }
  }
`;

export const taskDeleteOperation = `
  mutation DeleteTask($id: ID!, $fail: Boolean!, $delayMs: Int!) {
    deleteTask(id: $id, fail: $fail, delayMs: $delayMs) { id }
  }
`;

export async function fetchTaskDelete({
  endpoint,
  id,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: Readonly<{
  endpoint: string;
  id: string;
  fail?: boolean;
  delayMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>): Promise<string> {
  const data = await requestGraphql({
    endpoint,
    document: taskDeleteOperation,
    operationName: 'DeleteTask',
    variables: {
      id,
      fail,
      delayMs
    },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({
    deleteTask: Schema.Struct({ id: Schema.String }),
  }))(data);

  if (decoded._tag === 'None' || decoded.value.deleteTask.id !== id) {
    throw new Error('Invalid GraphQL response for DeleteTask.');
  }

  return decoded.value.deleteTask.id;
}

export async function fetchTaskCreate({
  endpoint,
  operationId,
  input,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: Readonly<{
  endpoint: string;
  operationId: string;
  input: TaskCreateInput;
  fail?: boolean;
  delayMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>): Promise<Task> {
  const data = await requestGraphql({
    endpoint,
    document: taskCreateOperation,
    operationName: 'CreateTask',
    variables: {
      operationId,
      input,
      fail,
      delayMs
    },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({
    createTask: Schema.Struct({ operationId: Schema.String, task: taskSchema }),
  }))(data);

  if (
    decoded._tag === 'None' ||
    decoded.value.createTask.operationId !== operationId ||
    !decoded.value.createTask.task.id ||
    decoded.value.createTask.task.id.startsWith('temp:')
  ) {
    throw new Error('Invalid GraphQL response for CreateTask.');
  }

  return decoded.value.createTask.task;
}

/** Transport and validation only; each app owns optimistic/lifecycle orchestration. */
export async function fetchTaskUpdate({
  endpoint,
  id,
  patch,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: Readonly<{
  endpoint: string;
  id: string;
  patch: Partial<Omit<Task, 'id'>>;
  fail?: boolean;
  delayMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>): Promise<Task> {
  const data = await requestGraphql({
    endpoint,
    document: taskUpdateOperation,
    operationName: 'UpdateTask',
    variables: {
      id,
      patch,
      fail,
      delayMs
    },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ updateTask: taskSchema }))(data);

  if (decoded._tag === 'None' || decoded.value.updateTask.id !== id) {
    throw new Error('Invalid GraphQL response for UpdateTask.');
  }

  return decoded.value.updateTask;
}

/** Fetch-only client: callers run this network boundary inside an Effect. */
export async function fetchTrackerPage({
  endpoint,
  after,
  query,
  fail = false,
  fetcher = fetch,
  signal,
}: Readonly<{
  endpoint: string;
  after: string | null;
  query: TaskQuery;
  fail?: boolean;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>): Promise<TaskPage> {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: trackerPageOperation,
      operationName: 'TrackerPage',
      variables: {
        after,
        query,
        fail
      }
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok)
    throw new Error(`GraphQL request failed (${response.status}).`);

  const body: unknown = await response.json();

  return decodeTrackerPage(body, { after });
}

/** Shared operation decoder for the fetch client and store-managed GraphQL API. */
export function decodeTrackerPage(body: unknown, { after }: Readonly<{ after: string | null }>): TaskPage {
  const errors = Schema.decodeUnknownOption(errorSchema)(body);

  if (errors._tag === 'Some' && errors.value.errors.length > 0) {
    throw new Error(errors.value.errors.map((error) => error.message).join('; '));
  }

  const decoded = Schema.decodeUnknownOption(responseSchema)(body);

  if (decoded._tag === 'None')
    throw new Error('Invalid GraphQL response for TrackerPage.');

  const data = decoded.value.data.tracker;

  if (
    data.tasks.edges.length > 20 ||
    (data.tasks.pageInfo.hasNextPage &&
      (!data.tasks.pageInfo.endCursor || data.tasks.pageInfo.endCursor === after))
  ) {
    throw new Error('Invalid GraphQL response: non-advancing cursor page.');
  }

  return {
    projects: data.projects,
    people: data.people,

    tasks: data.tasks.edges.map((edge) => edge.node),

    pageInfo: data.tasks.pageInfo,
    totalCount: data.tasks.totalCount,
    statusCounts: data.tasks.statusCounts
  };
}

export const fetchTaskPage: FetchPage = (input) => fetchTrackerPage({ endpoint: '/graphql', ...input });

export async function fetchInitialTrackerData({
  endpoint, fetcher,
}: Readonly<{
  endpoint: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>
}>): Promise<TaskPage> {
  return fetchTrackerPage({
    endpoint,
    after: null,
    query: defaultTaskQuery,
    ...(fetcher ? { fetcher } : {})
  });
}
