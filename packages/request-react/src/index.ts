import { Effect } from 'effect';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

export type RequestStatus =
  | { readonly status: 'idle' }
  | {
    readonly status: 'pending' | 'succeeded' | 'superseded';
    readonly requestId: string;
  }
  | {
    readonly status: 'failed' | 'cancelled' | 'postCommitError';
    readonly requestId: string;
    readonly error: string;
    readonly serverMayHaveCommitted?: true;
    readonly rollback?: IncompleteRollback;
  };

export type IncompleteRollback = {
  readonly status: 'incomplete';
  readonly missingTargets: readonly {
    readonly table: string;
    readonly id: string;
    readonly incarnation: string;
    readonly field: string;
  }[];
  readonly error?: string;
};

export type RequestOutcome =
  | { readonly status: 'succeeded' | 'superseded' }
  | { readonly status: 'skipped'; readonly reason?: 'conflict' }
  | {
    readonly status: 'failed';
    readonly error: string;
    readonly serverMayHaveCommitted?: true;
    readonly rollback?: IncompleteRollback;
  };

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

export type QueryFreshness = 'uninitialized' | 'fresh' | 'stale';

type QueryHookOptions<State, Input extends RequestInput> = Omit<HookOptions<State, Input>, 'operation'> & {
  readonly operation: Operation<State, Input> & {
    readonly selectFreshness: (state: State, variables: Input['variables']) => QueryFreshness;
  };
};

type HookResult = {
  readonly request: RequestStatus;
  readonly trigger: () => Promise<RequestOutcome>;
};

type QueryHookResult = HookResult & { readonly freshness: QueryFreshness };

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
  options: QueryHookOptions<State, Input>,
): QueryHookResult {
  const { operation, source, input } = options;
  if (operation.kind !== 'query')
    throw new Error('Expected a query operation.');

  const getQuerySnapshot = useMemo(() => {
    let previous: { readonly request: RequestStatus; readonly freshness: QueryFreshness } | undefined;

    return () => {
      const state = source.getSnapshot();
      const request = operation.selectRequest(state, input.variables) ?? idle;
      const freshness = operation.selectFreshness(state, input.variables);

      if (!previous || previous.request !== request || previous.freshness !== freshness)
        previous = { request, freshness };

      return previous;
    };
  },
    [operation, source, input.variables],
  );
  const { request, freshness } = useSyncExternalStore(source.subscribe, getQuerySnapshot, getQuerySnapshot);
  const trigger = useCallback(() => Effect.runPromise(operation.run(input)), [operation, input]);

  return { request, freshness, trigger };
}

/** Observe and manually trigger a mutation for the supplied variables. */
export function useMutation<State, Input extends RequestInput>(
  options: HookOptions<State, Input>,
): HookResult {
  return useRequest('mutation', options);
}
