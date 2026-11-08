import type {
  Person,
  Task,
  TaskCreateInput,
  TaskPage,
  TaskQuery,
} from '@repo/project-tracker';

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

const personSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  initials: Schema.String,
  role: Schema.String,
});

const taskPageSchema = Schema.Struct({
  projects: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    code: Schema.String,
    description: Schema.String,
  })),
  people: Schema.Array(personSchema),
  tasks: Schema.Array(taskSchema),
  pageInfo: Schema.Struct({
    endCursor: Schema.NullOr(Schema.String),
    hasNextPage: Schema.Boolean,
  }),
  totalCount: Schema.Number,
  statusCounts: Schema.Array(Schema.Struct({
    status: Schema.Literals(['todo', 'in-progress', 'done']),
    total: Schema.Number,
  })),
});

const personArraySchema = Schema.Array(personSchema);

type RequestOptions = Readonly<{
  endpoint: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}>;

async function requestJson({
  endpoint,
  path,
  method = 'GET',
  body,
  fetcher = fetch,
  signal,
}: RequestOptions & Readonly<{
  path: string;
  method?: string;
  body?: unknown;
}>): Promise<unknown> {
  const response = await fetcher(`${endpoint.replace(/\/$/, '')}${path}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });

  return readResponse(response);
}

function decodePage(value: unknown, after: string | null): TaskPage {
  const decoded = Schema.decodeUnknownOption(taskPageSchema)(value);

  if (decoded._tag === 'None')
    throw new Error('Invalid REST response for tracker page.');

  const page = decoded.value;

  if (
    page.tasks.length > 20 ||
    (page.pageInfo.hasNextPage &&
      (!page.pageInfo.endCursor || page.pageInfo.endCursor === after))
  ) {
    throw new Error('Invalid REST response: non-advancing cursor page.');
  }

  return page;
}

function decodeTask(value: unknown, id: string): Task {
  const decoded = Schema.decodeUnknownOption(taskSchema)(value);

  if (
    decoded._tag === 'None' ||
    decoded.value.id !== id ||
    decoded.value.description === undefined
  ) {
    throw new Error('Invalid REST response for task detail.');
  }

  return decoded.value;
}

function queryString({
  after,
  query,
  fail = false
}: Readonly<{
  after: string | null;
  query: TaskQuery;
  fail?: boolean;
}>): string {
  const params = new URLSearchParams({
    first: '20',
    status: query.status,
    search: query.search,
    assigneeId: query.assigneeId,
    sort: query.sort,
    fail: String(fail),
  });

  if (query.projectId !== null)
    params.set('projectId', query.projectId);

  if (after !== null)
    params.set('after', after);

  return params.toString();
}

export async function fetchRestTrackerPage({
  endpoint,
  after,
  query,
  fail = false,
  fetcher,
  signal,
}: RequestOptions & Readonly<{
  after: string | null;
  query: TaskQuery;
  fail?: boolean;
}>): Promise<TaskPage> {
  const value = await requestJson({
    endpoint,
    path: `/tracker?${queryString({
      after,
      query,
      fail
    })}`,
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });

  return decodePage(value, after);
}

export async function fetchRestTaskById({
  endpoint,
  id,
  fetcher = fetch,
  signal,
}: RequestOptions & Readonly<{ id: string }>): Promise<Task | null> {
  const response = await fetcher(`${endpoint.replace(/\/$/, '')}/tasks/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  if (response.status === 404)
    return null;

  const value = await readResponse(response);

  return decodeTask(value, id);
}

async function readResponse(response: Response): Promise<unknown> {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new Error(`REST response was not valid JSON (${response.status}).`);
  }

  if (!response.ok) {
    const error = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(value);

    throw new Error(error._tag === 'Some' ? error.value.error : `REST request failed (${response.status}).`);
  }

  return value;
}

export async function fetchRestPeople({
  endpoint,
  fetcher,
  signal,
}: RequestOptions): Promise<readonly Person[]> {
  const value = await requestJson({
    endpoint,
    path: '/people',
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(personArraySchema)(value);

  if (decoded._tag === 'None')
    throw new Error('Invalid REST response for people.');

  return decoded.value;
}

export async function fetchRestPersonUpdate({
  endpoint,
  id,
  name,
  fetcher,
  signal,
}: RequestOptions & Readonly<{
  id: string;
  name: string
}>): Promise<Person> {
  const value = await requestJson({
    endpoint,
    path: `/people/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: { name },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(personSchema)(value);

  if (decoded._tag === 'None' || decoded.value.id !== id) {
    throw new Error('Invalid REST response for person update.');
  }

  return decoded.value;
}

export async function fetchRestTaskCreate({
  endpoint,
  operationId,
  input,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: RequestOptions & Readonly<{
  operationId: string;
  input: TaskCreateInput;
  fail?: boolean;
  delayMs?: number;
}>): Promise<Task> {
  const value = await requestJson({
    endpoint,
    path: '/tasks',
    method: 'POST',
    body: {
      operationId,
      input,
      fail,
      delayMs
    },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({
    operationId: Schema.String,
    task: taskSchema,
  }))(value);

  if (
    decoded._tag === 'None' ||
    decoded.value.operationId !== operationId ||
    !decoded.value.task.id ||
    decoded.value.task.id.startsWith('temp:')
  ) {
    throw new Error('Invalid REST response for task creation.');
  }

  return decoded.value.task;
}

export async function fetchRestTaskUpdate({
  endpoint,
  id,
  patch,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: RequestOptions & Readonly<{
  id: string;
  patch: Partial<Omit<Task, 'id'>>;
  fail?: boolean;
  delayMs?: number;
}>): Promise<Task> {
  const value = await requestJson({
    endpoint,
    path: `/tasks/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: {
      patch,
      fail,
      delayMs
    },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });

  return decodeTask(value, id);
}

export async function fetchRestTaskDelete({
  endpoint,
  id,
  fail = false,
  delayMs = 0,
  fetcher,
  signal,
}: RequestOptions & Readonly<{
  id: string;
  fail?: boolean;
  delayMs?: number;
}>): Promise<string> {
  const value = await requestJson({
    endpoint,
    path: `/tasks/${encodeURIComponent(id)}`,
    method: 'DELETE',
    body: { fail, delayMs },
    ...(fetcher ? { fetcher } : {}),
    ...(signal ? { signal } : {}),
  });
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(value);

  if (decoded._tag === 'None' || decoded.value.id !== id) {
    throw new Error('Invalid REST response for task deletion.');
  }

  return decoded.value.id;
}
