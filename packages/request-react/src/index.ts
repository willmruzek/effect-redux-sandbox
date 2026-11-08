import { Effect } from 'effect';
import { useCallback, useSyncExternalStore } from 'react';

export type RequestStatus =
  | { readonly status: 'idle' }
  | {
    readonly status: 'pending' | 'succeeded' | 'superseded';
    readonly requestId: string;
  }
  | {
    readonly status: 'failed' | 'cancelled';
    readonly requestId: string;
    readonly error: string;
  };

export type RequestOutcome =
  | { readonly status: 'succeeded' | 'skipped' | 'superseded' }
  | { readonly status: 'failed'; readonly error: string };

type RequestInput = { readonly variables: object };

type Operation<State, Input extends RequestInput> = {
  readonly kind: 'query' | 'mutation';
  readonly selectRequest: (state: State, variables: Input['variables']) =>
    Exclude<RequestStatus, { status: 'idle' }> | undefined;
  readonly run: (input: Input) => Effect.Effect<RequestOutcome, Error>;
};

type HookOptions<State, Input extends RequestInput> = {
  readonly operation: Operation<State, Input>;
  readonly source: {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => State;
  };
  readonly input: Input;
};

type HookResult = {
  readonly request: RequestStatus;
  readonly trigger: () => Promise<RequestOutcome>;
};

const idle: RequestStatus = { status: 'idle' };

function useRequest<State, Input extends RequestInput>(
  kind: 'query' | 'mutation',
  { operation, source, input }: HookOptions<State, Input>,
): HookResult {
  if (operation.kind !== kind)
    throw new Error(`Expected a ${kind} operation.`);

  const getRequest = useCallback(
    () => operation.selectRequest(source.getSnapshot(), input.variables) ?? idle,
    [operation, source, input.variables],
  );
  const request = useSyncExternalStore(source.subscribe, getRequest, getRequest);
  const trigger = useCallback(() => Effect.runPromise(operation.run(input)), [operation, input]);

  return { request, trigger };
}

/** Observe and manually trigger a query for the supplied variables. */
export function useQuery<State, Input extends RequestInput>(
  options: HookOptions<State, Input>,
): HookResult {
  return useRequest('query', options);
}

/** Observe and manually trigger a mutation for the supplied variables. */
export function useMutation<State, Input extends RequestInput>(
  options: HookOptions<State, Input>,
): HookResult {
  return useRequest('mutation', options);
}
