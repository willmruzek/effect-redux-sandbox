import {
  Context,
  Cause,
  Effect,
  Exit,
  Fiber,
} from 'effect';
import {
  describe,
  expect,
  test,
} from 'vitest';

import {
  createOptimisticOwnership,
  createRestApi,
  type ApiRequest,
  type OptimisticTarget,
  type RequestActions,
  type RequestApiState,
  type Store,
} from './index.js';

type State = {
  readonly api: RequestApiState;
  readonly people: Readonly<Record<string, {
    readonly name: string;
    readonly role?: string;
    readonly incarnation?: string;
  }>>;
};

class ApiStore extends Context.Service<ApiStore, Store<State, { readonly type: string }>>()('test/optimisticApi/ApiStore') {}

type Fence = Readonly<{ identity: string; requestId: string }>;

function runEndpoint<StoreId, StoreShape, Variables extends object, Result>(
  endpoint: {
    readonly initiate: (
      variables: Variables,
      options?: Readonly<{ fence?: Fence }>,
    ) => Effect.Effect<Result, Error, StoreId>;
  },
  storeService: Context.Service<StoreId, StoreShape>,
  input: {
    readonly store: StoreShape;
    readonly variables: Variables;
    readonly fence?: Fence;
  },
): Effect.Effect<Result, Error> {
  return Effect.provideService(
    endpoint.initiate(
      input.variables,
      input.fence ? { fence: input.fence } : undefined,
    ),
    storeService,
    input.store,
  );
}

function selectRequest<State, Variables extends object>(
  endpoint: {
    readonly select: (variables: Variables) => (state: State) => ApiRequest | undefined;
  },
  state: State,
  variables: Variables,
): ApiRequest | undefined {
  return endpoint.select(variables)(state);
}

function mutationHarness(options: { readonly duplicateTarget?: boolean; readonly multipleFields?: boolean } = {}) {
  let settle: (response: Response) => void = () => { throw new Error('Transport not started.'); };
  let reject: (error: Error) => void = () => { throw new Error('Transport not started.'); };
  const pending = new Promise<Response>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  const ownership = createOptimisticOwnership();
  let transportCalls = 0;
  const api = createRestApi({
    name: 'people',
    basePath: '/api',
    storeService: ApiStore,
    fetcher: () => {
      transportCalls += 1;
      return pending;
    },
    getState: (state: State) => state.api,
    state: (state) => state.api,
    endpoints: (builder) => ({
      rename: builder.mutation('rename', {
        request: (variables: { readonly id: string; readonly name: string }) => ({
          path: `/people/${variables.id}`,
          method: 'PATCH',
          response: 'json',
        }),
        decode: (): string => 'Saved',
        normalize: (value: string) => value,
        optimistic: {
          ownership,
          targets: (state, variables) => {
            void state;
            const target = { table: 'people', id: variables.id, incarnation: variables.id, field: 'name' };
            if (options.multipleFields)
              return [target, { ...target, field: 'role' }];

            return options.duplicateTarget ? [target, target] : [target];
          },
          read: (state, target) => {
            const person = state.people[target.id];
            if (!person || (person.incarnation ?? target.id) !== target.incarnation)
              return undefined;

            return target.field === 'name' ? person.name : target.field === 'role' ? person.role : undefined;
          },
          proposed: (state, variables) => {
            void state;
            return variables.name;
          },
          confirmed: (result) => result,
          write: (state, target, value) => {
            const person = state.people[target.id];
            if (!person || typeof value !== 'string')
              throw new Error('Invalid person target.');
            if (target.field === 'name')
              person.name = value;
            else if (target.field === 'role')
              person.role = value;
            else
              throw new Error('Invalid person field.');
          },
        },
      }),
    }),
  });
  let state: State = {
    api: { requests: {}, latest: {} },
    people: { a: { name: 'Before', role: 'Original' } },
  };
  const store: ApiStore['Service'] = {
    getState: Effect.sync(() => state),
    dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
      state = api.reducer(api.endpoints.rename.optimisticReducer(state, action), action);
    }),
  };

  return {
    api,
    store,
    ownership,
    snapshot: () => state,
    transportCalls: () => transportCalls,
    removePerson: () => { state = { ...state, people: {} }; },
    replacePerson: () => {
      state = { ...state, people: { a: { name: 'Replacement', incarnation: 'new' } } };
    },
    removeRole: () => {
      const person = state.people.a;
      if (!person)
        throw new Error('Missing person.');
      state = { ...state, people: { ...state.people, a: { name: person.name } } };
    },
    settle: () => settle(Response.json({ ok: true })),
    reject,
  };
}

describe('factory optimistic mutations', () => {
  test('records an incomplete rollback when cancellation follows target deletion', async () => {
    // Arrange: delete the target while its optimistic request is pending.
    const app = mutationHarness();
    const variables = { id: 'a', name: 'After' };
    const fiber = Effect.runFork(runEndpoint(app.api.endpoints.rename, ApiStore, { store: app.store, variables }));
    app.removePerson();

    // Act: interrupt the pending transport.
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Assert: cancellation preserves uncertainty and the missing target identity.
    expect(selectRequest(app.api.endpoints.rename, app.snapshot(), variables)).toMatchObject({
      status: 'cancelled',
      serverMayHaveCommitted: true,
      rollback: {
        status: 'incomplete',
        missingTargets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
      },
    });
    expect(app.snapshot().people).toEqual({});
    expect(app.ownership.claim({
      requestId: 'retry',
      targets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
    })).toEqual({ status: 'claimed' });
  });

  test('restores surviving fields and reports missing fields during partial rollback', async () => {
    // Arrange: remove one target while a two-field write is pending.
    const app = mutationHarness({ multipleFields: true });
    const execution = Effect.runPromise(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store: app.store,
      variables: { id: 'a', name: 'After' },
    }));
    app.removeRole();

    // Act: reject the pending transport.
    app.reject(new Error('Network failed'));
    const result = await execution;

    // Assert: the surviving field is restored and only the missing target is reported.
    expect(app.snapshot().people.a).toEqual({ name: 'Before' });
    expect(result).toMatchObject({
      status: 'failed',
      rollback: {
        status: 'incomplete',
        missingTargets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'role' }],
      },
    });
  });

  test('publishes all target fields together on start and confirmation', async () => {
    // Arrange: observe each transition of a two-field mutation.
    const app = mutationHarness({ multipleFields: true });
    const observations: unknown[] = [];
    const store = {
      ...app.store,
      dispatch: (action: RequestActions<typeof app.api.endpoints>) => app.store.dispatch(action).pipe(
        Effect.tap(() => Effect.sync(() => observations.push(app.snapshot().people.a))),
      ),
    };

    // Act: complete the optimistic mutation.
    const execution = Effect.runPromise(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    }));
    app.settle();
    const outcome = await execution;

    // Assert: subscribers see complete updates, never a partial field set.
    expect(outcome).toEqual({ status: 'succeeded', result: 'Saved' });
    expect(observations).toEqual([
      { name: 'After', role: 'After' },
      { name: 'Saved', role: 'Saved' },
    ]);
  });

  test('fails before transport and releases ownership when the optimistic reducer is missing', async () => {
    // Arrange: install request metadata without the optimistic reducer.
    const app = mutationHarness();
    let state = app.snapshot();
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof app.api.endpoints>) => Effect.sync(() => {
        state = app.api.reducer(state, action);
      }),
    };

    // Act: run the mutation against the incomplete composition.
    const result = await Effect.runPromise(Effect.result(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    })));

    // Assert: the missing reducer is reported without starting transport or retaining the claim.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toContain('Optimistic reducer for rename is not installed.');
    expect(app.transportCalls()).toBe(0);
    expect(state.people.a?.name).toBe('Before');
    expect(app.ownership.claim({
      requestId: 'retry',
      targets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
    })).toEqual({ status: 'claimed' });
  });

  test('reports affected targets when cancellation rollback cannot be published', async () => {
    // Arrange: make the store reject publication of cancellation.
    const app = mutationHarness();
    const store = {
      ...app.store,
      dispatch: (action: RequestActions<typeof app.api.endpoints>) => {
        if (action.type === app.api.endpoints.rename.actions.cancelled.type)
          return Effect.die(new Error('Cancellation rollback failed'));

        return app.store.dispatch(action);
      },
    };
    const fiber = Effect.runFork(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    }));

    // Act: interrupt the pending request.
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    // Assert: the interrupted execution exposes the failed rollback and its targets.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const detail = Cause.pretty(exit.cause);
      expect(detail).toContain('Cancellation rollback failed');
      expect(detail).toContain('"table":"people"');
      expect(detail).toContain('"field":"name"');
    }
  });

  test('rejects duplicate targets before publishing state or starting transport', async () => {
    // Arrange: define a mutation that targets the same field twice.
    const app = mutationHarness({ duplicateTarget: true });
    const before = app.snapshot();

    // Act: attempt the invalid mutation.
    const outcome = await Effect.runPromise(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store: app.store,
      variables: { id: 'a', name: 'After' },
    }));

    // Assert: preflight rejects the duplicate without side effects.
    expect(outcome).toEqual({ status: 'failed', error: 'Duplicate optimistic target.' });
    expect(app.snapshot()).toBe(before);
    expect(app.transportCalls()).toBe(0);
  });

  test('leaves a replacement entity untouched when rollback follows ID reuse', async () => {
    // Arrange: replace the pending target with a different incarnation.
    const app = mutationHarness();
    const execution = Effect.runPromise(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store: app.store,
      variables: { id: 'a', name: 'After' },
    }));
    app.replacePerson();

    // Act: reject the original entity's request.
    app.reject(new Error('Network failed'));
    const outcome = await execution;

    // Assert: the replacement remains unchanged and rollback is incomplete.
    expect(app.snapshot().people.a).toEqual({ name: 'Replacement', incarnation: 'new' });
    expect(outcome).toMatchObject({
      status: 'failed',
      rollback: {
        status: 'incomplete',
        missingTargets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
      },
    });
  });

  test('preserves the confirmation error when post-commit cleanup fails', async () => {
    // Arrange: make confirmation and its error cleanup fail independently.
    const app = mutationHarness();
    const store = {
      ...app.store,
      dispatch: (action: RequestActions<typeof app.api.endpoints>) => {
        if (action.type === app.api.endpoints.rename.actions.succeeded.type)
          return Effect.die(new Error('Confirmation publication failed'));
        if (action.type === app.api.endpoints.rename.actions.postCommitFailed.type)
          return Effect.die(new Error('Cleanup publication failed'));

        return app.store.dispatch(action);
      },
    };
    const execution = Effect.runPromise(Effect.result(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    })));

    // Act: acknowledge the server response.
    app.settle();
    const result = await execution;

    // Assert: both post-commit publication failures remain observable.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.name).toBe('PostCommitError');
      expect(result.failure.message).toContain('Confirmation publication failed');
      expect(result.failure.message).toContain('Cleanup publication failed');
    }
  });

  test('preserves the original error when rollback publication fails', async () => {
    // Arrange: make the store reject publication of the failed action.
    const app = mutationHarness();
    const store = {
      ...app.store,
      dispatch: (action: RequestActions<typeof app.api.endpoints>) => {
        if (action.type === app.api.endpoints.rename.actions.failed.type)
          return Effect.die(new Error('Rollback publication failed'));

        return app.store.dispatch(action);
      },
    };
    const execution = Effect.runPromise(Effect.result(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    })));

    // Act: fail transport while the optimistic update is pending.
    app.reject(new Error('Network failed'));
    const result = await execution;

    // Assert: both failures are observable.
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain('Network failed');
      expect(result.failure.message).toContain('Rollback publication failed');
      expect(result.failure.message).toContain('"table":"people"');
      expect(result.failure.message).toContain('"field":"name"');
    }
  });

  test('fails preflight without transport when an optimistic target is missing', async () => {
    // Arrange: the target no longer exists before the operation starts.
    const app = mutationHarness();
    app.removePerson();
    const before = app.snapshot();

    // Act: attempt the mutation.
    const outcome = await Effect.runPromise(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store: app.store,
      variables: { id: 'a', name: 'After' },
    }));

    // Assert: no state transition or transport occurred.
    expect(outcome).toEqual({ status: 'failed', error: 'Missing optimistic target for rename.' });
    expect(app.snapshot()).toBe(before);
    expect(app.transportCalls()).toBe(0);
  });

  test('surfaces a post-commit error and releases ownership when the confirmed target is missing', async () => {
    // Arrange: delete the original target after an optimistic request starts.
    const app = mutationHarness();
    const run = Effect.runPromise(Effect.result(runEndpoint(app.api.endpoints.rename, ApiStore, {
      store: app.store,
      variables: { id: 'a', name: 'After' },
    })));
    app.removePerson();

    // Act: acknowledge the server response.
    app.settle();
    const outcome = await run;

    // Assert: no entity is recreated, and the claim and pending metadata are released.
    expect(outcome._tag).toBe('Failure');
    if (outcome._tag === 'Failure')
      expect(outcome.failure.name).toBe('PostCommitError');
    expect(app.snapshot().people).toEqual({});
    expect(selectRequest(app.api.endpoints.rename, app.snapshot(), { id: 'a', name: 'After' })?.status)
      .not.toBe('pending');
    expect(app.ownership.claim({
      requestId: 'retry',
      targets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
    })).toEqual({ status: 'claimed' });
  });

  test('reports an incomplete rollback when the target is deleted during transport', async () => {
    // Arrange: optimistically rename an entity while the request is pending.
    let reject: (error: Error) => void = () => { throw new Error('Transport not started.'); };
    const pending = new Promise<Response>((resolve, fail) => {
      void resolve;
      reject = fail;
    });
    const ownership = createOptimisticOwnership();
    const api = createRestApi({
      name: 'people',
      basePath: '/api',
      storeService: ApiStore,
      fetcher: () => pending,
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        rename: builder.mutation('rename', {
          request: (variables: { readonly id: string; readonly name: string }) => ({
            path: `/people/${variables.id}`,
            method: 'PATCH',
            response: 'json',
          }),
          decode: (): string => 'Saved',
          normalize: (value: string) => value,
          optimistic: {
            ownership,
            targets: (state, variables) => {
              void state;
              return [{ table: 'people', id: variables.id, incarnation: variables.id, field: 'name' }];
            },
            read: (state, target) => state.people[target.id]?.name,
            proposed: (state, variables) => {
              void state;
              return variables.name;
            },
            confirmed: (result) => result,
            write: (state, target, value) => {
              const person = state.people[target.id];
              if (!person || typeof value !== 'string')
                throw new Error('Invalid person target.');
              person.name = value;
            },
          },
        }),
      }),
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      people: { a: { name: 'Before' } },
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(api.endpoints.rename.optimisticReducer(state, action), action);
      }),
    };
    const run = Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    }));
    state = { ...state, people: {} };

    // Act: fail the pending request after the target is removed.
    reject(new Error('Network failed'));
    const outcome = await run;

    // Assert: the deleted person is not recreated and incomplete rollback is visible.
    const rollback = {
      status: 'incomplete',
      missingTargets: [{ table: 'people', id: 'a', incarnation: 'a', field: 'name' }],
    };
    expect(state.people).toEqual({});
    expect(outcome).toEqual({
      status: 'failed',
      error: 'Network failed',
      serverMayHaveCommitted: true,
      rollback,
    });
    expect(selectRequest(api.endpoints.rename, state, { id: 'a', name: 'After' })).toMatchObject({ rollback });
  });

  test('applies a declared field optimistically and restores it on failure', async () => {
    // Arrange: install an optimistic mutation and hold its transport pending.
    let reject: (error: Error) => void = () => { throw new Error('Transport not started.'); };
    const pending = new Promise<Response>((resolve, fail) => {
      void resolve;
      reject = fail;
    });
    const ownership = createOptimisticOwnership();
    const api = createRestApi({
      name: 'people',
      basePath: '/api',
      storeService: ApiStore,
      fetcher: () => pending,
      getState: (state: State) => state.api,
      state: (state) => state.api,
      endpoints: (builder) => ({
        rename: builder.mutation('rename', {
          request: (variables: { readonly id: string; readonly name: string }) => ({
            path: `/people/${variables.id}`,
            method: 'PATCH',
            body: { name: variables.name },
            response: 'json',
          }),
          decode: (): string => 'server',
          normalize: (value: string) => value,
          optimistic: {
            ownership,
            targets: (state, variables) => {
              void state;
              return [{
                table: 'people',
                id: variables.id,
                incarnation: variables.id,
                field: 'name',
              }];
            },
            read: (state, target: OptimisticTarget) => state.people[target.id]?.name,
            proposed: (state, variables) => {
              void state;
              return variables.name;
            },
            confirmed: (result) => result,
            write: (state, target, value) => {
              const person = state.people[target.id];
              if (!person || typeof value !== 'string')
                throw new Error('Invalid person target.');
              person.name = value;
            },
          },
        }),
      }),
    });
    let state: State = {
      api: { requests: {}, latest: {} },
      people: { a: { name: 'Before' } },
    };
    const store = {
      getState: Effect.sync(() => state),
      dispatch: (action: RequestActions<typeof api.endpoints>) => Effect.sync(() => {
        state = api.reducer(api.endpoints.rename.optimisticReducer(state, action), action);
      }),
    };

    // Act: start the request, then reject its transport.
    const run = Effect.runPromise(runEndpoint(api.endpoints.rename, ApiStore, {
      store,
      variables: { id: 'a', name: 'After' },
    }));
    expect(state.people.a?.name).toBe('After');
    reject(new Error('Network failed'));
    const outcome = await run;

    // Assert: only the owned value is restored and uncertainty is visible.
    expect(state.people.a?.name).toBe('Before');
    expect(outcome).toEqual({
      status: 'failed',
      error: 'Network failed',
      serverMayHaveCommitted: true,
    });
  });

    test('skips an entire multi-field mutation when another factory owns one field', async () => {
      // Arrange: two API instances share a store and one ownership registry.
      type Person = { readonly name: string; readonly role: string };
      type Model = {
        readonly api: RequestApiState;
        readonly people: Readonly<Record<string, Person>>;
      };
      class ModelApiStore extends Context.Service<ModelApiStore, Store<Model, { readonly type: string }>>()(
        'test/optimisticApi/ModelApiStore',
      ) {}
      type Variables = {
        readonly id: string;
        readonly fields: readonly ('name' | 'role')[];
        readonly value: string;
      };
      let finish: (value: Response) => void = () => { throw new Error('Transport not started.'); };
      const pending = new Promise<Response>((resolve) => { finish = resolve; });
      const ownership = createOptimisticOwnership();
      let calls = 0;
      const makeApi = (name: string) => createRestApi({
        name,
        basePath: '/api',
        storeService: ModelApiStore,
        fetcher: () => {
          calls += 1;
          return pending;
        },
        getState: (state: Model) => state.api,
        state: (state) => state.api,
        endpoints: (builder) => ({
          update: builder.mutation('update', {
            request: (variables: Variables) => ({
              path: `/people/${variables.id}`,
              method: 'PATCH',
              response: 'json',
            }),
            decode: (): string => 'Saved',
            normalize: (value: string) => value,
            optimistic: {
              ownership,
              targets: (state, variables) => {
                void state;
                return variables.fields.map((field) => ({
                  table: 'people', id: variables.id, incarnation: variables.id, field,
                }));
              },
              read: (state, target) => {
                const person = state.people[target.id];
                return target.field === 'name' ? person?.name
                  : target.field === 'role' ? person?.role : undefined;
              },
              proposed: (state, variables) => {
                void state;
                return variables.value;
              },
              confirmed: (result) => result,
              write: (state, target, value) => {
                const person = state.people[target.id];
                if (!person || typeof value !== 'string')
                  throw new Error('Invalid person target.');
                if (target.field === 'name')
                  person.name = value;
                else if (target.field === 'role')
                  person.role = value;
                else
                  throw new Error('Invalid person field.');
              },
            },
          }),
        }),
      });
      const first = makeApi('first');
      const second = makeApi('second');
      let state: Model = {
        api: { requests: {}, latest: {} },
        people: { a: { name: 'Before', role: 'Original' } },
      };
      type Action = RequestActions<typeof first.endpoints> | RequestActions<typeof second.endpoints>;
      const store = {
        getState: Effect.sync(() => state),
        dispatch: (action: Action) => Effect.sync(() => {
          state = first.reducer(second.reducer(
            first.endpoints.update.optimisticReducer(
              second.endpoints.update.optimisticReducer(state, action),
              action,
            ),
            action,
          ), action);
        }),
      };
      const running = Effect.runPromise(runEndpoint(first.endpoints.update, ModelApiStore, {
        store,
        variables: { id: 'a', fields: ['name'], value: 'Pending' },
      }));

      // Act: attempt a write that overlaps the pending field.
      const outcome = await Effect.runPromise(runEndpoint(second.endpoints.update, ModelApiStore, {
        store,
        variables: { id: 'a', fields: ['role', 'name'], value: 'Other' },
      }));

      // Assert: no part of the second write or its transport ran.
      expect(outcome).toEqual({ status: 'skipped', reason: 'conflict' });
      expect(state.people.a).toEqual({ name: 'Pending', role: 'Original' });
      expect(calls).toBe(1);
      finish(Response.json({ ok: true }));
      await running;
  });
});
