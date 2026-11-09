import {
  requestGraphql,
  variablesKey
} from '@repo/gql-api';

import {
  Cause,
  Deferred,
  Effect,
  Fiber,
} from 'effect';
import {
  produce,
  type Draft,
} from 'immer';

import type {
  ActionCreator,
  CaseReducer,
  PayloadAction,
  SliceActions,
} from './contracts.js';
import type {
  InvalidationRegistry,
  InvalidationTag,
  QueryInvalidationRegistry,
} from './invalidation.js';
import { PostCommitError } from './postCommitError.js';

export type ApiRequest =
  | {
    readonly status: 'pending' | 'succeeded' | 'superseded';
    readonly requestId: string;
    readonly generation?: number;
  }
  | {
    readonly status: 'failed' | 'cancelled';
    readonly requestId: string;
    readonly error: string
  };

export type RequestApiState = {
  readonly requests: Readonly<Record<string, ApiRequest>>;
  readonly latest: Readonly<Record<string, {
    readonly key: string;
    readonly requestId: string
  }>>;
};

export type RequestOutcome =
  | { readonly status: 'succeeded' | 'skipped' | 'superseded' }
  | {
    readonly status: 'failed';
    readonly error: string
  };

export type RequestResult<Normalized> =
  | { readonly status: 'succeeded'; readonly result: Normalized }
  | { readonly status: 'skipped' | 'superseded' }
  | { readonly status: 'failed'; readonly error: string };

type Request<Variables> = {
  readonly key: string;
  readonly scope: string;
  readonly requestId: string;
  readonly variables: Variables;
  readonly generation?: number;
};

type Success<Variables, Normalized> = Request<Variables> & { readonly result: Normalized };

type Failure<Variables> = Request<Variables> & { readonly error: string };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

type Store<State, Action> = {
  readonly getState: Effect.Effect<State>;
  readonly dispatch: (action: Action) => Effect.Effect<unknown>;
};

type OperationOptions<State, Variables extends object, Data, Normalized, Name extends string, Action> = {
  readonly document?: string;
  readonly operationName?: string;
  readonly decode: (data: unknown, variables: Variables) => Data;
  readonly normalize: (data: Data, variables: Variables) => Normalized;
  readonly scope?: (variables: Variables) => string;
  readonly invalidation?: {
    readonly registry: InvalidationRegistry<State, Name, Action>;
    readonly tags: (variables: Variables, result: Normalized) => readonly InvalidationTag<Name>[];
  };
  readonly provides?: {
    readonly registry: QueryInvalidationRegistry<State, Name, Action>;
    readonly fromVariables: (variables: Variables) => readonly InvalidationTag<Name>[];
    readonly fromResult: (result: Normalized, variables: Variables) => readonly InvalidationTag<Name>[];
  };
};

type OperationReducers<State, Variables, Normalized> = {
  readonly onStarted?: (state: Draft<State>, request: Request<Variables>) => void;
  readonly onSuccess: (state: Draft<State>, response: Success<Variables, Normalized>) => void;
  readonly onFailure?: (state: Draft<State>, failure: Failure<Variables>) => void;
};

type OperationActions<Name extends string, Key extends string, Variables, Normalized> =
  | PayloadAction<Request<Variables>, `${Name}/${Key}/started`>
  | PayloadAction<Success<Variables, Normalized>, `${Name}/${Key}/succeeded`>
  | PayloadAction<Request<Variables>, `${Name}/${Key}/superseded`>
  | PayloadAction<Failure<Variables>, `${Name}/${Key}/failed`>
  | PayloadAction<Failure<Variables>, `${Name}/${Key}/cancelled`>;

type Operation<State, Name extends string, Key extends string, Variables extends object, Data, Normalized, Action = never> = {
  readonly kind: 'query' | 'mutation';
  readonly actions: {
    readonly started: ActionCreator<Request<Variables>, `${Name}/${Key}/started`>;
    readonly succeeded: ActionCreator<Success<Variables, Normalized>, `${Name}/${Key}/succeeded`>;
    readonly superseded: ActionCreator<Request<Variables>, `${Name}/${Key}/superseded`>;
    readonly failed: ActionCreator<Failure<Variables>, `${Name}/${Key}/failed`>;
    readonly cancelled: ActionCreator<Failure<Variables>, `${Name}/${Key}/cancelled`>;
  };
  readonly key: (variables: Variables) => string;
  readonly selectRequest: (state: State, variables: Variables) => ApiRequest | undefined;
  readonly selectFreshness: (state: State, variables: Variables) => 'uninitialized' | 'fresh' | 'stale';
  readonly reducer: (handlers: OperationReducers<State, Variables, Normalized>) =>
    (state: State, action: { readonly type: string }) => State;
  readonly run: (input: {
    readonly variables: Variables;
    readonly store: Store<State, OperationActions<Name, Key, Variables, Normalized> | Action>;
    readonly fence?: { readonly identity: string; readonly requestId: string };
    readonly endpoint?: string;
    readonly headers?: HeadersInit;
    readonly fetcher?: Fetcher;
    readonly execute?: (variables: Variables, signal: AbortSignal) => Promise<Data>;
  }) => Effect.Effect<RequestOutcome, Error>;
  readonly runWithResult: (input: {
    readonly variables: Variables;
    readonly store: Store<State, OperationActions<Name, Key, Variables, Normalized> | Action>;
    readonly fence?: { readonly identity: string; readonly requestId: string };
    readonly endpoint?: string;
    readonly headers?: HeadersInit;
    readonly fetcher?: Fetcher;
    readonly execute?: (variables: Variables, signal: AbortSignal) => Promise<Data>;
  }) => Effect.Effect<RequestResult<Normalized>, Error>;
};

type OperationBuilder<State, Name extends string> = <
  const Key extends string, Variables extends object, Data, Normalized, const Tag extends string = never, Action = never,
>(
  key: Key,
  options: OperationOptions<State, Variables, Data, Normalized, Tag, Action>,
) => Operation<State, Name, Key, Variables, Data, Normalized, Action>;

export type RequestApiBuilder<State, Name extends string> = {
  readonly query: OperationBuilder<State, Name>;
  readonly mutation: OperationBuilder<State, Name>;
};

export type RequestActions<Operations> = {
  [Key in keyof Operations]: Operations[Key] extends {
    readonly actions: infer Creators extends Readonly<Record<string, unknown>>;
  } ? SliceActions<Creators> : never;
}[keyof Operations];

export type RequestApiOptions<State, Name extends string, Operations> = {
  readonly name: Name;
  readonly endpoint?: string;
  readonly state: (state: Draft<State>) => Draft<RequestApiState>;
  readonly getState: (state: State) => RequestApiState;
  readonly operations: (api: RequestApiBuilder<State, Name>) => Operations;
};

/**
 * Generates request metadata handling, installed once by the receiving store.
 * Separate domain reducers run before this reducer to inspect prior ownership.
 * Queries share in-flight outcomes per stable store service and key. The last
 * departing waiter interrupts execution; mutations retain duplicate skipping.
 */
export function createRequestApi<
  State, const Name extends string, Operations extends Readonly<Record<string, unknown>>,
>(
  options: RequestApiOptions<State, Name, Operations>,
) {
  const keys = new Set<string>();
  const metadata = new Map<string, (state: Draft<State>, action: { readonly type: string }) => void>();
  const metadataGuards = new Map<string, (state: State, action: { readonly type: string }) => boolean>();
  let defining = true;

  function caseHandler<Payload, Type extends string>(
    creator: ActionCreator<Payload, Type>,
    handler: CaseReducer<State, Payload>,
  ) {
    // Registered action types identify trusted payloads, as in RTK slice cases.
    function matches(action: { readonly type: string }): action is PayloadAction<Payload, Type> {
      return action.type === creator.type;
    }

    return (state: Draft<State>, action: { readonly type: string }): void => {
      if (matches(action))
        handler(state, action);
    };
  }

  function define<const Key extends string, Variables extends object, Data, Normalized, const Tag extends string, Action>(
    kind: 'query' | 'mutation',
    key: Key,
    operation: OperationOptions<State, Variables, Data, Normalized, Tag, Action>,
  ): Operation<State, Name, Key, Variables, Data, Normalized, Action> {
    if (!defining)
      throw new Error('Operations can only be defined while creating a request API.');

    if (keys.has(key))
      throw new Error(`Duplicate operation: ${key}`);

    if (kind === 'query' && operation.invalidation)
      throw new Error('Mutation invalidation cannot be configured on a query.');

    if (kind === 'mutation' && operation.provides)
      throw new Error('Query dependencies cannot be configured on a mutation.');

    keys.add(key);

    const started = createAction<Request<Variables>, `${Name}/${Key}/started`>(`${options.name}/${key}/started`);
    const succeeded = createAction<Success<Variables, Normalized>, `${Name}/${Key}/succeeded`>(`${options.name}/${key}/succeeded`);
    const superseded = createAction<Request<Variables>, `${Name}/${Key}/superseded`>(`${options.name}/${key}/superseded`);
    const failed = createAction<Failure<Variables>, `${Name}/${Key}/failed`>(`${options.name}/${key}/failed`);
    const cancelled = createAction<Failure<Variables>, `${Name}/${Key}/cancelled`>(`${options.name}/${key}/cancelled`);
    const getApiState = options.getState;
    const operationKey = (variables: Variables): string =>
      JSON.stringify([options.name, key, variablesKey(variables)]);
    type ReceivingStore = Store<State, OperationActions<Name, Key, Variables, Normalized> | Action>;
    type InFlight = {
      readonly result: Deferred.Deferred<RequestResult<Normalized>, Error>;
      readonly worker: Deferred.Deferred<Fiber.Fiber<RequestResult<Normalized>, Error>>;
      waiters: number;
    };
    const inFlight = new WeakMap<ReceivingStore, Map<string, InFlight>>();

    function share(
      store: ReceivingStore,
      requestKey: string,
      execution: Effect.Effect<RequestResult<Normalized>, Error>,
    ): Effect.Effect<RequestResult<Normalized>, Error> {
      return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
        let requests = inFlight.get(store);

        if (!requests) {
          requests = new Map();
          inFlight.set(store, requests);
        }

        let entry = requests.get(requestKey);

        if (entry?.waiters === 0) {
          const worker = yield* Deferred.await(entry.worker);
          yield* restore(Fiber.await(worker));
          return yield* restore(share(store, requestKey, execution));
        }

        if (!entry) {
          const activeRequests = requests;
          const created: InFlight = {
            result: yield* Deferred.make<RequestResult<Normalized>, Error>(),
            worker: yield* Deferred.make<Fiber.Fiber<RequestResult<Normalized>, Error>>(),
            waiters: 1,
          };
          requests.set(requestKey, created);

          const fiber = yield* Effect.forkDetach(execution.pipe(
            Effect.onExit((exit) => Effect.gen(function*() {
              if (activeRequests.get(requestKey) === created)
                activeRequests.delete(requestKey);
              yield* Deferred.done(created.result, exit);
            })),
          ), { startImmediately: true });

          yield* Deferred.succeed(created.worker, fiber);
          entry = created;
        } else {
          entry.waiters += 1;
        }

        const active = entry;

        return yield* restore(Deferred.await(active.result)).pipe(
          Effect.ensuring(Effect.gen(function*() {
            active.waiters -= 1;
            if (active.waiters === 0) {
              const worker = yield* Deferred.await(active.worker);
              yield* Fiber.interrupt(worker);
            }
          })),
        );
      }));
    }

    function owns(api: RequestApiState, request: Request<Variables>): boolean {
      return api.requests[request.key]?.status === 'pending' &&
        api.requests[request.key]?.requestId === request.requestId &&
        api.latest[request.scope]?.requestId === request.requestId;
    }

    const invalidation = operation.invalidation;
    const provides = operation.provides;

    function allowsSuccess(state: State, action: { readonly type: string }): boolean {
      function matches(value: { readonly type: string }): value is PayloadAction<
        Success<Variables, Normalized>,
        `${Name}/${Key}/succeeded`
      > {
        return value.type === succeeded.type;
      }

      if (!matches(action))
        return true;

      if (
        invalidation &&
        owns(getApiState(state), action.payload) &&
        !invalidation.registry.hasReceipt(state, invalidation.registry.mutationReceipt(action.payload.requestId))
      )
        throw new Error(`Invalidation registry must run before ${key} success.`);

      return !provides || provides.registry.isEligible(state, {
        identity: action.payload.key,
        requestId: action.payload.requestId,
        tags: provides.fromResult(action.payload.result, action.payload.variables),
      });
    }

    invalidation?.registry.registerMutation({
      action: succeeded,
      owns: (state, payload) => owns(getApiState(state), payload),
      tags: (payload) => invalidation.tags(payload.variables, payload.result),
    });

    const startMetadata = caseHandler(started, (state, { payload }) => {
      const api = options.state(state);
      const previousRequest = api.requests[payload.key];

      if (
        previousRequest?.status === 'pending' &&
        (payload.generation === undefined || previousRequest.generation === payload.generation)
      )
        return;

      const previous = api.latest[payload.scope];
      if (previous && api.requests[previous.key]?.status === 'pending')
        api.requests[previous.key] = { status: 'superseded', requestId: previous.requestId };

      api.requests[payload.key] = {
        status: 'pending',
        requestId: payload.requestId,
        ...(payload.generation === undefined ? {} : { generation: payload.generation }),
      };
      api.latest[payload.scope] = { key: payload.key, requestId: payload.requestId };
    });
    const successMetadata = caseHandler(succeeded, (state, { payload }) => {
      const api = options.state(state);
      if (owns(api, payload))
        api.requests[payload.key] = { status: 'succeeded', requestId: payload.requestId };
    });
    function failureMetadata(status: 'failed' | 'cancelled', state: Draft<State>, payload: Failure<Variables>): void {
      const api = options.state(state);
      if (owns(api, payload))
        api.requests[payload.key] = { status, requestId: payload.requestId, error: payload.error };
    }

    metadata.set(started.type, startMetadata);
    metadata.set(succeeded.type, successMetadata);
    metadataGuards.set(succeeded.type, allowsSuccess);
    metadata.set(superseded.type, caseHandler(superseded, (state, { payload }) => {
      const api = options.state(state);

      if (owns(api, payload))
        api.requests[payload.key] = { status: 'superseded', requestId: payload.requestId };
    }));
    metadata.set(failed.type, caseHandler(failed, (state, { payload }) => failureMetadata('failed', state, payload)));
    metadata.set(cancelled.type, caseHandler(cancelled, (state, { payload }) => failureMetadata('cancelled', state, payload)));

    const resultOperation: Omit<Operation<State, Name, Key, Variables, Data, Normalized, Action>, 'run'> = {
      kind,
      key: operationKey,
      selectRequest: (state, variables) => getApiState(state).requests[operationKey(variables)],
      selectFreshness: (state, variables) => {
        if (!provides)
          throw new Error(`Query ${key} has no invalidation dependencies.`);

        return provides.registry.select(state, operationKey(variables));
      },
      actions: {
        started,
        succeeded,
        superseded,
        failed,
        cancelled
      },

      reducer: (handlers) => {
        const domainCases = new Map<string, (state: Draft<State>, action: { readonly type: string }) => void>([
          [started.type, caseHandler(started, (state, { payload }) => {
            const previous = options.state(state).requests[payload.key];

            if (
              previous?.status !== 'pending' ||
              (payload.generation !== undefined && previous.generation !== payload.generation)
            )
              handlers.onStarted?.(state, payload);
          })],
          [succeeded.type, caseHandler(succeeded, (state, { payload }) => {
            if (owns(options.state(state), payload))
              handlers.onSuccess(state, payload);
          })],
          [failed.type, caseHandler(failed, (state, { payload }) => {
            if (owns(options.state(state), payload))
              handlers.onFailure?.(state, payload);
          })],
          [cancelled.type, caseHandler(cancelled, (state, { payload }) => {
            if (owns(options.state(state), payload))
              handlers.onFailure?.(state, payload);
          })],
        ]);

        return (state, action) => {
          if (action.type === succeeded.type && !allowsSuccess(state, action))
            return state;

          const handler = domainCases.get(action.type);
          return handler ? produce<State>(state, (draft) => handler(draft, action)) : state;
        };
      },

      runWithResult: Effect.fnUntraced(function*(
        input: Parameters<Operation<State, Name, Key, Variables, Data, Normalized, Action>['run']>[0],
      ): Effect.fn.Return<RequestResult<Normalized>, Error> {
        if (input.fence && !provides)
          return yield* Effect.fail(new Error(`Query ${key} cannot use a fence without invalidation dependencies.`));

        if (invalidation)
          yield* invalidation.registry.ensureInstalled({ store: input.store });
        if (provides)
          yield* provides.registry.ensureInstalled({ store: input.store });

        const requestKey = operationKey(input.variables);
        const scope = JSON.stringify([options.name, key, operation.scope?.(input.variables) ?? requestKey]);
        const state = yield* input.store.getState;
        const request: Request<Variables> = {
          key: requestKey,
          scope,
          variables: input.variables,
          requestId: yield* Effect.sync(() => crypto.randomUUID()),
          ...(provides ? { generation: provides.registry.revision(state) } : {}),
        };
        const current = getApiState(state);
        let serverCommitted = false;
        let queryStarted = false;

        const previousRequest = current.requests[requestKey];

        if (
          previousRequest?.status === 'pending' &&
          (request.generation === undefined || previousRequest.generation === request.generation)
        ) {
          return kind === 'mutation'
            ? { status: 'skipped' }
            : yield* Effect.fail(new Error(`Pending ${key} request has no local execution.`));
        }

        const perform = Effect.fnUntraced(function*(): Effect.fn.Return<RequestResult<Normalized>, Error> {
          if (provides) {
            queryStarted = true;
            yield* input.store.dispatch(provides.registry.actions.started({
              identity: request.key,
              requestId: request.requestId,
              tags: provides.fromVariables(request.variables),
              ...(input.fence ? { fence: input.fence, transient: true } : {}),
            }));

            if (!provides.registry.hasPending(yield* input.store.getState, {
              identity: request.key,
              requestId: request.requestId,
            }))
              return yield* Effect.fail(new Error(`Could not register ${key} query dependencies.`));
          }

          yield* input.store.dispatch(started(request));

          if (!owns(getApiState(yield* input.store.getState), request)) {
            return yield* Effect.fail(new Error(`Could not claim ${key} request.`));
          }

          const result = yield* Effect.result(Effect.tryPromise({
            try: async (signal) => {
              const execute = async (): Promise<Data> => {
                if (input.execute) {
                  const data = await input.execute(input.variables, signal);

                  if (kind === 'mutation')
                    serverCommitted = true;

                  return data;
                }

                const endpoint = input.endpoint ?? options.endpoint;

                if (!endpoint || !operation.document) {
                  throw new Error('Request requires an execute callback or a GraphQL endpoint and document.');
                }

                const data = await requestGraphql({
                  endpoint,
                  document: operation.document,
                  variables: input.variables,
                  signal,
                  ...(operation.operationName ? { operationName: operation.operationName } : {}),
                  ...(input.fetcher ? { fetcher: input.fetcher } : {}),
                  ...(input.headers ? { headers: input.headers } : {}),
                });

                if (kind === 'mutation')
                  serverCommitted = true;

                return operation.decode(data, input.variables);
              };
              const data = await execute();

              return operation.normalize(data, input.variables);
            },

            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          }));

          if (result._tag === 'Success') {
            if (provides) {
              const tags = provides.fromResult(result.success, request.variables);
              const eligible = provides.registry.isEligible(yield* input.store.getState, {
                identity: request.key,
                requestId: request.requestId,
                tags,
              });

              if (!eligible) {
                if (input.fence && !provides.registry.isEligible(yield* input.store.getState, {
                  ...input.fence, tags,
                })) {
                  yield* input.store.dispatch(provides.registry.actions.succeeded({ ...input.fence, tags }));
                }

                if (!input.fence) {
                  yield* input.store.dispatch(provides.registry.actions.succeeded({
                    identity: request.key,
                    requestId: request.requestId,
                    tags,
                  }));
                }
                yield* input.store.dispatch(superseded(request));
                return { status: 'superseded' };
              }
            }

            yield* input.store.dispatch(succeeded({ ...request, result: result.success }));

            const settled = getApiState(yield* input.store.getState);
            const active = settled.latest[scope]?.requestId === request.requestId;
            const committed = settled.requests[request.key]?.status === 'succeeded' &&
              settled.requests[request.key]?.requestId === request.requestId;

            if (provides) {
              const tags = provides.fromResult(result.success, request.variables);
              const eligible = provides.registry.isEligible(yield* input.store.getState, {
                identity: request.key,
                requestId: request.requestId,
                tags,
              });

              if (!input.fence) {
                yield* input.store.dispatch(provides.registry.actions.succeeded({
                  identity: request.key,
                  requestId: request.requestId,
                  tags,
                }));
              }

              if (!eligible && !committed) {
                if (input.fence && !provides.registry.isEligible(yield* input.store.getState, {
                  ...input.fence, tags,
                })) {
                  yield* input.store.dispatch(provides.registry.actions.succeeded({ ...input.fence, tags }));
                }

                yield* input.store.dispatch(superseded(request));
                return { status: 'superseded' };
              }
            }

            if (active && !committed)
              return yield* Effect.fail(new Error(`Could not settle ${key} request.`));

            if (active && invalidation) {
              const receipt = invalidation.registry.mutationReceipt(request.requestId);

              if (!invalidation.registry.hasReceipt(yield* input.store.getState, receipt))
                return yield* Effect.fail(new Error(`Could not invalidate ${key} request.`));

              yield* input.store.dispatch(invalidation.registry.acknowledge(receipt));
            }

            return active ? { status: 'succeeded', result: result.success } : { status: 'superseded' };
          }

          if (serverCommitted)
            return yield* Effect.fail(result.failure);

          yield* input.store.dispatch(failed({ ...request, error: result.failure.message }));

          const active = getApiState(yield* input.store.getState).latest[scope]?.requestId === request.requestId;

          return active ? { status: 'failed', error: result.failure.message } : { status: 'superseded' };
        });

        return yield* perform().pipe(
          Effect.catchCause((cause) =>
            serverCommitted && !Cause.hasInterruptsOnly(cause)
              ? Effect.fail(new PostCommitError(key, Cause.pretty(cause)))
              : Effect.failCause(cause)),
          Effect.onError((cause) => serverCommitted
            ? Effect.void
            : input.store.dispatch(Cause.hasInterruptsOnly(cause)
              ? cancelled({ ...request, error: 'Request interrupted.' })
              : failed({ ...request, error: Cause.pretty(cause) })).pipe(Effect.asVoid)),
          Effect.ensuring(Effect.suspend(() => provides && queryStarted
            ? input.store.dispatch(provides.registry.actions.finished({
              identity: request.key,
              requestId: request.requestId,
            })).pipe(Effect.asVoid)
            : Effect.void)),
        );
      }, (execution, input) => kind === 'query'
        ? Effect.flatMap(input.store.getState, (state) => share(
          input.store,
          JSON.stringify([operationKey(input.variables), provides?.registry.revision(state) ?? 0]),
          execution,
        ))
        : execution),
    };

    return {
      ...resultOperation,
      run: (input) => resultOperation.runWithResult(input).pipe(
        Effect.map((outcome): RequestOutcome => outcome.status === 'succeeded'
          ? { status: 'succeeded' }
          : outcome),
      ),
    };
  }

  const query: OperationBuilder<State, Name> = (key, operation) => define('query', key, operation);
  const mutation: OperationBuilder<State, Name> = (key, operation) => define('mutation', key, operation);

  const operations = options.operations({ query, mutation });

  defining = false;

  return {
    name: options.name,
    operations,
    reducer: (state: State, action: { readonly type: string }): State => {
      const handler = metadata.get(action.type);
      const guard = metadataGuards.get(action.type);

      if (guard && !guard(state, action))
        return state;

      return handler ? produce<State>(state, (draft) => handler(draft, action)) : state;
    },
  };
}

function createAction<Payload, const Type extends string>(type: Type): ActionCreator<Payload, Type> {
  return Object.assign(
    (payload: Payload): PayloadAction<Payload, Type> => ({ type, payload }),
    { type },
  );
}
