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
import {
  createRestTransport,
  type RestTransportRequest,
} from './restTransport.js';

type RestOperationBuilder<State, Name extends string, StoreId> = <
  const Key extends string,
  Variables extends object,
  Data,
  Normalized,
  const Tag extends string = never,
  Action extends { readonly type: string } = never,
>(
  key: Key,
  options: OperationOptions<State, Variables, Data, Normalized, Tag, Action> & {
    readonly request: (variables: Variables) => Omit<RestTransportRequest, 'signal'>;
  },
) => FactoryOperation<State, Name, Key, Variables, Data, Normalized, Action, StoreId>;

type RestApiBuilder<State, Name extends string, StoreId> = {
readonly query: RestOperationBuilder<State, Name, StoreId>;
readonly mutation: RestOperationBuilder<State, Name, StoreId>;
};

type RestApiOptions<
State,
Name extends string,
Operations,
StoreId,
StoreShape extends Store<State, { readonly type: string }>,
> =
Omit<RequestApiOptions<State, Name, Operations>, 'endpoints' | 'endpoint'> & {
    readonly basePath: string;
    readonly headers?: HeadersInit;
    readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly storeService: Context.Service<StoreId, StoreShape>;
  readonly endpoints: (api: RestApiBuilder<State, Name, StoreId>) => Operations;
  };

export function createRestApi<
  State,
  const Name extends string,
  Operations extends Readonly<Record<string, unknown>>,
StoreId,
StoreShape extends Store<State, { readonly type: string }>,
>(options: RestApiOptions<State, Name, Operations, StoreId, StoreShape>) {
  const transport = createRestTransport({
    basePath: options.basePath,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });

  return createApiCore({
    name: options.name,
    state: options.state,
    getState: options.getState,
    endpoints: (builder) => {
      const define = (kind: 'query' | 'mutation'): RestOperationBuilder<State, Name, StoreId> =>
        (key, operation) => factoryOperation(builder[kind](key, {
          ...operation,
          transport: operation.transport ?? (async (variables, signal) => {
            let request: Omit<RestTransportRequest, 'signal'>;

            try {
              request = operation.request(variables);
            } catch (error) {
              return {
                status: 'failed',
                error: error instanceof Error ? error : new Error(String(error)),
                serverMayHaveCommitted: false,
              };
            }

            return transport({ ...request, signal });
          }),
        }), options.storeService);

      return options.endpoints({
        query: define('query'),
        mutation: define('mutation'),
      });
    },
  });
}
