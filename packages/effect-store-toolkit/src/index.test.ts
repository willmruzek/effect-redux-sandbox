import {
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import {
  createSlice,
  type PayloadAction,
  type SliceActions,
  type SliceBuilder
} from './index.js';

type State = {
  readonly count: number;
  readonly nested: { readonly values: readonly number[] };
  readonly untouched: { readonly label: string };
};

function makeSlice() {
  return createSlice({
    name: 'counter',

    initialState: (): State => ({
      count: 0,
      nested: { values: [] },
      untouched: { label: 'keep' }
    }),

    reducers: (slice) => ({
      added: slice.reducer('added', (state, action: PayloadAction<number>) => {
        state.count += action.payload;
        state.nested.values.push(action.payload);
      }),

      reset: slice.reducer('reset', () => ({
        count: 0,
        nested: { values: [] },
        untouched: { label: 'reset' },
      })),

      ignored: slice.reducer('ignored', () => { }),

      failed: slice.reducer('failed', (state) => {
        state.count = 999;
        throw new Error('Reducer failed');
      }),
    }),
  });
}

describe('createSlice', () => {
  test('generates namespaced actions with inferred payload types', () => {
    // Arrange: define a slice with payload and payloadless reducers.
    const slice = makeSlice();

    // Act: create a typed action.
    const action = slice.actions.added(3);

    // Assert: literal names and payload types survive generation.
    expect(action).toEqual({ type: 'counter/added', payload: 3 });
    expect(slice.actions.added.type).toBe('counter/added');
    expect(slice.actions.reset()).toEqual({ type: 'counter/reset', payload: undefined });
    expectTypeOf(action).toEqualTypeOf<PayloadAction<number, 'counter/added'>>();
    expectTypeOf(slice.actions.added).parameter(0).toEqualTypeOf<number>();
    expectTypeOf<SliceActions<typeof slice.actions>>().extract<{ type: 'counter/added' }>()
      .toEqualTypeOf<PayloadAction<number, 'counter/added'>>();
  });

  test('updates drafts without mutating the previous snapshot', () => {
    // Arrange: retain an immutable snapshot.
    const slice = makeSlice();
    const state = slice.getInitialState();

    // Act: apply a nested draft mutation through the store-compatible reducer.
    const next = slice.reducer({ state, action: slice.actions.added(4) });

    // Assert: only changed branches receive new references.
    expect(next.count).toBe(4);
    expect(next.nested.values).toEqual([4]);
    expect(state.count).toBe(0);
    expect(state.nested.values).toEqual([]);
    expect(next.nested).not.toBe(state.nested);
    expect(next.untouched).toBe(state.untouched);
    expect(Object.isFrozen(next.nested.values)).toBe(true);
  });

  test('returns a replacement state from a case reducer', () => {
    // Arrange: start from non-default state.
    const slice = makeSlice();
    const state: State = {
      count: 9,
      nested: { values: [9] },
      untouched: { label: 'old' }
    };

    // Act: reset by returning a replacement.
    const next = slice.reducer({ state, action: slice.actions.reset() });

    // Assert: Immer publishes the replacement rather than the old draft.
    expect(next).toEqual({
      count: 0,
      nested: { values: [] },
      untouched: { label: 'reset' }
    });
  });

  test.each(['counter/ignored', 'other/added'])(
    'preserves snapshot identity for %s',
    (type) => {
      // Arrange: a no-op or unrelated action.
      const slice = makeSlice();
      const state = slice.getInitialState();

      // Act: pass the action through the reducer.
      const next = slice.reducer({ state, action: { type } });

      // Assert: subscribers can rely on reference equality.
      expect(next).toBe(state);
    }
  );

  test('does not publish partial mutations when a reducer throws', () => {
    // Arrange: a reducer mutates its draft before failing.
    const slice = makeSlice();
    const state = slice.getInitialState();

    // Act / Assert: propagate the failure without touching the old state.
    expect(() => slice.reducer({ state, action: slice.actions.failed() })).toThrow('Reducer failed');
    expect(state.count).toBe(0);
  });

  test('initializes undefined state with a fresh lazy snapshot', () => {
    // Arrange: a lazy initializer produces independent nested objects.
    const slice = makeSlice();
    const previous = slice.getInitialState();

    // Act: initialize directly through the reducer.
    const initial = slice.reducer({ state: undefined, action: { type: 'init' } });

    // Assert: initializers are evaluated per store, not at slice registration.
    expect(initial).toEqual(previous);
    expect(initial.nested).not.toBe(previous.nested);
    expect(Object.isFrozen(initial)).toBe(true);
  });

  test('accepts a static initial state', () => {
    // Arrange: callers may supply a value instead of a lazy initializer.
    const slice = createSlice({
      name: 'static',
      initialState: { count: 2 },

      reducers: () => ({})
    });

    // Act: read the initial state.
    const initial = slice.getInitialState();

    // Assert: static state uses the same immutable boundary.
    expect(initial).toEqual({ count: 2 });
    expect(Object.isFrozen(initial)).toBe(true);
  });

  test('rejects duplicate reducer registrations', () => {
    // Arrange: two keys attempt to register the same action type.
    // Act / Assert: report the invalid slice definition immediately.
    expect(() => createSlice({
      name: 'duplicate',
      initialState: { count: 0 },

      reducers: (slice) => ({
        first: slice.reducer('same', () => { }),

        second: slice.reducer('same', () => { }),
      }),
    })).toThrow('Duplicate reducer: duplicate/same');
  });

  test('supports primitive state replacement', () => {
    // Arrange: primitive states cannot be mutated as objects.
    const slice = createSlice({
      name: 'total',
      initialState: 0,

      reducers: (slice) => ({
        added: slice.reducer('added', (state, action: PayloadAction<number>) => state + action.payload),
      }),
    });

    // Act: return the next primitive value.
    const next = slice.reducer({ state: 2, action: slice.actions.added(3) });

    // Assert: the reducer preserves the state type.
    expect(next).toBe(5);
    expectTypeOf(next).toEqualTypeOf<number>();
  });

  test('rejects a reducer that both mutates and returns a replacement', () => {
    // Arrange: the recipe violates Immer's single-update-path contract.
    const slice = createSlice({
      name: 'invalid',
      initialState: { count: 0 },

      reducers: (slice) => ({
        changed: slice.reducer('changed', (state) => {
          state.count++;

          return { count: 10 };
        }),
      }),
    });
    const state = slice.getInitialState();

    // Act / Assert: surface the recipe error without changing the snapshot.
    expect(() => slice.reducer({ state, action: slice.actions.changed() })).toThrow(
      'An immer producer returned a new value *and* modified its draft',
    );
    expect(state.count).toBe(0);
  });

  test('closes registration after the slice callback finishes', () => {
    // Arrange: retain the builder past its definition phase.
    let builder: SliceBuilder<{ count: number }, 'closed'> | undefined;

    createSlice({
      name: 'closed',
      initialState: { count: 0 },

      reducers: (slice) => {
        builder = slice;

        return {};
      },
    });

    if (!builder)
      throw new Error('Builder was not provided');

    const registered = builder;

    // Act / Assert: late registration fails instead of changing an active reducer.
    expect(() => registered.reducer('late', () => { })).toThrow(
      'Reducers can only be registered while creating a slice.',
    );
  });
});
