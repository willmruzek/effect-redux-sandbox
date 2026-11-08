import {
  describe,
  expect,
  test
} from 'vitest';

import {
  createInitialState,
  receiveTaskPage,
  type TrackerState,
  type TaskPage
} from './index.js';

function state(): TrackerState {
  return {
    projects: {},
    people: {},
    taskPreferences: {},
    scratchNotes: {},
    tasks: {
      t: {
        id: 't',
        projectId: 'p',
        assigneeId: null,
        title: 'A task',
        status: 'done',
        priority: 'low'
      }
    },
    selectedProjectId: null,
    statusFilter: 'all',
    request: {
      status: 'loading',
      requestId: 'current',
      after: null,
      sourceMode: 'graphql',
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      }
    },
    result: {
      loadedPages: 1,
      ids: ['t'],
      totalCount: 1,
      pageInfo: { endCursor: 'old', hasNextPage: true },
      query: {
        projectId: null,
        status: 'all',
        search: '',
        assigneeId: '',
        sort: 'id'
      },
      statusCounts: []
    },
    statusWrites: {
      t: {
        status: 'saving',
        requestId: 'status',
        original: 'todo'
      }
    },
    priorityWrites: {
      t: {
        status: 'saving',
        requestId: 'priority',
        original: 'high'
      }
    },
    assigneeWrites: {
      t: {
        status: 'saving',
        requestId: 'assignee',
        original: 'old-person'
      }
    },
    personWrites: {
      'old-person': {
        status: 'saving',
        requestId: 'person',
        original: 'Old Name'
      }
    },
    detailWrites: {},
  };
}

function page(): TaskPage {
  return {
    projects: [],
    people: [],
    tasks: [{
      id: 't',
      projectId: 'p',
      assigneeId: null,
      title: 'Server title',
      status: 'todo',
      priority: 'high'
    }],
    pageInfo: { endCursor: 'next', hasNextPage: true },
    totalCount: 2,
    statusCounts: [],
  };
}

describe('project tracker state', () => {
  test('accepts server values when no local write is pending', () => {
    // Arrange: no field writes are pending.
    const before = state();
    const incoming = page();
    const task = incoming.tasks[0];

    if (!task)
      throw new Error('Missing task fixture.');

    // Act: merge a server value for every ordinary task field.
    const after = receiveTaskPage({
      ...before,
      statusWrites: {},
      priorityWrites: {},
      assigneeWrites: {},
      personWrites: {},
    }, {
      requestId: 'current',
      page: {
        ...incoming, tasks: [{
          ...task,
          projectId: 'other',
          assigneeId: 'person'
        }]
      },
    });

    // Assert: server data replaces cached values without revision reconciliation.
    expect(after.tasks.t).toMatchObject({
      title: 'Server title',
      status: 'todo',
      priority: 'high',
      projectId: 'other',
      assigneeId: 'person',
    });
  });

  test('preserves pending assignee and person-name writes when a page arrives', () => {
    // Arrange: optimistic edits are active while the backend page still has old values.
    const before: TrackerState = {
      ...state(),
      tasks: {
        t: {
          id: 't',
          projectId: 'p',
          assigneeId: 'new-person',
          title: 'A task',
          status: 'done',
          priority: 'low'
        },
      },
      people: {
        'old-person': {
          id: 'old-person',
          name: 'New Name',
          initials: 'ON',
          role: 'Design'
        },
      },
    };
    const incoming = {
      ...page(),
      tasks: [{
        id: 't',
        projectId: 'p',
        assigneeId: 'old-person',
        title: 'A task',
        status: 'done' as const,
        priority: 'low' as const
      }],
      people: [{
        id: 'old-person',
        name: 'Old Name',
        initials: 'ON',
        role: 'Design'
      }],
    };

    // Act: merge the stale server page.
    const after = receiveTaskPage(before, { requestId: 'current', page: incoming });

    // Assert: both field-scoped local writes remain visible.
    expect(after.tasks.t?.assigneeId).toBe('new-person');
    expect(after.people['old-person']?.name).toBe('New Name');
  });

  test('seeds tasks with valid relationships', () => {
    // Arrange / Act: the seed factory is the subject under test.
    const initial = createInitialState();

    // Assert: every assigned task resolves both foreign keys.
    expect(Object.keys(initial.tasks)).toHaveLength(6);

    for (const task of Object.values(initial.tasks)) {
      expect(initial.projects[task.projectId]).toBeDefined();

      if (task.assigneeId !== null)
        expect(initial.people[task.assigneeId]).toBeDefined();
    }
  });

  test('ignores a stale page without changing cursor ownership', () => {
    // Arrange: another request owns the visible result.
    const before = state();

    // Act: an earlier response arrives.
    const after = receiveTaskPage(before, { requestId: 'old', page: page() });

    // Assert: entities, cursor, and result IDs stay unchanged.
    expect(after).toBe(before);
  });

  test('preserves pending optimistic fields when a backend page arrives', () => {
    // Arrange: status and priority writes are pending in the store.
    const before = state();

    // Act: merge old server field values.
    const after = receiveTaskPage(before, { requestId: 'current', page: page() });

    // Assert: pending optimistic values take precedence over fetched values.
    expect(after.tasks.t).toMatchObject({
      title: 'Server title',
      status: 'done',
      priority: 'low'
    });
    expect(after.result.pageInfo.endCursor).toBe('next');
    expect(after.statusWrites).toBe(before.statusWrites);
    expect(after.priorityWrites).toBe(before.priorityWrites);
  });

  test('replaces visible IDs while retaining cached off-view writes', () => {
    // Arrange: the server query no longer matches a pending task.
    const before = state();

    // Act: a replacement query returns no tasks.
    const after = receiveTaskPage(before, {
      requestId: 'current',
      page: {
        ...page(),
        tasks: [],
        totalCount: 0,
        pageInfo: { endCursor: null, hasNextPage: false }
      },
    });

    // Assert: the row is hidden, but later write settlement still has its record.
    expect(after.result.ids).toEqual([]);
    expect(after.tasks.t).toBe(before.tasks.t);
    expect(after.request.status).toBe('complete');
  });
});
