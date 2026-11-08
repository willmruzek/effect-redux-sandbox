import {
  beforeEach,
  describe,
  expect,
  test
} from 'vitest';

import { fetchTrackerPage } from './client.js';
import {
  createGraphqlHandler,
  createTrackerRepository
} from './server.js';

let handleApiRequest: (request: Request) => Promise<Response>;

beforeEach(() => {
  handleApiRequest = createGraphqlHandler({ repository: createTrackerRepository() });
});

import type {
  TaskQuery,
  Task
} from '@repo/project-tracker';

const query: TaskQuery = {
  projectId: null,
  status: 'all',
  search: '',
  assigneeId: '',
  sort: 'id'
};

const fetcher = async (url: string, init: RequestInit) => handleApiRequest(new Request(url, init));

const endpoint = 'http://localhost/graphql';

describe('backend cursor pagination', () => {
  test.each<TaskQuery['sort']>(['id', 'title', 'priority'])(
    'walks all 200 tasks exactly once sorted by %s',
    async (sort) => {
      // Arrange: independent cursor traversal with the real GraphQL transport.
      const ids: string[] = [];
      const tasks: Task[] = [];
      let after: string | null = null;
      let more = true;

      // Act: fetch until the server declares exhaustion.
      while (more) {
        const page = await fetchTrackerPage({
          endpoint,
          fetcher,
          query: { ...query, sort },
          after
        });

        expect(page.tasks.length).toBeLessThanOrEqual(20);
        expect(page.totalCount).toBe(200);
        expect(page.projects).toHaveLength(12);
        expect(page.people).toHaveLength(20);
        ids.push(...page.tasks.map((task) => task.id));
        tasks.push(...page.tasks);
        after = page.pageInfo.endCursor;
        more = page.pageInfo.hasNextPage;

        if (ids.length > 200)
          throw new Error('Cursor did not advance');
      }

      // Assert: bounded requests never skip or repeat a record.
      expect(ids).toHaveLength(200);
      expect(new Set(ids).size).toBe(200);

      const rank = {
        high: 0,
        medium: 1,
        low: 2
      };

      for (let index = 1; index < tasks.length; index++) {
        const previous = tasks[index - 1];
        const current = tasks[index];

        if (!previous || !current)
          throw new Error('Missing traversed task');

        const left = sort === 'priority' ? rank[previous.priority] : sort === 'title' ? previous.title : previous.id;
        const right = sort === 'priority' ? rank[current.priority] : sort === 'title' ? current.title : current.id;

        expect(left <= right).toBe(true);

        if (left === right)
          expect(previous.id < current.id).toBe(true);
      }
    }
  );

  test('applies combined filters before paging', async () => {
    // Arrange: target an existing named seed task.
    const filtered: TaskQuery = {
      ...query,
      projectId: 'atlas',
      assigneeId: 'mara',
      search: '  INFORMATION  ',
      status: 'in-progress'
    };

    // Act: ask the backend, not a local loaded subset.
    const page = await fetchTrackerPage({
      endpoint,
      fetcher,
      query: filtered,
      after: null
    });

    // Assert: the result and count describe the entire filtered backend set.
    expect(page.tasks.map((task) => task.id)).toEqual(['ATL-01']);
    expect(page.totalCount).toBe(1);
    expect(page.pageInfo.hasNextPage).toBe(false);
  });

  test('returns an empty terminal connection for literal wildcard search', async () => {
    // Arrange: SQL wildcard-looking text must be literal.
    // Act: query an empty result.
    const page = await fetchTrackerPage({
      endpoint,
      fetcher,
      query: { ...query, search: '%_' },
      after: null
    });

    // Assert: no cursor or next request is offered.
    expect(page.tasks).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
  });

  test('finds tasks beyond the initial fetched page', async () => {
    // Arrange: STU-02 sorts after the first twenty tasks.
    const first = await fetchTrackerPage({
      endpoint,
      fetcher,
      query,
      after: null
    });

    expect(first.tasks.some((task) => task.id === 'STU-02')).toBe(false);

    // Act: filter against the backend, not the fetched client rows.
    const page = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: null,
      query: {
        ...query,
        search: 'audit component',
        assigneeId: 'unassigned'
      },
    });

    // Assert: unloaded matching records are discoverable.
    expect(page.tasks.map((task) => task.id)).toEqual(['STU-02']);
    expect(page.totalCount).toBe(1);
  });

  test('status counts ignore selected status but follow other filters', async () => {
    // Arrange: restrict one project before selecting a status.
    const base = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: null,
      query: { ...query, projectId: 'atlas' }
    });

    // Act: select done within that same project.
    const done = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: null,
      query: {
        ...query,
        projectId: 'atlas',
        status: 'done'
      },
    });

    // Assert: badges still describe the other status options.
    expect(done.statusCounts).toEqual(base.statusCounts);
    expect(done.tasks.every((task) => task.status === 'done')).toBe(true);
    expect(done.totalCount).toBe(done.statusCounts.find((row) => row.status === 'done')?.total);
  });

  test('returns only the remaining rows on a partial final page', async () => {
    // Arrange: a title filter produces two full pages plus a remainder.
    const filtered = { ...query, search: 'review' };
    const first = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: null,
      query: filtered
    });
    const second = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: first.pageInfo.endCursor,
      query: filtered
    });

    // Act: continue after its second page.
    const last = await fetchTrackerPage({
      endpoint,
      fetcher,
      after: second.pageInfo.endCursor,
      query: filtered
    });

    // Assert: last-page metadata agrees with the exact filtered total.
    expect(last.tasks.length).toBeGreaterThan(0);
    expect(last.tasks.length).toBeLessThan(20);
    expect(first.tasks.length + second.tasks.length + last.tasks.length).toBe(first.totalCount);
    expect(last.pageInfo.hasNextPage).toBe(false);
  });

  test('rejects a cursor from a different filter sequence', async () => {
    // Arrange: obtain an unfiltered cursor.
    const first = await fetchTrackerPage({
      endpoint,
      fetcher,
      query,
      after: null
    });

    // Act: reuse that cursor for a different query.
    const result = fetchTrackerPage({
      endpoint,
      fetcher,
      query: { ...query, sort: 'priority' },
      after: first.pageInfo.endCursor
    });

    // Assert: mismatched cursors never silently skip data.
    await expect(result).rejects.toThrow('Cursor does not belong to this query');
  });

  test.each([0, -1, 21, 100000])('rejects unbounded page sizes: %s', async (first) => {
    // Arrange: bypass the client to exercise the server cap.
    const request = new Request(endpoint, {
      method: 'POST',
      body: JSON.stringify({ query: `query { tracker(first: ${first}) { tasks { edges { cursor } } } }` }),
    });

    // Act: execute the invalid size.
    const response = await handleApiRequest(request);

    // Assert: the backend never returns a full unbounded dataset.
    expect(await response.json()).toHaveProperty('errors');
  });

  test('rejects malformed cursors explicitly', async () => {
    // Arrange: invalid opaque transport value.
    // Act: attempt pagination.
    const result = fetchTrackerPage({
      endpoint,
      fetcher,
      query,
      after: 'bad-cursor'
    });

    // Assert: no restart-shaped success fallback.
    await expect(result).rejects.toThrow('Invalid cursor');
  });
});
