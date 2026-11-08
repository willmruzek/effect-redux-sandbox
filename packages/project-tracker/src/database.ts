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
  };

function entitiesFromStore(source: TrackerSource): Collection<Entity, string> {
  return createCollection({
    getKey: (entity: Entity): string => `${entity.kind}:${entity.value.id}`,

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

        function reconcileRows<Row extends { readonly id: string }>(
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
            current.tasks === previous.tasks
          )
            return;

          // One source publication lets the DB schedule every derived graph together.
          begin();
          reconcileRows(current.projects, previous?.projects ?? {}, (value) => ({ kind: 'project', value }));
          reconcileRows(current.people, previous?.people ?? {}, (value) => ({ kind: 'person', value }));
          reconcileRows(current.tasks, previous?.tasks ?? {}, (value) => ({ kind: 'task', value }));
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

  tasks.createIndex((task) => task.projectId, { indexType: BasicIndex, name: 'tasks-project' });
  tasks.createIndex((task) => task.assigneeId, { indexType: BasicIndex, name: 'tasks-assignee' });
  projects.createIndex((project) => project.id, { indexType: BasicIndex, name: 'projects-id' });
  people.createIndex((person) => person.id, { indexType: BasicIndex, name: 'people-id' });

  return {
    projects,
    people,
    tasks,

    dispose: () => entities.cleanup({ dependents: true }),
  };
}
