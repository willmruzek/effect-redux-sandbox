import {
  describe,
  expect,
  test,
} from 'vitest';

import { createOptimisticOwnership } from './index.js';

describe('optimistic ownership', () => {
  test('rejects all claims when any target is already owned', () => {
    // Arrange: one request owns a task's assignee field.
    const ownership = createOptimisticOwnership();
    const assignee = { table: 'tasks', id: '1', incarnation: '1', field: 'assigneeId' };
    const title = { table: 'tasks', id: '1', incarnation: '1', field: 'title' };
    ownership.claim({ requestId: 'first', targets: [assignee] });

    // Act: another request attempts to claim both fields.
    const result = ownership.claim({ requestId: 'second', targets: [title, assignee] });

    // Assert: the conflict does not reserve the independent field.
    expect(result).toEqual({ status: 'conflict' });
    expect(ownership.claim({ requestId: 'third', targets: [title] })).toEqual({ status: 'claimed' });
  });

  test('rejects duplicate targets before acquiring any claim', () => {
    // Arrange: a mutation declares the same field twice.
    const ownership = createOptimisticOwnership();
    const title = { table: 'tasks', id: '1', incarnation: '1', field: 'title' };

    // Act: attempt the invalid multi-target claim.
    const result = ownership.claim({ requestId: 'first', targets: [title, title] });

    // Assert: the invalid declaration leaves the field available.
    expect(result).toEqual({ status: 'invalid', error: 'Duplicate optimistic target.' });
    expect(ownership.claim({ requestId: 'second', targets: [title] })).toEqual({ status: 'claimed' });
  });

  test('releases only the fields belonging to the request', () => {
    // Arrange: independent mutations own different fields.
    const ownership = createOptimisticOwnership();
    const title = { table: 'tasks', id: '1', incarnation: '1', field: 'title' };
    const status = { table: 'tasks', id: '1', incarnation: '1', field: 'status' };
    ownership.claim({ requestId: 'first', targets: [title] });
    ownership.claim({ requestId: 'second', targets: [status] });

    // Act: release the first request.
    ownership.release('first');

    // Assert: the released field can be claimed but the other remains owned.
    expect(ownership.claim({ requestId: 'third', targets: [title] })).toEqual({ status: 'claimed' });
    expect(ownership.claim({ requestId: 'fourth', targets: [status] })).toEqual({ status: 'conflict' });
  });

  test('distinguishes a recreated entity from its previous incarnation', () => {
    // Arrange: a pending request owns a field on the original entity.
    const ownership = createOptimisticOwnership();
    const original = { table: 'tasks', id: '1', incarnation: 'old', field: 'title' };
    const replacement = { ...original, incarnation: 'new' };
    ownership.claim({ requestId: 'first', targets: [original] });

    // Act: claim the corresponding field on the replacement.
    const result = ownership.claim({ requestId: 'second', targets: [replacement] });

    // Assert: the two entity incarnations have independent claims.
    expect(result).toEqual({ status: 'claimed' });
  });
});
