import type { Context } from 'effect';

import {
  createApiCore,
  type OperationOptions,
  type RequestApiOptions,
  type Store,
} from './engine.js';
import {
  factoryOperation,
  type FactoryOperation,
} from './factoryOperation.js';
import { createGraphqlTransport } from './graphqlTransport.js';

type GraphqlOperationBuilder<State, Name extends string, StoreId> = <
  const Key extends string,
  Variables extends object,
  Data,
  Normalized,
  const Tag extends string = never,
  Action extends { readonly type: string } = never,
>(
  key: Key,
  options: OperationOptions<State, Variables, Data, Normalized, Tag, Action> & {
    readonly document: string;
    readonly headers?: HeadersInit;
  },
) => FactoryOperation<State, Name, Key, Variables, Data, Normalized, Action, StoreId>;

type GraphqlApiBuilder<State, Name extends string, StoreId> = {
readonly query: GraphqlOperationBuilder<State, Name, StoreId>;
readonly mutation: GraphqlOperationBuilder<State, Name, StoreId>;
};

type GraphqlApiOptions<
State,
Name extends string,
Operations,
StoreId,
StoreShape extends Store<State, { readonly type: string }>,
> =
Omit<RequestApiOptions<State, Name, Operations>, 'endpoints' | 'endpoint'> & {
    readonly endpoint: string;
    readonly headers?: HeadersInit;
    readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly storeService: Context.Service<StoreId, StoreShape>;
  readonly endpoints: (api: GraphqlApiBuilder<State, Name, StoreId>) => Operations;
  };

export function createGraphqlApi<
  State,
  const Name extends string,
  Operations extends Readonly<Record<string, unknown>>,
StoreId,
StoreShape extends Store<State, { readonly type: string }>,
>(options: GraphqlApiOptions<State, Name, Operations, StoreId, StoreShape>) {
  const transport = createGraphqlTransport({
    endpoint: options.endpoint,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });

  return createApiCore({
    name: options.name,
    state: options.state,
    getState: options.getState,
    endpoints: (builder) => {
      const define = (kind: 'query' | 'mutation'): GraphqlOperationBuilder<State, Name, StoreId> =>
        (key, operation) => factoryOperation(builder[kind](key, {
          ...operation,
          transport: operation.transport ?? ((variables, signal) =>
            transport({
              document: operation.document,
              variables,
              signal,
              ...(operation.operationName ? { operationName: operation.operationName } : {}),
              ...(operation.headers ? { headers: operation.headers } : {}),
            })),
        }), options.storeService);

      return options.endpoints({
        query: define('query'),
        mutation: define('mutation'),
      });
    },
  });
}
