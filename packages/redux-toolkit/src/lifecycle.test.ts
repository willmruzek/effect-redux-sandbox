import {
  Effect,
  Fiber
} from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test
} from 'vitest';

import { createSlice } from '@reduxjs/toolkit';

import {
  createRequestLifecycle,
  type RequestActions,
} from './index.js';

type Pending = {
  readonly requestId: string;
  readonly original: string
};
type Input = {
  readonly id: string;
  readonly value: string
};
type State = {
  readonly values: Readonly<Record<string, string>>;
  readonly pending: Readonly<Record<string, Pending>>;
  readonly errors: Readonly<Record<string, string>>;
};

function setup(register = true) {
  const edit = createRequestLifecycle<State, string>()('writes/edit', {
    pending: (state, input: Input) => state.pending[input.id],
  });
  const handlers = edit.reducers({
    onStarted: (state, payload) => {
      state.pending[payload.id] = {
        requestId: payload.requestId,
        original: state.values[payload.id] ?? '',
      };
      state.values[payload.id] = payload.value;
    },

    onConfirmed: (state, payload, result) => {
      state.values[payload.id] = result;
      delete state.pending[payload.id];
    },

    onFailed: (state, payload, pending) => {
      state.values[payload.id] = pending.original;
      state.errors[payload.id] = payload.error;
      delete state.pending[payload.id];
    },
  });
  const owner = createSlice({
    name: 'writes',
    initialState: (): State => ({
      values: { a: 'original', b: 'other' },
      pending: {},
      errors: {},
    }),

    reducers: {},

    extraReducers: (builder) => {
      if (!register)
        return;

      builder.addCase(edit.actions.started, handlers.started);
      builder.addCase(edit.actions.confirmed, handlers.confirmed);
      builder.addCase(edit.actions.failed, handlers.failed);
    },
  });

  const api = {
    getInitialState: owner.getInitialState,
    reducer: ({ state, action }: Readonly<{
      state: State;
      action: { readonly type: string }
    }>) => owner.reducer(state, action),
  };

  let state = api.getInitialState();
  const actions: string[] = [];
  const payloads: unknown[] = [];
  const store = {
    getState: Effect.sync(() => state),

    dispatch: (action: RequestActions<{ edit: typeof edit }>) => Effect.sync(() => {
      state = api.reducer({ state, action });
      actions.push(action.type);
      payloads.push(action.payload);
    }),
  };

  return {
    api,
    edit,
    store,
    actions,
    payloads,
    snapshot: () => state,
  };
}

describe('request lifecycle', () => {
  test('runs with handwritten reducers without using the guarded case helpers', async () => {
    // Arrange: a lifecycle and a plain data-only reducer owned by the consumer.
    const edit = createRequestLifecycle<State, string>()('writes/edit', {
      pending: (state, input: Input) => state.pending[input.id],
    });
    let state: State = {
      values: { a: 'original' },
      pending: {},
      errors: {},
    };

    function reduce(action: RequestActions<{ edit: typeof edit }>): State {
      switch (action.type) {
        case 'writes/editStarted':
          return {
            ...state,
            pending: {
              ...state.pending,
              [action.payload.id]: {
                requestId: action.payload.requestId,
                original: state.values[action.payload.id] ?? '',
              },
            },
          };

        case 'writes/editConfirmed':
          return {
            ...state,
            values: { ...state.values, [action.payload.id]: action.payload.result },
            pending: {},
          };

        case 'writes/editFailed':
          return { ...state, pending: {}, errors: { [action.payload.id]: action.payload.error } };
      }
    }

    // Act: execution publishes actions to the handwritten reducer.
    await Effect.runPromise(edit.run({
      store: {
        getState: Effect.sync(() => state),

        dispatch: (action) => Effect.sync(() => {
          state = reduce(action);
        }),
      },
      input: { id: 'a', value: 'optimistic' },
      execute: async () => 'saved',
    }));

    // Assert: the runner needs ownership data, not toolkit reducer registration.
    expect(state.values.a).toBe('saved');
    expect(state.pending).toEqual({});
  });

  test('fails explicitly when the receiving store has not registered ownership reducers', async () => {
    // Arrange: a valid standalone lifecycle with no registered handlers.
    const { edit, store, snapshot } = setup(false);
    let executed = false;

    // Act: run against the unregistered store.
    await expect(Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'optimistic' },

      execute: async () => {
        executed = true;
        return 'saved';
      },
    }))).rejects.toThrow('Could not claim writes/edit request.');

    // Assert: constructing the operation never installs reducers or mutates state.
    expect(edit).not.toHaveProperty('reducer');
    expect(executed).toBe(false);
    expect(snapshot().pending).toEqual({});
    expect(snapshot().values.a).toBe('original');
  });

  test('lets another slice respond to its generated actions without owning the request', async () => {
    // Arrange: an independently registered observer of the lifecycle actions.
    const { edit, store } = setup();
    const observer = createSlice({
      name: 'observer',
      initialState: { confirmations: 0 },
      reducers: {},

      extraReducers: (builder) => {
        builder.addCase(edit.actions.confirmed, (state, action) => {
          expectTypeOf(action.payload.result).toEqualTypeOf<string>();
          state.confirmations += 1;
        });
      },
    });
    let observed = observer.getInitialState();

    // Act: publish the same actions to both registered reducers.
    await Effect.runPromise(edit.run({
      store: {
        getState: store.getState,

        dispatch: (action) => store.dispatch(action).pipe(Effect.andThen(() =>
          Effect.sync(() => {
            observed = observer.reducer(observed, action);
          }))),
      },
      input: { id: 'a', value: 'optimistic' },
      execute: async () => 'saved',
    }));

    // Assert: registration is independent of the lifecycle definition.
    expect(observed.confirmations).toBe(1);
  });

  test('infers input and saved result while generating lifecycle metadata', async () => {
    // Arrange: the standalone operation defines input and result types.
    const { edit, store, actions, payloads, snapshot } = setup();
    expectTypeOf<Parameters<typeof edit.run>[0]['input']>().toEqualTypeOf<Input>();
    expectTypeOf<Parameters<typeof edit.actions.confirmed>[0]['result']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof edit.actions.started>[0]['requestId']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof edit.actions.failed>[0]['error']>().toEqualTypeOf<string>();
    let requestId: string | undefined;

    // Act: execution returns only saved data, without request metadata.
    await Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'optimistic' },

      execute: async () => {
        requestId = snapshot().pending.a?.requestId;
        return 'saved';
      },
    }));

    // Assert: generated actions and ownership are intact.
    expect(requestId).toEqual(expect.any(String));
    expect(snapshot().values.a).toBe('saved');
    expect(snapshot().pending.a).toBeUndefined();
    expect(actions).toEqual(['writes/editStarted', 'writes/editConfirmed']);
    expect(payloads).toEqual([
      { id: 'a', value: 'optimistic', requestId },
      { id: 'a', value: 'optimistic', requestId, result: 'saved' },
    ]);
  });

  test('ignores settlement from a request that does not own the write', () => {
    // Arrange: a newer edit owns the entity.
    const { api, edit } = setup();
    const state = api.reducer({
      state: api.getInitialState(),
      action: edit.actions.started({ id: 'a', requestId: 'new', value: 'optimistic' }),
    });

    // Act: an older request tries to confirm.
    const result = api.reducer({
      state,
      action: edit.actions.confirmed({
        id: 'a',
        requestId: 'old',
        value: 'optimistic',
        result: 'stale',
      }),
    });

    // Assert: the optimistic value and its owner remain unchanged.
    expect(result).toBe(state);
    expect(result.values.a).toBe('optimistic');
  });

  test('builds failure metadata and rolls back only the failed entity', async () => {
    // Arrange: another independently owned write remains pending.
    const { edit, store, payloads, snapshot } = setup();
    await Effect.runPromise(store.dispatch(edit.actions.started({
      id: 'b',
      requestId: 'other',
      value: 'optimistic',
    })));

    // Act: execution throws without constructing a failure payload.
    const outcome = await Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'optimistic' },

      execute: async () => {
        throw new Error('Rejected');
      },
    }));

    // Assert: the original input identifies the rollback and preserves the other write.
    expect(outcome).toEqual({ status: 'failed', error: 'Rejected' });
    expect(snapshot().values).toEqual({ a: 'original', b: 'optimistic' });
    expect(snapshot().pending.b?.requestId).toBe('other');
    expect(snapshot().errors.a).toBe('Rejected');
    expect(payloads.at(-1)).toEqual({
      id: 'a',
      value: 'optimistic',
      requestId: expect.any(String),
      error: 'Rejected',
    });
  });

  test.each(['success', 'failure'])('suppresses a superseded %s without settling the new owner', async (settlement) => {
    // Arrange: execution will relinquish ownership before its response arrives.
    const { edit, store, snapshot } = setup();

    // Act: a replacement edit claims ownership during the old execution.
    const outcome = await Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'first' },

      execute: async () => {
        const pending = snapshot().pending.a;

        if (!pending)
          throw new Error('Missing started request.');

        await Effect.runPromise(store.dispatch(edit.actions.failed({
          id: 'a',
          value: 'first',
          requestId: pending.requestId,
          error: 'Replaced',
        })));
        await Effect.runPromise(store.dispatch(edit.actions.started({
          id: 'a',
          value: 'replacement',
          requestId: 'new-owner',
        })));

        if (settlement === 'failure')
          throw new Error('Stale failure');

        return 'stale result';
      },
    }));

    // Assert: neither stale outcome confirms nor rolls back the replacement.
    expect(outcome).toEqual({ status: 'superseded' });
    expect(snapshot().pending.a?.requestId).toBe('new-owner');
    expect(snapshot().values.a).toBe('replacement');
    expect(snapshot().errors.a).toBe('Replaced');
  });

  test('cleans up optimistic ownership when execution is interrupted', async () => {
    // Arrange: an abort-aware request that stays pending.
    const { edit, store, snapshot } = setup();
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let aborted = false;

    // Act: interrupt the owning execution.
    const fiber = Effect.runFork(edit.run({
      store,
      input: { id: 'a', value: 'optimistic' },

      execute: (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Aborted'));
        }, { once: true });
        notifyStarted();
      }),
    }));
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Assert: interruption cannot strand a pending write.
    expect(aborted).toBe(true);
    expect(snapshot().pending.a).toBeUndefined();
    expect(snapshot().values.a).toBe('original');
    expect(snapshot().errors.a).toBe('Request interrupted.');
  });

  test('does not execute a duplicate pending write', async () => {
    // Arrange: an existing owner for the same field.
    const { edit, store, snapshot } = setup();
    await Effect.runPromise(store.dispatch(edit.actions.started({
      id: 'a',
      requestId: 'owner',
      value: 'first',
    })));
    let executed = false;

    // Act: a second write tries to claim the field.
    await expect(Effect.runPromise(edit.run({
      store,
      input: { id: 'a', value: 'second' },

      execute: async () => {
        executed = true;
        return 'second';
      },
    }))).rejects.toThrow('Could not claim writes/edit request.');

    // Assert: neither execution nor cleanup disturbs the original owner.
    expect(executed).toBe(false);
    expect(snapshot().pending.a?.requestId).toBe('owner');
    expect(snapshot().values.a).toBe('first');
  });

  test('cleans up a write when publication throws after the optimistic transition', async () => {
    // Arrange: the started action commits before a subscriber throws.
    const { edit, store, snapshot } = setup();

    // Act: start through a failing publication boundary.
    await expect(Effect.runPromise(edit.run({
      store: {
        getState: store.getState,

        dispatch: (action) => store.dispatch(action).pipe(Effect.andThen(() =>
          Effect.sync(() => {
            if (action.type === edit.actions.started.type)
              throw new Error('Publication failed');
          }))),
      },

      input: { id: 'a', value: 'optimistic' },

      execute: async () => 'saved',
    }))).rejects.toThrow('Publication failed');

    // Assert: committed optimism is rolled back and the defect stays visible.
    expect(snapshot().pending.a).toBeUndefined();
    expect(snapshot().values.a).toBe('original');
    expect(snapshot().errors.a).toContain('Publication failed');
  });
});
