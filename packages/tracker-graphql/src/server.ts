import {
  defaultTaskQuery,
  type TaskPage,
  type TaskQuery,
  type Task,
  type TaskCreateInput,
  type TaskPriority,
  type TaskStatus,
} from '@repo/project-tracker';

import {
  buildSchema,
  graphql
} from 'graphql';

import type {
  TaskPatch,
  TrackerRepository
} from './repository.js';

export { createTrackerRepository } from './repository.js';

export type { TaskPatch, TrackerRepository } from './repository.js';

const schema = buildSchema(`
  type Project { id: ID!, name: String!, code: String!, description: String! }
  type Person { id: ID!, name: String!, initials: String!, role: String! }
  type Task {
    id: ID!, projectId: ID!, assigneeId: ID, title: String!,
    status: String!, priority: String!, description: String
  }
  input TaskQuery { projectId: ID, status: String, search: String, assigneeId: String, sort: String }
  type PageInfo { endCursor: String, hasNextPage: Boolean! }
  type TaskEdge { cursor: String!, node: Task! }
  type StatusCount { status: String!, total: Int! }
  type TaskConnection {
    edges: [TaskEdge!]!, pageInfo: PageInfo!, totalCount: Int!, statusCounts: [StatusCount!]!
  }
  type Tracker { projects: [Project!]!, people: [Person!]!, tasks: TaskConnection! }
  input TaskPatch { title: String, status: String, priority: String, projectId: ID, assigneeId: ID, description: String }
  input TaskCreateInput { title: String!, status: String!, priority: String!, projectId: ID!, assigneeId: ID }
  type TaskCreation { operationId: ID!, task: Task! }
  type TaskDeletion { id: ID! }
  type Query {
    tracker(first: Int! = 20, after: String, query: TaskQuery, fail: Boolean! = false, delayMs: Int! = 0): Tracker!
    task(id: ID!): Task
  }
  type Mutation {
    deleteTask(id: ID!, fail: Boolean! = false, delayMs: Int! = 0): TaskDeletion!
    createTask(operationId: ID!, input: TaskCreateInput!, fail: Boolean! = false, delayMs: Int! = 0): TaskCreation!
    updateTask(id: ID!, patch: TaskPatch!, fail: Boolean! = false, delayMs: Int! = 0): Task!
    resetDemo: Boolean!
  }
`);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type TrackerConnection = {
  readonly projects: TaskPage['projects'];
  readonly people: TaskPage['people'];
  readonly tasks: {
    readonly edges: readonly {
      readonly node: Task;
      readonly cursor: string
    }[];
    readonly pageInfo: TaskPage['pageInfo'];
    readonly totalCount: TaskPage['totalCount'];
    readonly statusCounts: TaskPage['statusCounts'];
  };
};

export function readTrackerConnection(
  repository: TrackerRepository,
  {
    first,
    after,
    query: input,
    fail
  }: {
    readonly first: number;
    readonly after?: string | null;
    readonly query?: Partial<TaskQuery> | null;
    readonly fail?: boolean;
  }
): TrackerConnection {
  if (first < 1 || first > 20)
    throw new Error('first must be between 1 and 20.');

  if (fail)
    throw new Error('Simulated network failure. Retry this page.');

  const query = { ...defaultTaskQuery, ...input };

  if (
    !['all', 'todo', 'in-progress', 'done'].includes(query.status) ||
    !['id', 'title', 'priority'].includes(query.sort) ||
    typeof query.search !== 'string' ||
    typeof query.assigneeId !== 'string'
  ) {
    throw new Error('Invalid task query.');
  }

  query.search = query.search.trim().toLowerCase();

  const key = JSON.stringify([query.projectId, query.status, query.search, query.assigneeId, query.sort]);
  const data = repository.read();
  const matching = data.tasks.filter((task) =>
    (query.projectId === null || task.projectId === query.projectId) &&
    (query.assigneeId === '' ||
      (query.assigneeId === 'unassigned' ? task.assigneeId === null : task.assigneeId === query.assigneeId)) &&
    task.title.toLowerCase().includes(query.search));
  const statuses: readonly TaskStatus[] = ['todo', 'in-progress', 'done'];
  const statusCounts = statuses.map((status) => ({
    status,
    total: matching.filter((task) => task.status === status).length,
  }));
  const rank: Readonly<Record<TaskPriority, number>> = {
    high: 0,
    medium: 1,
    low: 2
  };
  const rows = matching.filter((task) => query.status === 'all' || task.status === query.status).sort((a, b) =>
    (query.sort === 'priority' ? rank[a.priority] - rank[b.priority]
      : query.sort === 'title' ? compare(a.title, b.title) : compare(a.id, b.id)) ||
    compare(a.id, b.id));
  const cursor = (task: Task): string => btoa(Array.from(
    new TextEncoder().encode(JSON.stringify({
      version: 1,
      key,
      id: task.id
    })),
    (byte) => String.fromCharCode(byte),
  ).join(''));
  let start = 0;

  if (after !== null && after !== undefined) {
    let decoded: unknown;

    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(after), (character) => character.charCodeAt(0)),
      ));
    } catch {
      throw new Error('Invalid cursor.');
    }

    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      typeof decoded.id !== 'string' ||
      typeof decoded.key !== 'string'
    ) {
      throw new Error('Invalid cursor.');
    }

    if (decoded.key !== key)
      throw new Error('Cursor does not belong to this query.');

    const index = rows.findIndex((task) => task.id === decoded.id);

    if (index < 0)
      throw new Error('Invalid cursor: task is not in this result.');

    start = index + 1;
  }

  const page = rows.slice(start, start + first);
  const last = page.at(-1);

  return {
    projects: data.projects,
    people: data.people,
    tasks: {
      edges: page.map((node) => ({ node, cursor: cursor(node) })),

      pageInfo: {
        endCursor: last ? cursor(last) : null,
        hasNextPage: start + page.length < rows.length
      },
      totalCount: rows.length,
      statusCounts,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function wait(delayMs: number): Promise<void> {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) {
    throw new Error('delayMs must be an integer between 0 and 5000.');
  }

  if (delayMs > 0)
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

class RestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function restErrorResponse(error: unknown, headers: HeadersInit): Response {
  if (error instanceof RestError) {
    return Response.json({ error: error.message }, { status: error.status, headers });
  }

  if (error instanceof Error) {
    const status = error.message.startsWith('Unknown task:') ||
      error.message.startsWith('Unknown person:')
      ? 404
      : 400;

    return Response.json({ error: error.message }, { status, headers });
  }

  return Response.json(
    { error: 'Unexpected REST request failure.' },
    { status: 500, headers }
  );
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new RestError(400, 'Expected a JSON request body.');
  }

  if (!isRecord(body))
    throw new RestError(400, 'Expected a JSON object request body.');

  return body;
}

function parseInteger(value: string | null, fallback: number, name: string): number {
  if (value === null)
    return fallback;

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed))
    throw new RestError(400, `${name} must be an integer.`);

  return parsed;
}

function parseBoolean(value: string | null, fallback = false): boolean {
  if (value === null)
    return fallback;

  if (value === 'true')
    return true;

  if (value === 'false')
    return false;

  throw new RestError(400, 'Boolean query values must be true or false.');
}

function parseTaskQuery(params: URLSearchParams): TaskQuery {
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') ?? 'id';

  if (
    status !== 'all' &&
    status !== 'todo' &&
    status !== 'in-progress' &&
    status !== 'done'
  ) {
    throw new RestError(400, 'Invalid task status filter.');
  }

  if (sort !== 'id' && sort !== 'title' && sort !== 'priority') {
    throw new RestError(400, 'Invalid task sort order.');
  }

  return {
    projectId: params.get('projectId'),
    status,
    search: params.get('search') ?? '',
    assigneeId: params.get('assigneeId') ?? '',
    sort,
  };
}

function parseTaskPatch(value: unknown): TaskPatch {
  if (!isRecord(value))
    throw new RestError(400, 'Expected a task patch object.');

  const patch: {
    title?: string | null;
    status?: string | null;
    priority?: string | null;
    projectId?: string | null;
    assigneeId?: string | null;
    description?: string | null;
  } = {};
  const fields: readonly (keyof TaskPatch)[] = ['title', 'status', 'priority', 'projectId', 'assigneeId', 'description'];

  for (const field of fields) {
    if (!(field in value))
      continue;

    const fieldValue = value[field];

    if (fieldValue !== null && typeof fieldValue !== 'string') {
      throw new RestError(400, `Task ${field} must be a string or null.`);
    }

    patch[field] = fieldValue;
  }

  return patch;
}

function parseCreateInput(value: unknown): TaskCreateInput {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    (value.status !== 'todo' && value.status !== 'in-progress' && value.status !== 'done') ||
    (value.priority !== 'high' && value.priority !== 'medium' && value.priority !== 'low') ||
    typeof value.projectId !== 'string' ||
    (value.assigneeId !== null &&
      value.assigneeId !== undefined &&
      typeof value.assigneeId !== 'string')
  ) {
    throw new RestError(400, 'Invalid task creation input.');
  }

  const status: TaskStatus = value.status;
  const priority: TaskPriority = value.priority;

  return {
    title: value.title,
    status,
    priority,
    projectId: value.projectId,
    assigneeId: typeof value.assigneeId === 'string' ? value.assigneeId : null,
  };
}

async function waitForRepository(repository: TrackerRepository, delayMs: number): Promise<void> {
  const generation = repository.generation;

  await wait(delayMs);

  if (generation !== repository.generation)
    throw new Error('Demo was reset. Retry this operation.');
}

/** The REST handler shares the app-owned repository with GraphQL without sharing transport state. */
export function createRestHandler({
  repository,
}: Readonly<{ repository: TrackerRepository }>): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = { 'cache-control': 'no-store' };
    const { pathname, searchParams } = new URL(request.url);
    const segments = pathname.split('/').filter(Boolean);

    try {
      if (request.method === 'GET' && pathname === '/api/tracker') {
        const first = parseInteger(searchParams.get('first'), 20, 'first');
        const after = searchParams.get('after');
        const fail = parseBoolean(searchParams.get('fail'));
        const delayMs = parseInteger(searchParams.get('delayMs'), 0, 'delayMs');

        await waitForRepository(repository, delayMs);

        const result = readTrackerConnection(repository, {
          first,
          after,
          query: parseTaskQuery(searchParams),
          fail,
        });

        return Response.json({
          projects: result.projects,
          people: result.people,

          tasks: result.tasks.edges.map(({ node }) => node),

          pageInfo: result.tasks.pageInfo,
          totalCount: result.tasks.totalCount,
          statusCounts: result.tasks.statusCounts,
        }, { headers });
      }

      if (
        request.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks'
      ) {
        const id = decodeURIComponent(segments[2] ?? '');
        const task = repository.read().tasks.find((row) => row.id === id);

        if (!task)
          throw new Error(`Unknown task: ${id}.`);

        return Response.json(task, { headers });
      }

      if (request.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJsonBody(request);

        if (typeof body.operationId !== 'string')
          throw new RestError(400, 'A task creation operation ID is required.');

        const operationId = body.operationId;
        const input = parseCreateInput(body.input);
        const fail = body.fail ?? false;
        const delayMs = body.delayMs ?? 0;

        if (typeof fail !== 'boolean' || typeof delayMs !== 'number') {
          throw new RestError(400, 'Invalid task creation controls.');
        }

        await waitForRepository(repository, delayMs);

        if (fail)
          throw new Error('Simulated task creation failure. Retry this draft.');

        const task = repository.createTask(input);

        return Response.json({ operationId, task }, { headers });
      }

      if (
        request.method === 'PATCH' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks'
      ) {
        const id = decodeURIComponent(segments[2] ?? '');
        const body = await readJsonBody(request);
        const patch = parseTaskPatch(body.patch);
        const fail = body.fail ?? false;
        const delayMs = body.delayMs ?? 0;

        if (typeof fail !== 'boolean' || typeof delayMs !== 'number') {
          throw new RestError(400, 'Invalid task update controls.');
        }

        await waitForRepository(repository, delayMs);

        if (fail)
          throw new Error('Simulated task save failure. Change the field to retry.');

        return Response.json(repository.updateTask({ id, patch }), { headers });
      }

      if (
        request.method === 'DELETE' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks'
      ) {
        const id = decodeURIComponent(segments[2] ?? '');
        const body = await readJsonBody(request);
        const fail = body.fail ?? false;
        const delayMs = body.delayMs ?? 0;

        if (typeof fail !== 'boolean' || typeof delayMs !== 'number') {
          throw new RestError(400, 'Invalid task deletion controls.');
        }

        await waitForRepository(repository, delayMs);

        if (fail)
          throw new Error('Simulated task deletion failure. Retry this deletion.');

        return Response.json({ id: repository.deleteTask({ id }) }, { headers });
      }

      if (request.method === 'GET' && pathname === '/api/people') {
        return Response.json(repository.read().people, { headers });
      }

      if (
        request.method === 'PATCH' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'people'
      ) {
        const id = decodeURIComponent(segments[2] ?? '');
        const body = await readJsonBody(request);

        if (typeof body.name !== 'string')
          throw new RestError(400, 'Person name must be a string.');

        return Response.json(repository.updatePerson({ id, name: body.name }), { headers });
      }

      if (request.method === 'POST' && pathname === '/api/reset') {
        repository.reset();

        return Response.json({ reset: true }, { headers });
      }

      return Response.json({ error: 'REST route or method not found.' }, {
        status: 404, headers,
      });
    } catch (error) {
      return restErrorResponse(error, headers);
    }
  };
}

/** The app server owns the repository; the shared handler owns no global data. */
export function createGraphqlHandler({
  repository,
}: Readonly<{ repository: TrackerRepository }>): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = { 'cache-control': 'no-store' };

    if (request.method !== 'POST') {
      return Response.json({ errors: [{ message: 'Use POST for GraphQL operations.' }] }, {
        status: 405, headers: { ...headers, allow: 'POST' },
      });
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { errors: [{ message: 'Expected a JSON request body.' }] },
        { status: 400, headers }
      );
    }

    if (
      !isRecord(body) ||
      typeof body.query !== 'string' ||
      (body.operationName !== undefined && typeof body.operationName !== 'string') ||
      (body.variables !== undefined && body.variables !== null && !isRecord(body.variables))
    ) {
      return Response.json(
        { errors: [{ message: 'Expected query, optional operationName, and variables object.' }] },
        {
          status: 400, headers,
        }
      );
    }

    const result = await graphql({
      schema,
      source: body.query,
      operationName: body.operationName,
      variableValues: body.variables,
      rootValue: {
        task: ({ id }: Readonly<{ id: string }>) =>
          repository.read().tasks.find((task) => task.id === id) ?? null,

        deleteTask: async ({
          id,
          fail,
          delayMs
        }: Readonly<{
          id: string;
          fail: boolean;
          delayMs: number;
        }>) => {
          const generation = repository.generation;

          await wait(delayMs);

          if (generation !== repository.generation)
            throw new Error('Demo was reset. Retry this operation.');

          if (fail)
            throw new Error('Simulated task deletion failure. Retry this deletion.');

          return { id: repository.deleteTask({ id }) };
        },

        createTask: async ({
          operationId,
          input,
          fail,
          delayMs
        }: Readonly<{
          operationId: string;
          input: TaskCreateInput;
          fail: boolean;
          delayMs: number;
        }>) => {
          const generation = repository.generation;

          await wait(delayMs);

          if (generation !== repository.generation)
            throw new Error('Demo was reset. Retry this operation.');

          if (fail)
            throw new Error('Simulated task creation failure. Retry this draft.');

          return {
            operationId,
            task: repository.createTask({
              ...input, assigneeId: input.assigneeId ?? null,
            })
          };
        },

        tracker: async (input: {
          readonly first: number;
          readonly after?: string | null;
          readonly query?: Partial<TaskQuery> | null;
          readonly fail: boolean;
          readonly delayMs: number;
        }) => {
          await wait(input.delayMs);

          return readTrackerConnection(repository, input);
        },

        updateTask: async ({
          id,
          patch,
          fail,
          delayMs
        }: Readonly<{
          id: string;
          patch: TaskPatch;
          fail: boolean;
          delayMs: number;
        }>) => {
          const generation = repository.generation;

          await wait(delayMs);

          if (generation !== repository.generation)
            throw new Error('Demo was reset. Retry this operation.');

          if (fail) {
            const field = patch.status !== undefined ? 'status' : patch.priority !== undefined ? 'priority' : 'task';

            throw new Error(`Simulated ${field} save failure. Change the field to retry.`);
          }

          return repository.updateTask({ id, patch });
        },

        resetDemo: () => {
          repository.reset();

          return true;
        },
      },
    });

    return Response.json(result, { headers });
  };
}
