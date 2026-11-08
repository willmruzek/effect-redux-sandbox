import { produce } from 'immer';
import {
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import {
  createOptimisticFieldReducers,
  type OptimisticWrite
} from './optimisticField.js';

type Entity = { value: string | null; other: string };
type State = {
  entities: Record<string, Entity>;
  writes: Record<string, OptimisticWrite<string | null>>;
  blocked: boolean;
};
type Input = { readonly id: string; readonly value: string | null };

function setup() {
  const state: State = {
    entities: { a: { value: null, other: 'unchanged' } },
    writes: {},
    blocked: false,
  };
  const reducers = createOptimisticFieldReducers<State, Input>()({
    field: 'value',
    value: (input) => input.value,
    canStart: (state) => !state.blocked,

    select: (state, input) => {
      const entity = state.entities[input.id];

      return entity ? { entity, writes: state.writes, id: input.id } : undefined;
    },
  });

  return { state, reducers };
}

describe('optimistic field reducers', () => {
  test('captures a nullable original before applying optimism', () => {
    // Arrange: an entity with a null field.
    const { state, reducers } = setup();
    expectTypeOf<Parameters<typeof reducers.onConfirmed>[2]>().toEqualTypeOf<string | null>();

    // Act: apply the optimistic start within a reducer draft.
    const next = produce(state, (draft) => {
      reducers.onStarted(draft, { id: 'a', value: 'optimistic', requestId: 'owner' });
    });

    // Assert: only the selected field and its data-only pending record change.
    expect(next.entities.a).toEqual({ value: 'optimistic', other: 'unchanged' });
    expect(next.writes.a).toEqual({ status: 'saving', requestId: 'owner', original: null });
    expect(state.entities.a?.value).toBeNull();
  });

  test('uses the saved result rather than the optimistic input on confirmation', () => {
    // Arrange: pending optimism for the selected field.
    const { state, reducers } = setup();
    state.entities.a = { value: 'optimistic', other: 'unchanged' };
    state.writes.a = { status: 'saving', requestId: 'owner', original: null };

    // Act: confirm with a different saved value.
    const next = produce(state, (draft) => {
      reducers.onConfirmed(draft, { id: 'a', value: 'optimistic', requestId: 'owner' }, 'saved');
    });

    // Assert: the authoritative value replaces optimism and clears ownership.
    expect(next.entities.a?.value).toBe('saved');
    expect(next.writes.a).toBeUndefined();
  });

  test('restores the original while retaining a visible failure', () => {
    // Arrange: a pending field and another independently owned entity.
    const { state, reducers } = setup();
    state.entities.a = { value: 'optimistic', other: 'unchanged' };
    state.writes.b = { status: 'saving', requestId: 'other', original: 'other' };

    // Act: roll back the failed field.
    const next = produce(state, (draft) => {
      reducers.onFailed(
        draft,
        { id: 'a', value: 'optimistic', requestId: 'owner', error: 'Rejected' },
        { original: null },
      );
    });

    // Assert: rollback and error bookkeeping leave the independent write alone.
    expect(next.entities.a?.value).toBeNull();
    expect(next.writes.a).toEqual({ status: 'error', error: 'Rejected' });
    expect(next.writes.b).toEqual(state.writes.b);
  });

  test('leaves state unchanged when the app disallows a start', () => {
    // Arrange: an app-owned eligibility rule rejects the edit.
    const { state, reducers } = setup();
    state.blocked = true;

    // Act: attempt the blocked start.
    const next = produce(state, (draft) => {
      reducers.onStarted(draft, { id: 'a', value: 'optimistic', requestId: 'owner' });
    });

    // Assert: no optimistic value or pending record is created.
    expect(next).toBe(state);
  });

  test('does not block settlement when start eligibility changes', () => {
    // Arrange: deletion eligibility changed after a write already started.
    const { state, reducers } = setup();
    state.blocked = true;
    state.entities.a = { value: 'optimistic', other: 'unchanged' };
    state.writes.a = { status: 'saving', requestId: 'owner', original: null };

    // Act: settle the existing write.
    const next = produce(state, (draft) => {
      reducers.onConfirmed(draft, { id: 'a', value: 'optimistic', requestId: 'owner' }, null);
    });

    // Assert: start-only restrictions do not prevent authoritative settlement.
    expect(next.entities.a?.value).toBeNull();
    expect(next.writes.a).toBeUndefined();
  });

  test('preserves state when the selected entity is absent', () => {
    // Arrange: an absent entity.
    const { state, reducers } = setup();

    // Act: attempt a start without a target.
    const next = produce(state, (draft) => {
      reducers.onStarted(draft, { id: 'missing', value: 'optimistic', requestId: 'owner' });
    });

    // Assert: no orphaned write is introduced.
    expect(next).toBe(state);
  });
});
