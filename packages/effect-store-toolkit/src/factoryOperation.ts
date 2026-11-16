import { Effect } from 'effect';

import type {
  ApiRequest,
  Operation,
  RequestResult,
} from './engine.js';

type InternalOperation<
  State,
  Name extends string,
  Key extends string,
  Variables extends object,
  Data,
  Normalized,
  Action extends { readonly type: string },
> = Operation<State, Name, Key, Variables, Data, Normalized, Action>;

type OperationStore<
  State,
  Name extends string,
  Key extends string,
  Variables extends object,
  Data,
  Normalized,
  Action extends { readonly type: string },
> = Parameters<
  InternalOperation<State, Name, Key, Variables, Data, Normalized, Action>['run']
>[0]['store'];

export type FactoryOperation<
  State,
  Name extends string,
  Key extends string,
  Variables extends object,
  Data,
  Normalized,
  Action extends { readonly type: string },
  StoreId,
> = Omit<
  InternalOperation<State, Name, Key, Variables, Data, Normalized, Action>,
  'run' | 'runWithResult' | 'selectRequest'
> & {
  readonly initiate: (
    variables: Variables,
    options?: Readonly<{
      fence?: { readonly identity: string; readonly requestId: string };
    }>,
  ) => Effect.Effect<RequestResult<Normalized>, Error, StoreId>;
  readonly select: (variables: Variables) => (state: State) => ApiRequest | undefined;
};

export function factoryOperation<
  State,
  Name extends string,
  Key extends string,
  Variables extends object,
  Data,
  Normalized,
  Action extends { readonly type: string },
  StoreId,
  StoreShape extends OperationStore<
    State,
    Name,
    Key,
    Variables,
    Data,
    Normalized,
    Action
  >,
>(
  operation: InternalOperation<State, Name, Key, Variables, Data, Normalized, Action>,
  store: Effect.Effect<StoreShape, never, StoreId>,
): FactoryOperation<State, Name, Key, Variables, Data, Normalized, Action, StoreId> {
  return {
    kind: operation.kind,
    actions: operation.actions,
    key: operation.key,
    selectFreshness: operation.selectFreshness,
    optimisticReducer: operation.optimisticReducer,
    reducer: operation.reducer,
    initiate: (variables, options) => Effect.gen(function*() {
      const receivingStore = yield* store;

      return yield* operation.runWithResult({
        store: receivingStore,
        variables,
        ...(options?.fence ? { fence: options.fence } : {}),
      });
    }),
    select: (variables) => (state) => operation.selectRequest(state, variables),
  };
}
