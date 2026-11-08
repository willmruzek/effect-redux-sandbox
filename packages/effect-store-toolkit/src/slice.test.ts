import {
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import {
  createSlice,
  type ExtraReducersBuilder,
  type PayloadAction
} from './slice.js';

const increment = Object.assign(
  (payload: number): PayloadAction<number, 'external/increment'> => ({
    type: 'external/increment',
    payload,
  }),
  { type: 'external/increment' satisfies 'external/increment' },
);

describe('external reducer registration', () => {
  test('handles an external action without generating a local action creator', () => {
    // Arrange: a typed external action registered explicitly.
    const slice = createSlice({
      name: 'counter',
      initialState: { count: 0 },
      reducers: () => ({}),

      extraReducers: (builder) => {
        builder.addCase(increment, (state, action) => {
          expectTypeOf(action.payload).toEqualTypeOf<number>();
          state.count += action.payload;
        });
      },
    });

    // Act: reduce the external action.
    const state = slice.reducer({ state: undefined, action: increment(2) });

    // Assert: Immer handles the update and no new creator is generated.
    expect(state).toEqual({ count: 2 });
    expect(slice.actions).toEqual({});
    expect(slice.getInitialState()).toEqual({ count: 0 });
  });

  test('rejects duplicate external action registrations', () => {
    // Arrange: two handlers for the same external action.
    const createDuplicate = () => createSlice({
      name: 'counter',
      initialState: { count: 0 },
      reducers: () => ({}),

      extraReducers: (builder) => {
        builder.addCase(increment, () => {});
        builder.addCase(increment, () => {});
      },
    });

    // Act / Assert: ambiguous registration fails during slice construction.
    expect(createDuplicate).toThrow('Duplicate reducer: external/increment');
  });

  test('rejects registrations after slice construction', () => {
    // Arrange: retain the builder passed during construction.
    let captured: ExtraReducersBuilder<{ count: number }> | undefined;
    createSlice({
      name: 'counter',
      initialState: { count: 0 },
      reducers: () => ({}),
      extraReducers: (builder) => {
        captured = builder;
      },
    });

    if (!captured)
      throw new Error('Missing registration builder.');

    const builder = captured;

    // Act / Assert: the closed builder cannot change reducer behavior later.
    expect(() => builder.addCase(increment, () => {}))
      .toThrow('Reducers can only be registered while creating a slice.');
  });
});
