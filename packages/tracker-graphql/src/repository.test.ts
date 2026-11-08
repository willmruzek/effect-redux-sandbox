import type { TrackerData } from '@repo/project-tracker';

import {
  describe,
  expect,
  test
} from 'vitest';

import { createTrackerRepository } from './repository.js';

function fixture(): TrackerData {
  return {
    projects: [{
      id: 'project',
      code: 'PRJ',
      name: 'Project',
      description: 'Demo'
    }],
    people: [{
      id: 'person',
      name: 'Person',
      initials: 'P',
      role: 'Designer'
    }],
    tasks: [{
      id: 'task',
      projectId: 'project',
      assigneeId: 'person',
      title: 'Original title',
      status: 'todo',
      priority: 'medium',
      description: '',
    }],
  };
}

describe('fake repository', () => {
  test('updates fields without revision preconditions', () => {
    // Arrange: the task starts with a title and an unassigned status.
    const repository = createTrackerRepository({ seed: fixture() });

    // Act: update the title without a revision token.
    const result = repository.updateTask({ id: 'task', patch: { title: 'New title' } });

    // Assert: the update is persisted and unrelated fields remain unchanged.
    expect(result).toMatchObject({
      title: 'New title',
      status: 'todo',
      priority: 'medium'
    });
  });

  test('retains updates across reads without modifying prior snapshots', () => {
    // Arrange: keep a snapshot before the update.
    const repository = createTrackerRepository({ seed: fixture() });
    const before = repository.read();

    // Act: apply a field update.
    const result = repository.updateTask({ id: 'task', patch: { status: 'done' } });

    // Assert: only the current snapshot has changed.
    expect(result.status).toBe('done');
    expect(repository.read().tasks[0]?.status).toBe('done');
    expect(before.tasks[0]?.status).toBe('todo');
  });

  test('keeps repository instances independent', () => {
    // Arrange: both instances start from the same seed object.
    const seed = fixture();
    const first = createTrackerRepository({ seed });
    const second = createTrackerRepository({ seed });

    // Act: change only the first instance.
    first.updateTask({ id: 'task', patch: { priority: 'high' } });

    // Assert: neither the second instance nor the seed was mutated.
    expect(second.read().tasks[0]?.priority).toBe('medium');
    expect(seed.tasks[0]?.priority).toBe('medium');
  });

  test('restores the seed on explicit reset', () => {
    // Arrange: the current data differs from its initial seed.
    const seed = fixture();
    const repository = createTrackerRepository({ seed });

    repository.updateTask({ id: 'task', patch: { title: 'Changed' } });

    const generation = repository.generation;

    // Act: reset the repository.
    repository.reset();

    // Assert: data and reset generation reflect a fresh demo.
    expect(repository.read()).toEqual(seed);
    expect(repository.generation).toBe(generation + 1);
  });

  test('exposes immutable snapshots', () => {
    // Arrange: provide an independent seed.
    const seed = fixture();
    const repository = createTrackerRepository({ seed: { ...seed, tasks: seed.tasks } });
    const snapshot = repository.read();

    // Act: read an entity exposed to a consumer.
    const task = snapshot.tasks[0];

    if (!task)
      throw new Error('Missing task fixture.');

    // Assert: exposed entity objects/arrays are immutable, including after reset.
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks)).toBe(true);
    repository.reset();
    expect(Object.isFrozen(repository.read().tasks[0])).toBe(true);
  });

  test.each([
    { title: '' }, { title: ' '.repeat(4) }, { title: 'x'.repeat(201) },
    { title: null }, { status: null }, { priority: null },
    { status: 'invalid' }, { priority: 'invalid' }, { projectId: null },
    { projectId: 'missing' }, { assigneeId: 'missing' }, { title: 'Valid', assigneeId: 'missing' }, {},
  ])('rejects invalid patches atomically: %j', (patch) => {
    // Arrange: observe the state before validation.
    const repository = createTrackerRepository({ seed: fixture() });
    const before = repository.read();

    // Act: submit a patch that must be rejected.
    expect(() => repository.updateTask({ id: 'task', patch })).toThrow();

    // Assert: no partial mutation escaped validation.
    expect(repository.read()).toBe(before);
  });

  test('rejects unknown task IDs explicitly', () => {
    // Arrange: a repository without the requested ID.
    const repository = createTrackerRepository({ seed: fixture() });

    // Act: attempt an update.
    const update = () => repository.updateTask({ id: 'missing', patch: { status: 'done' } });

    // Assert: the caller receives a useful failure.
    expect(update).toThrow('Unknown task: missing.');
  });

  test('accepts clearing an assignee without clearing omitted fields', () => {
    // Arrange: the task initially has an assignee.
    const repository = createTrackerRepository({ seed: fixture() });

    // Act: explicitly clear only its assignment.
    const result = repository.updateTask({ id: 'task', patch: { assigneeId: null } });

    // Assert: null and omission have different meanings.
    expect(result.assigneeId).toBeNull();
    expect(result.title).toBe('Original title');
  });
});
