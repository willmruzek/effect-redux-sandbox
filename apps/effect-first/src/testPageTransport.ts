import { Schema } from 'effect';

import type { FetchPage } from '@repo/project-tracker';

import type { TrackerApiTransportOptions } from './trackerApiDefinition';

const taskQuerySchema = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  status: Schema.Literals(['all', 'todo', 'in-progress', 'done']),
  search: Schema.String,
  assigneeId: Schema.String,
  sort: Schema.Literals(['id', 'title', 'priority']),
});

const pageInputSchema = Schema.Struct({
  after: Schema.NullOr(Schema.String),
  query: taskQuerySchema,
  fail: Schema.Boolean,
});

const graphqlRequestSchema = Schema.Struct({
  operationName: Schema.String,
  variables: Schema.Unknown,
});

function readPageInput(input: unknown) {
  const decoded = Schema.decodeUnknownOption(pageInputSchema)(input);

  if (decoded._tag === 'None')
    throw new Error('Invalid test page request.');

  return decoded.value;
}

function encodeGraphqlPage(page: Awaited<ReturnType<FetchPage>>) {
  return {
    data: {
      tracker: {
        projects: page.projects,
        people: page.people,
        tasks: {
          edges: page.tasks.map((node, index) => ({
            cursor: `${node.id}:${index}`,
            node,
          })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
          statusCounts: page.statusCounts,
        },
      },
    },
  };
}

export function createTestPageTransport(fetchPage: FetchPage): TrackerApiTransportOptions {
  return {
    graphqlFetcher: async (url, init) => {
      const request = new Request(new URL(url, 'http://localhost'), init);
      const body: unknown = await request.json();
      const requestData = Schema.decodeUnknownOption(graphqlRequestSchema)(body);

      if (requestData._tag === 'None')
        throw new Error('Invalid test GraphQL request.');

      if (requestData.value.operationName !== 'TrackerPage')
        return globalThis.fetch(url, init);

      const input = readPageInput(requestData.value.variables);
      const page = await fetchPage(input);

      return Response.json(encodeGraphqlPage(page));
    },
  };
}
