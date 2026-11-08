import {
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import { createEntityTable } from './entities.js';

type Person = {
  readonly id: string;
  readonly name: string
};

describe('createEntityTable', () => {
  test('normalizes records by an explicit entity key', () => {
    // Arrange: the transport supplies flat records with a nonstandard key.
    const table = createEntityTable({
      name: 'people',

      key: (person: {
        uid: string;
        name: string
      }) => person.uid
    });

    // Act: normalize a decoded response.
    const records = table.normalize([{ uid: 'p', name: 'Pat' }]);

    // Assert: the table retains its entity type without transport metadata.
    expect(records).toEqual({ p: { uid: 'p', name: 'Pat' } });
    expect(table.name).toBe('people');
    expectTypeOf(records).toEqualTypeOf<Readonly<Record<string, {
      uid: string;
      name: string
    }>>>();
  });

  test('merges records without dropping entities from another response', () => {
    // Arrange: the same table can receive GraphQL and REST-normalized records.
    const table = createEntityTable({
      name: 'people',

      key: (person: Person) => person.id
    });
    const before = { p: { id: 'p', name: 'Old' }, q: { id: 'q', name: 'Keep' } };

    // Act: merge a later transport's normalized entities.
    const after = table.merge({ current: before, incoming: { p: { id: 'p', name: 'New' } } });

    // Assert: unrelated entities and the earlier snapshot are preserved.
    expect(after).toEqual({ p: { id: 'p', name: 'New' }, q: { id: 'q', name: 'Keep' } });
    expect(before.p.name).toBe('Old');
    expect(after.q).toBe(before.q);
  });

  test('scopes matching IDs by entity table', () => {
    // Arrange: two entity types use the same backend ID.
    const people = createEntityTable({
      name: 'people',

      key: (person: Person) => person.id
    });
    const teams = createEntityTable({
      name: 'teams',

      key: (team: {
        id: string;
        title: string
      }) => team.id
    });

    // Act: normalize each entity type independently.
    const entities = {
      people: people.normalize([{ id: '1', name: 'Pat' }]),
      teams: teams.normalize([{ id: '1', title: 'Design' }]),
    };

    // Assert: neither entity overwrites the other.
    expect(entities.people['1']?.name).toBe('Pat');
    expect(entities.teams['1']?.title).toBe('Design');
  });

  test.each(['', '   '])('rejects an empty entity key %j', (id) => {
    // Arrange: the decoder/mapping has not supplied a usable identity.
    const table = createEntityTable({
      name: 'people',

      key: (person: Person) => person.id
    });

    // Act / Assert: never silently cache an unidentifiable entity.
    expect(() => table.normalize([{ id, name: 'Pat' }])).toThrow('Invalid entity key for people.');
  });

  test('handles prototype-shaped IDs as ordinary records', () => {
    // Arrange: backend IDs need not be JavaScript-safe property names.
    const table = createEntityTable({
      name: 'people',

      key: (person: Person) => person.id
    });

    // Act: normalize an unusual ID.
    const records = table.normalize([{ id: '__proto__', name: 'Pat' }]);

    // Assert: the ID is an own data property, not prototype mutation.
    expect(Object.hasOwn(records, '__proto__')).toBe(true);
    expect(records['__proto__']).toEqual({ id: '__proto__', name: 'Pat' });
  });

  test('maps nested relationships to foreign keys before normalizing', () => {
    // Arrange: the GraphQL response has a nested assignee relationship.
    const people = createEntityTable({
      name: 'people',

      key: (person: Person) => person.id
    });
    const tasks = createEntityTable({
      name: 'tasks',

      key: (task: {
        id: string;
        assigneeId: string | null
      }) => task.id,
    });
    const response = { task: { id: 't', assignee: { id: 'p', name: 'Pat' } } };

    // Act: explicitly flatten relationships into the transport-neutral tables.
    const entities = {
      people: people.normalize([response.task.assignee]),
      tasks: tasks.normalize([{ id: response.task.id, assigneeId: response.task.assignee.id }]),
    };

    // Assert: only one person entity is stored, referenced by the task.
    expect(entities).toEqual({
      people: { p: { id: 'p', name: 'Pat' } },
      tasks: { t: { id: 't', assigneeId: 'p' } },
    });
  });
});
