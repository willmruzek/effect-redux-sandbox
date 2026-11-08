import {
  BasicIndex,
  createCollection,
  createLiveQueryCollection,
  eq,
  type Collection,
  type WithVirtualProps
} from '@tanstack/react-db';

import type {
  Person,
  Project,
  Task,
  TaskPreference,
  ScratchNote,
  TrackerSource,
  TrackerState
} from './index.js';

type Entity =
  | {
    readonly kind: 'project';
    readonly value: Project
  }
  | {
    readonly kind: 'person';
    readonly value: Person
  }
  | {
    readonly kind: 'task';
    readonly value: Task
  }
  | {
    readonly kind: 'taskPreference';
    readonly value: TaskPreference
  }
  | {
    readonly kind: 'scratchNote';
    readonly value: ScratchNote
  };

function entitiesFromStore(source: TrackerSource): Collection<Entity, string> {
  return createCollection({
    getKey: (entity: Entity): string =>
      `${entity.kind}:${entity.kind === 'taskPreference' ? entity.value.taskId : entity.value.id}`,

    startSync: true,
    gcTime: Infinity,
    sync: {
      rowUpdateMode: 'full',

      sync: ({
        begin,
        write,
        commit,
        markReady
      }) => {
        let previous: TrackerState | undefined;

        function reconcileRows<Row>(
          current: Readonly<Record<string, Row>>,
          before: Readonly<Record<string, Row>>,
          entity: (row: Row) => Entity,
        ): void {
          if (current === before)
            return;

          for (const [id, row] of Object.entries(before)) {
            if (!current[id])
              write({ type: 'delete', value: entity(row) });
          }

          for (const [id, row] of Object.entries(current)) {
            if (before[id] !== row)
              write({ type: before[id] ? 'update' : 'insert', value: entity(row) });
          }
        }

        const reconcile = () => {
          const current = source.getSnapshot();

          if (
            current.projects === previous?.projects &&
            current.people === previous.people &&
            current.tasks === previous.tasks &&
            current.taskPreferences === previous.taskPreferences &&
            current.scratchNotes === previous.scratchNotes
          )
            return;

          // One source publication lets the DB schedule every derived graph together.
          begin();
          reconcileRows(current.projects, previous?.projects ?? {}, (value) => ({ kind: 'project', value }));
          reconcileRows(current.people, previous?.people ?? {}, (value) => ({ kind: 'person', value }));
          reconcileRows(current.tasks, previous?.tasks ?? {}, (value) => ({ kind: 'task', value }));
          reconcileRows(current.taskPreferences, previous?.taskPreferences ?? {}, (value) => ({ kind: 'taskPreference', value }));
          reconcileRows(current.scratchNotes, previous?.scratchNotes ?? {}, (value) => ({ kind: 'scratchNote', value }));
          previous = current;
          commit();
        };
        const unsubscribe = source.subscribe(reconcile);

        reconcile();
        markReady();

        return { cleanup: unsubscribe };
      },
    },
  });
}

export type TrackerDatabase = {
  readonly projects: Collection<WithVirtualProps<Project>, string | number>;
  readonly people: Collection<WithVirtualProps<Person>, string | number>;
  readonly tasks: Collection<WithVirtualProps<Task>, string | number>;
  readonly taskPreferences: Collection<WithVirtualProps<TaskPreference>, string | number>;
  readonly scratchNotes: Collection<WithVirtualProps<ScratchNote>, string | number>;
  readonly dispose: () => Promise<void>;
};

/** Synchronously rebuilds request-local read views from the authoritative store snapshot. */
export function createTrackerDatabase(source: TrackerSource): TrackerDatabase {
  const entities = entitiesFromStore(source);
  const projects = createLiveQueryCollection({
    id: 'tracker-projects',
    startSync: true,
    gcTime: Infinity,

    getKey: (project) => project.id,

    query: (q) => q.from({ entity: entities })
      .where(({ entity }) => eq(entity.kind, 'project'))
      .fn.select(({ entity }): Project => {
        if (entity.kind !== 'project')
          throw new Error('Expected a project entity.');

        return entity.value;
      }),
  });
  const people = createLiveQueryCollection({
    id: 'tracker-people',
    startSync: true,
    gcTime: Infinity,

    getKey: (person) => person.id,

    query: (q) => q.from({ entity: entities })
      .where(({ entity }) => eq(entity.kind, 'person'))
      .fn.select(({ entity }): Person => {
        if (entity.kind !== 'person')
          throw new Error('Expected a person entity.');

        return entity.value;
      }),
  });
  const tasks = createLiveQueryCollection({
    id: 'tracker-tasks',
    startSync: true,
    gcTime: Infinity,

    getKey: (task) => task.id,

    query: (q) => q.from({ entity: entities })
      .where(({ entity }) => eq(entity.kind, 'task'))
      .fn.select(({ entity }): Task => {
        if (entity.kind !== 'task')
          throw new Error('Expected a task entity.');

        return entity.value;
      }),
  });
  const taskPreferences = createLiveQueryCollection({
    id: 'tracker-task-preferences',
    startSync: true,
    gcTime: Infinity,
    getKey: (preference) => preference.taskId,
    query: (q) => q.from({ entity: entities })
      .where(({ entity }) => eq(entity.kind, 'taskPreference'))
      .fn.select(({ entity }): TaskPreference => {
        if (entity.kind !== 'taskPreference')
          throw new Error('Expected a task preference.');

        return entity.value;
      }),
  });
  const scratchNotes = createLiveQueryCollection({
    id: 'tracker-scratch-notes',
    startSync: true,
    gcTime: Infinity,
    getKey: (note) => note.id,
    query: (q) => q.from({ entity: entities })
      .where(({ entity }) => eq(entity.kind, 'scratchNote'))
      .fn.select(({ entity }): ScratchNote => {
        if (entity.kind !== 'scratchNote')
          throw new Error('Expected a scratch note.');

        return entity.value;
      }),
  });

  tasks.createIndex((task) => task.projectId, { indexType: BasicIndex, name: 'tasks-project' });
  tasks.createIndex((task) => task.assigneeId, { indexType: BasicIndex, name: 'tasks-assignee' });
  taskPreferences.createIndex((preference) => preference.taskId, { indexType: BasicIndex, name: 'task-preferences-id' });
  projects.createIndex((project) => project.id, { indexType: BasicIndex, name: 'projects-id' });
  people.createIndex((person) => person.id, { indexType: BasicIndex, name: 'people-id' });

  return {
    projects,
    people,
    tasks,
    taskPreferences,
    scratchNotes,

    dispose: () => entities.cleanup({ dependents: true }),
  };
}
