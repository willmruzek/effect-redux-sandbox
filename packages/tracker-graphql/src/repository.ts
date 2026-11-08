import type {
  Person,
  Task,
  TaskField,
  TaskCreateInput,
  TrackerData
} from '@repo/project-tracker';

import { createBackendData } from './data.js';

export type TaskPatch = {
  readonly title?: string | null;
  readonly status?: string | null;
  readonly priority?: string | null;
  readonly projectId?: string | null;
  readonly assigneeId?: string | null;
  readonly description?: string | null;
};

export type TrackerRepository = {
  readonly generation: number;
  readonly read: () => TrackerData;
  readonly reset: () => void;
  readonly updatePerson: (input: Readonly<{
    id: string;
    name: string
  }>) => Person;
  readonly createTask: (input: TaskCreateInput) => Task;
  readonly deleteTask: (input: Readonly<{ id: string }>) => string;
  readonly updateTask: (input: Readonly<{
    id: string;
    patch: TaskPatch;
  }>) => Task;
};

function validateFields(data: TrackerData, input: Readonly<Record<TaskField, string | null>>): TaskCreateInput {
  const {
    title,
    status,
    priority,
    projectId,
    assigneeId
  } = input;

  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
    throw new Error('Task title must contain between 1 and 200 characters.');
  }

  if (status !== 'todo' && status !== 'in-progress' && status !== 'done')
    throw new Error('Invalid task status.');

  if (priority !== 'high' && priority !== 'medium' && priority !== 'low')
    throw new Error('Invalid task priority.');

  if (
    typeof projectId !== 'string' ||
    !data.projects.some((project) => project.id === projectId)
  ) {
    throw new Error('Unknown task project.');
  }

  if (assigneeId !== null && !data.people.some((person) => person.id === assigneeId)) {
    throw new Error('Unknown task assignee.');
  }

  return {
    title: title.trim(),
    status,
    priority,
    projectId,
    assigneeId
  };
}

function snapshot(data: TrackerData): TrackerData {
  return Object.freeze({
    projects: Object.freeze(data.projects.map((row) => Object.freeze({ ...row }))),
    people: Object.freeze(data.people.map((row) => Object.freeze({ ...row }))),
    tasks: Object.freeze(data.tasks.map((row) => Object.freeze({ ...row, description: row.description ?? '' }))),
  });
}

/** One explicitly owned server-memory dataset; snapshots never expose writable state. */
export function createTrackerRepository({
  seed = createBackendData(),
}: Readonly<{ seed?: TrackerData }> = {}): TrackerRepository {
  const initial = snapshot(seed);
  let data = initial;
  let generation = 0;

  return {
    get generation() {
      return generation;
    },

    read: () => data,

    reset: () => {
      generation += 1;
      data = initial;
    },

    updatePerson: ({ id, name }) => {
      const current = data.people.find((person) => person.id === id);

      if (!current)
        throw new Error(`Unknown person: ${id}.`);

      const normalizedName = name.trim();

      if (!normalizedName || normalizedName.length > 120) {
        throw new Error('Person name must contain between 1 and 120 characters.');
      }

      const initials = normalizedName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
      const updated: Person = Object.freeze({
        ...current,
        name: normalizedName,
        initials
      });

      data = Object.freeze({
        ...data,
        people: Object.freeze(data.people.map((person) => person.id === id ? updated : person)),
      });

      return updated;
    },

    createTask: (input) => {
      const validated = validateFields(data, input);
      const id = `TASK-${crypto.randomUUID()}`;
      const task: Task = Object.freeze({
        ...validated,
        id,
        description: '',
      });

      data = Object.freeze({ ...data, tasks: Object.freeze([...data.tasks, task]) });

      return task;
    },

    deleteTask: ({ id }) => {
      const current = data.tasks.find((task) => task.id === id);

      if (!current)
        throw new Error(`Unknown task: ${id}.`);

      data = Object.freeze({ ...data, tasks: Object.freeze(data.tasks.filter((task) => task.id !== id)) });

      return id;
    },

    updateTask: ({ id, patch }) => {
      const current = data.tasks.find((task) => task.id === id);

      if (!current)
        throw new Error(`Unknown task: ${id}.`);

      if (!Object.values(patch).some((value) => value !== undefined)) {
        throw new Error('Provide at least one task field to update.');
      }

      const title = patch.title === undefined ? current.title : patch.title;
      const status = patch.status === undefined ? current.status : patch.status;
      const priority = patch.priority === undefined ? current.priority : patch.priority;
      const projectId = patch.projectId === undefined ? current.projectId : patch.projectId;
      const assigneeId = patch.assigneeId === undefined ? current.assigneeId : patch.assigneeId;
      const validated = validateFields(data, {
        title,
        status,
        priority,
        projectId,
        assigneeId
      });
      const description = patch.description === undefined ? current.description : patch.description;

      if (
        description !== null &&
        (typeof description !== 'string' || description.length > 5000)
      ) {
        throw new Error('Task description must be 5000 characters or fewer.');
      }

      const updated: Task = Object.freeze({
        ...current,
        ...validated,
        description
      });

      data = Object.freeze({
        ...data,
        tasks: Object.freeze(data.tasks.map((task) => task.id === id ? updated : task))
      });

      return updated;
    },
  };
}
