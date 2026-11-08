import {
  describe,
  expect,
  test,
  vi
} from 'vitest';
import {
  count,
  createLiveQueryCollection,
  eq
} from '@tanstack/react-db';

import { createTrackerDatabase } from './database.js';
import type { TrackerState } from './index.js';

function createSource() {
  let state: TrackerState = {
    projects: {
      p: {
        id: 'p',
        name: 'Test project',
        code: 'TST',
        description: 'A project'
      }
    },
    people: {
      u: {
        id: 'u',
        name: 'Test person',
        role: 'Designer',
        initials: 'TP'
      }
    },
    tasks: {
      t: {
        id: 't',
        projectId: 'p',
        assigneeId: 'u',
        title: 'Test task',
        status: 'todo',
        priority: 'high'
      }
    },
    selectedProjectId: null,
    statusFilter: 'all',
    request: { status: 'idle' },
    result: {
      loadedPages: 1,
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      ids: ['t'],
      pageInfo: { endCursor: null, hasNextPage: false },
      totalCount: 1,
      statusCounts: [{ status: 'todo', total: 1 }],
    },
    statusWrites: {},
    priorityWrites: {},
    assigneeWrites: {},
    personWrites: {},
    detailWrites: {},
  };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn((listener: () => void) => listeners.delete(listener));

  return {
    getSnapshot: () => state,

    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        unsubscribe(listener);
      };
    },

    unsubscribe,

    listenerCount: () => listeners.size,

    update: (next: TrackerState) => {
      state = next;

      for (const listener of listeners)
        listener();
    },
  };
}

describe('store-backed TanStack DB collections', () => {
  test('builds ready views synchronously from only the store snapshot', async () => {
    // Arrange: no separate DB hydration data exists.
    const source = createSource();

    // Act: construct the request-local read projection without awaiting preload.
    const database = createTrackerDatabase(source);

    // Assert: the first render can read the complete store-backed views.
    try {
      expect(database.tasks.status).toBe('ready');
      expect(database.projects.get('p')?.name).toBe('Test project');
      expect(database.people.get('u')?.name).toBe('Test person');
      expect(database.tasks.get('t')?.title).toBe('Test task');
      expect(database).not.toHaveProperty('client');
    } finally {
      await database.dispose();
    }
  });

  test('isolates read projections rebuilt from separate stores', async () => {
    // Arrange: independent browser/request scopes each own their store data.
    const first = createSource();
    const second = createSource();
    const firstDb = createTrackerDatabase(first);
    const secondDb = createTrackerDatabase(second);

    await Promise.all([firstDb.tasks.preload(), secondDb.tasks.preload()]);

    const task = first.getSnapshot().tasks.t;

    if (!task)
      throw new Error('Missing fixture task');

    // Act: change only the first source after hydration.
    first.update({ ...first.getSnapshot(), tasks: { t: { ...task, priority: 'low' } } });

    // Assert: stable IDs never imply shared data or store subscriptions.
    try {
      expect(firstDb.tasks.get('t')?.priority).toBe('low');
      expect(secondDb.tasks.get('t')?.priority).toBe('high');
      expect(firstDb.tasks).not.toBe(secondDb.tasks);
    } finally {
      await Promise.all([firstDb.dispose(), secondDb.dispose()]);
    }

    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(0);
  });

  test('rejects direct collection writes without changing store state', async () => {
    // Arrange: all collections are read-only store projections.
    const source = createSource();
    const database = createTrackerDatabase(source);

    await database.tasks.preload();

    const before = source.getSnapshot();

    // Act / Assert: no mutation handler accepts an optimistic DB write.
    try {
      expect(() => database.tasks.update('t', (draft) => {
        draft.priority = 'low';
      }))
        .toThrow("no 'onUpdate' handler");
      expect(source.getSnapshot()).toBe(before);
      expect(database.tasks.get('t')?.priority).toBe('high');
      expect(database.tasks.config.onUpdate).toBeUndefined();
      expect(database).not.toHaveProperty('setPriority');
    } finally {
      await database.dispose();
    }
  });

  test(
    'publishes related record changes as one coherent live-query result',
    async () => {
      // Arrange: observe synchronous publications, not a batched React render.
      const source = createSource();
      const database = createTrackerDatabase(source);
      const joined = createLiveQueryCollection({
        query: (q) => q.from({ task: database.tasks })
          .join({ project: database.projects }, ({ task, project }) => eq(task.projectId, project.id), 'inner')
          .join({ person: database.people }, ({ task, person }) => eq(task.assigneeId, person.id), 'left')
          .select(({
            task,
            project,
            person
          }) => ({
            id: task.id,
            title: task.title,
            project: project.name,
            person: person?.name,
          })),
      });

      await joined.preload();

      const publications: unknown[] = [];
      const subscription = joined.subscribeChanges(() => publications.push(
        Array.from(joined.values(), ({
          id,
          title,
          project,
          person
        }) => ({
          id,
          title,
          project,
          person
        })),
      ), { includeInitialState: false });

      // Act: rename all three related records in one source snapshot.
      source.update({
        ...source.getSnapshot(),
        projects: {
          p: {
            id: 'p',
            name: 'New project',
            code: 'NEW',
            description: 'Updated'
          }
        },
        people: {
          u: {
            id: 'u',
            name: 'New person',
            role: 'Designer',
            initials: 'NP'
          }
        },
        tasks: {
          t: {
            id: 't',
            projectId: 'p',
            assigneeId: 'u',
            title: 'New task',
            status: 'done',
            priority: 'low'
          }
        },
      });

      // Assert: no observer ever sees mixed old/new labels.
      try {
        expect(publications).toEqual([[{
          id: 't',
          title: 'New task',
          project: 'New project',
          person: 'New person'
        }]]);
      } finally {
        subscription.unsubscribe();
        await joined.cleanup();
        await database.dispose();
      }
    }
  );

  test(
    'publishes reassigned relationships without an intermediate missing person',
    async () => {
      // Arrange: a left join makes temporary missing relationships observable.
      const source = createSource();
      const database = createTrackerDatabase(source);
      const joined = createLiveQueryCollection({
        query: (q) => q.from({ task: database.tasks })
          .join({ person: database.people }, ({ task, person }) => eq(task.assigneeId, person.id), 'left')
          .select(({ task, person }) => ({ id: task.id, person: person?.name })),
      });

      await joined.preload();

      const publications: unknown[] = [];
      const subscription = joined.subscribeChanges(() => publications.push(
        Array.from(joined.values(), ({ id, person }) => ({ id, person })),
      ), { includeInitialState: false });

      // Act: remove the old person while assigning the task to a newly inserted person.
      source.update({
        ...source.getSnapshot(),
        people: {
          n: {
            id: 'n',
            name: 'Next person',
            role: 'Designer',
            initials: 'NP'
          }
        },
        tasks: {
          t: {
            id: 't',
            projectId: 'p',
            assigneeId: 'n',
            title: 'Test task',
            status: 'todo',
            priority: 'high'
          }
        },
      });

      // Assert: the joined result moves directly to the new assignment.
      try {
        expect(publications).toEqual([[{ id: 't', person: 'Next person' }]]);
      } finally {
        subscription.unsubscribe();
        await joined.cleanup();
        await database.dispose();
      }
    }
  );

  test.each(['insert', 'delete'])(
    'publishes a coherent project summary on related %s',
    async (operation) => {
      // Arrange: observe a grouped left join, including zero-task projects.
      const source = createSource();
      const database = createTrackerDatabase(source);
      const summaries = createLiveQueryCollection({
        query: (q) => q.from({ project: database.projects })
          .join({ task: database.tasks }, ({ project, task }) => eq(project.id, task.projectId), 'left')
          .groupBy(({ project }) => [project.id, project.name])
          .select(({ project, task }) => ({
            id: project.id,
            name: project.name,
            total: count(task?.id)
          })),
      });

      await summaries.preload();
      expect(Array.from(summaries.values(), ({
        id,
        name,
        total
      }) => ({
        id,
        name,
        total
      })))
        .toEqual([{
          id: 'p',
          name: 'Test project',
          total: 1
        }]);

      const publications: unknown[] = [];
      const subscription = summaries.subscribeChanges(() => publications.push(
        Array.from(summaries.values(), ({
          id,
          name,
          total
        }) => ({
          id,
          name,
          total
        })),
      ), { includeInitialState: false });
      const state = source.getSnapshot();

      // Act: publish related inserts or deletes in one immutable snapshot.
      source.update(operation === 'insert' ? {
        ...state,
        projects: {
          ...state.projects,
          n: {
            id: 'n',
            name: 'New project',
            code: 'NEW',
            description: 'Added'
          },
        },
        tasks: {
          ...state.tasks,
          n: {
            id: 'n',
            projectId: 'n',
            assigneeId: null,
            title: 'New task',
            status: 'todo',
            priority: 'low'
          },
        },
      } : {
        ...state,
        projects: {},
        people: {},
        tasks: {}
      });

      // Assert: no spurious zero-task intermediate group is emitted.
      try {
        expect(publications).toHaveLength(1);
        expect(publications[0]).toEqual(operation === 'insert'
          ? expect.arrayContaining([
            {
              id: 'p',
              name: 'Test project',
              total: 1
            },
            {
              id: 'n',
              name: 'New project',
              total: 1
            },
          ]) : []);
        expect(Array.from(summaries.values())).toHaveLength(operation === 'insert' ? 2 : 0);
      } finally {
        subscription.unsubscribe();
        await summaries.cleanup();
        await database.dispose();
      }
    }
  );

  test('ignores selection-only updates without publishing entity changes', async () => {
    // Arrange: observe a DB projection of source entities.
    const source = createSource();
    const database = createTrackerDatabase(source);
    const listener = vi.fn();
    const subscription = database.tasks.subscribeChanges(listener);

    // Act: change only shared UI selection.
    source.update({
      ...source.getSnapshot(),
      selectedProjectId: 'p',
      statusFilter: 'done'
    });

    // Assert: unchanged row references produce no DB notification.
    try {
      expect(listener).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      await database.dispose();
    }
  });

  test('maintains foreign-key indexes as task relationships change', async () => {
    // Arrange: create the indexed store projection.
    const source = createSource();
    const database = createTrackerDatabase(source);

    expect(source.listenerCount()).toBeGreaterThan(0);

    // Act: change a task's relationships in the source snapshot.
    source.update({
      ...source.getSnapshot(),
      tasks: {
        t: {
          id: 't',
          projectId: 'other',
          assigneeId: 'new',
          title: 'Moved task',
          status: 'todo',
          priority: 'high'
        }
      },
    });

    // Assert: both foreign-key indexes reflect current, not stale, keys.
    try {
      const indexes = Array.from(database.tasks.indexes.values());
      const projectIndex = indexes.find((index) => index.name === 'tasks-project');
      const assigneeIndex = indexes.find((index) => index.name === 'tasks-assignee');

      expect(projectIndex?.equalityLookup('other')).toEqual(new Set(['t']));
      expect(projectIndex?.equalityLookup('p')).toEqual(new Set());
      expect(assigneeIndex?.equalityLookup('new')).toEqual(new Set(['t']));
      expect(assigneeIndex?.equalityLookup('u')).toEqual(new Set());
    } finally {
      await database.dispose();
    }
  });

  test('hydrates all three entity collections from the store', async () => {
    // Arrange: create a source with valid relationships.
    const source = createSource();

    // Act: connect the database adapter.
    const database = createTrackerDatabase(source);

    // Assert: collections hold the store's rows, keyed by their entity IDs.
    try {
      expect(database.tasks.get('t')?.title).toBe('Test task');
      expect(database.projects.get('p')?.name).toBe('Test project');
      expect(database.people.get('u')?.name).toBe('Test person');
    } finally {
      await database.dispose();
    }
  });

  test(
    'reconciles inserts, updates, and deletes from immutable snapshots',
    async () => {
      // Arrange: retain stable references to the original rows.
      const source = createSource();
      const database = createTrackerDatabase(source);
      const state = source.getSnapshot();

      // Act: replace the source snapshot.
      source.update({
        ...state,
        people: {
          u: {
            id: 'u',
            name: 'Renamed person',
            role: 'Designer',
            initials: 'RP'
          }
        },
        tasks: {
          n: {
            id: 'n',
            projectId: 'p',
            assigneeId: 'u',
            title: 'New task',
            status: 'done',
            priority: 'low'
          }
        },
      });

      // Assert: DB state matches the source, without stale rows.
      try {
        expect(database.tasks.has('t')).toBe(false);
        expect(database.tasks.get('n')?.title).toBe('New task');
        expect(database.people.get('u')?.name).toBe('Renamed person');
      } finally {
        await database.dispose();
      }
    }
  );

  test('unsubscribes every collection on disposal', async () => {
    // Arrange: start all collection sync subscriptions.
    const source = createSource();
    const database = createTrackerDatabase(source);

    // Act: dispose the adapter.
    await database.dispose();

    // Assert: no source subscription remains active.
    expect(source.unsubscribe).toHaveBeenCalled();
    expect(source.listenerCount()).toBe(0);
  });
});
