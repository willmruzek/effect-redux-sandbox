import { Effect } from 'effect';

import type {
  ActionCreator,
  PayloadAction,
} from './contracts.js';

export type InvalidationTag<Name extends string> = {
  readonly type: Name;
  readonly id?: string;
};

export type InvalidationRegistry<State, Name extends string, Action> = {
  readonly registerMutation: <Payload extends { readonly requestId: string }, Type extends string>(input: {
    readonly action: ActionCreator<Payload, Type>;
    readonly owns: (state: State, payload: Payload) => boolean;
    readonly tags: (payload: Payload) => readonly InvalidationTag<Name>[];
  }) => void;
  readonly ensureInstalled: (input: {
    readonly store: {
      readonly getState: Effect.Effect<State>;
      readonly dispatch: (action: Action) => Effect.Effect<unknown>;
    };
  }) => Effect.Effect<void, Error>;
  readonly mutationReceipt: (requestId: string) => string;
  readonly hasReceipt: (state: State, receipt: string) => boolean;
  readonly acknowledge: (receipt: string) => Action;
};

export type QueryInvalidationRegistry<State, Name extends string, Action> = {
  readonly ensureInstalled: InvalidationRegistry<State, Name, Action>['ensureInstalled'];
  readonly actions: {
    readonly started: (input: {
      readonly identity: string;
      readonly requestId: string;
      readonly tags: readonly InvalidationTag<Name>[];
      readonly fence?: { readonly identity: string; readonly requestId: string };
      readonly transient?: boolean;
    }) => Action;
    readonly succeeded: (input: {
      readonly identity: string;
      readonly requestId: string;
      readonly tags: readonly InvalidationTag<Name>[];
      readonly append?: boolean;
    }) => Action;
    readonly finished: (input: { readonly identity: string; readonly requestId: string }) => Action;
  };
  readonly isEligible: (state: State, input: {
    readonly identity: string;
    readonly requestId: string;
    readonly tags: readonly InvalidationTag<Name>[];
  }) => boolean;
  readonly hasPending: (state: State, input: {
    readonly identity: string;
    readonly requestId: string;
  }) => boolean;
  readonly select: (state: State, identity: string) => 'uninitialized' | 'fresh' | 'stale';
  readonly revision: (state: State) => number;
};

export type InvalidationState<Name extends string> = {
  readonly revision: number;
  readonly queries: Readonly<Record<string, {
    readonly tags: readonly InvalidationTag<Name>[];
    readonly stale: boolean;
    readonly initialized: boolean;
    readonly transient?: boolean;
    readonly latest: string | null;
    readonly lastSuccessRevision: number | null;
    readonly pending: Readonly<Record<string, {
      readonly revision: number;
      readonly tags: readonly InvalidationTag<Name>[];
      readonly fence?: {
        readonly identity: string;
        readonly epoch: number;
        readonly tags: readonly InvalidationTag<Name>[];
      };
    }>>;
  }>>;
  readonly epochs?: Readonly<Record<string, number>>;
  readonly history: readonly {
    readonly revision: number;
    readonly tags: readonly InvalidationTag<Name>[];
  }[];
  readonly receipts?: Readonly<Record<string, number>>;
};

export type InvalidationAction<Name extends string> =
  | {
    readonly type: string;
    readonly kind: 'seed';
    readonly identity: string;
    readonly tags: readonly InvalidationTag<Name>[];
  }
  | {
    readonly type: string;
    readonly kind: 'invalidate';
    readonly tags: readonly InvalidationTag<Name>[];
    readonly receipt: string | null;
  }
  | {
    readonly type: string;
    readonly kind: 'started' | 'succeeded';
    readonly identity: string;
    readonly requestId: string;
    readonly tags: readonly InvalidationTag<Name>[];
    readonly append?: boolean;
    readonly fence?: { readonly identity: string; readonly requestId: string };
    readonly transient?: boolean;
  }
  | {
    readonly type: string;
    readonly kind: 'forget';
    readonly identity: string;
  }
  | {
    readonly type: string;
    readonly kind: 'finished';
    readonly identity: string;
    readonly requestId: string;
  }
  | {
    readonly type: string;
    readonly kind: 'acknowledged';
    readonly receipt: string;
  }
  | {
    readonly type: string;
    readonly kind: 'probe';
    readonly receipt: string;
  };

export function createInvalidationRegistry<State, Name extends string>() {
  return function define(options: {
    readonly name: string;
    readonly getState: (state: State) => InvalidationState<Name>;
    readonly setState: (state: State, value: InvalidationState<Name>) => State;
  }) {
    const type = `${options.name}/invalidation`;
    const mutations = new Map<string, (state: State, action: { readonly type: string }) => State>();

    function registerMutation<Payload extends { readonly requestId: string }, Type extends string>(input: {
      readonly action: ActionCreator<Payload, Type>;
      readonly owns: (state: State, payload: Payload) => boolean;
      readonly tags: (payload: Payload) => readonly InvalidationTag<Name>[];
    }): void {
      if (mutations.has(input.action.type))
        throw new Error(`Duplicate invalidation registration: ${input.action.type}`);

      mutations.set(input.action.type, (state, action) => {
        function matches(value: { readonly type: string }): value is PayloadAction<Payload, Type> {
          return value.type === input.action.type;
        }

        if (!matches(action) || !input.owns(state, action.payload))
          return state;

        const invalidation: InvalidationAction<Name> = {
          type,
          kind: 'invalidate',
          tags: input.tags(action.payload),
          receipt: mutationReceipt(action.payload.requestId),
        };

        return reducer(state, invalidation);
      });
    }

    function mutationReceipt(requestId: string): string {
      return `mutation:${requestId}`;
    }

    function pruneHistory(value: InvalidationState<Name>): InvalidationState<Name> {
      const pending = Object.values(value.queries).flatMap((query) => Object.values(query.pending));
      const pendingRevisions = pending.map((read) => read.revision);
      const earliest = pendingRevisions.length ? Math.min(...pendingRevisions) : value.revision;
      const fencedIdentities = new Set(pending.flatMap((read) => read.fence ? [read.fence.identity] : []));

      return {
        ...value,
        history: value.history.filter((entry) => entry.revision > earliest),
        ...(value.epochs ? {
          epochs: Object.fromEntries(Object.entries(value.epochs).filter(([identity]) =>
            value.queries[identity] !== undefined || fencedIdentities.has(identity))),
        } : {}),
      };
    }

    const seed = (input: {
      readonly identity: string;
      readonly tags: readonly InvalidationTag<Name>[];
    }): InvalidationAction<Name> => ({ type, kind: 'seed', ...input });

    const invalidate = (input: {
      readonly tags: readonly InvalidationTag<Name>[];
    }): InvalidationAction<Name> => ({ type, kind: 'invalidate', receipt: null, ...input });

    const started = (input: {
      readonly identity: string;
      readonly requestId: string;
      readonly tags: readonly InvalidationTag<Name>[];
      readonly fence?: { readonly identity: string; readonly requestId: string };
      readonly transient?: boolean;
    }): InvalidationAction<Name> => ({ type, kind: 'started', ...input });

    const succeeded = (input: {
      readonly identity: string;
      readonly requestId: string;
      readonly tags: readonly InvalidationTag<Name>[];
      readonly append?: boolean;
    }): InvalidationAction<Name> => ({ type, kind: 'succeeded', ...input });

    const forget = (input: { readonly identity: string }): InvalidationAction<Name> =>
      ({ type, kind: 'forget', ...input });

    const finished = (input: {
      readonly identity: string;
      readonly requestId: string;
    }): InvalidationAction<Name> => ({ type, kind: 'finished', ...input });

    function isEligible(state: State, input: {
      readonly identity: string;
      readonly requestId: string;
      readonly tags: readonly InvalidationTag<Name>[];
    }): boolean {
      const current = options.getState(state);
      const query = current.queries[input.identity];

      const pending = query?.pending[input.requestId];

      if (!query || !pending)
        return false;

      if (pending.fence && (current.epochs?.[pending.fence.identity] ?? 0) !== pending.fence.epoch)
        return false;

      const { revision } = pending;

      return !current.history.some((entry) =>
        entry.revision > revision &&
        entry.tags.some((invalidated) => [...query.tags, ...input.tags, ...(pending.fence?.tags ?? [])].some((tag) =>
          tag.type === invalidated.type && tag.id === invalidated.id)));
    }

    function reducer(state: State, action: { readonly type: string }): State {
      function matches(value: { readonly type: string }): value is InvalidationAction<Name> {
        return value.type === type;
      }

      if (!matches(action))
        return mutations.get(action.type)?.(state, action) ?? state;

      const current = options.getState(state);

      if (action.kind === 'probe') {
        return options.setState(state, {
          ...current,
          receipts: { ...current.receipts, [action.receipt]: 0 },
        });
      }

      if (action.kind === 'acknowledged') {
        const { [action.receipt]: acknowledged, ...receipts } = current.receipts ?? {};

        return acknowledged === undefined ? state : options.setState(state, { ...current, receipts });
      }

      if (action.kind === 'finished') {
        const query = current.queries[action.identity];

        if (!query?.pending[action.requestId])
          return state;

        const pending = Object.fromEntries(
          Object.entries(query.pending).filter(([requestId]) => requestId !== action.requestId),
        );

        if (query.transient && !query.initialized && Object.keys(pending).length === 0) {
          const queries = Object.fromEntries(Object.entries(current.queries).filter(([identity]) =>
            identity !== action.identity));

          return options.setState(state, pruneHistory({ ...current, queries }));
        }

        return options.setState(state, pruneHistory({
          ...current,
          queries: {
            ...current.queries,
            [action.identity]: {
              ...query,
              latest: query.latest === action.requestId ? null : query.latest,
              pending,
            },
          },
        }));
      }

      if (action.kind === 'forget') {
        const { [action.identity]: forgotten, ...queries } = current.queries;

        if (!forgotten)
          return state;

        return options.setState(state, pruneHistory({
          ...current,
          queries,
          epochs: { ...current.epochs, [action.identity]: (current.epochs?.[action.identity] ?? 0) + 1 },
        }));
      }

      if (action.kind === 'seed') {
        const next: InvalidationState<Name> = {
          ...current,
          epochs: { ...current.epochs, [action.identity]: (current.epochs?.[action.identity] ?? 0) + 1 },
          queries: {
            ...current.queries,
            [action.identity]: {
              tags: action.tags,
              stale: false,
              initialized: true,
              latest: null,
              lastSuccessRevision: current.revision,
              pending: {},
            },
          },
        };

        return options.setState(state, pruneHistory(next));
      }

      if (action.kind === 'started') {
        const previous = current.queries[action.identity];
        const source = action.fence ? current.queries[action.fence.identity] : undefined;
        const sourcePending = action.fence ? source?.pending[action.fence.requestId] : undefined;

        if (action.fence && (!source || !sourcePending))
          return state;

        const next: InvalidationState<Name> = {
          ...current,
          queries: {
            ...current.queries,
            [action.identity]: {
              tags: [...(previous?.tags ?? []), ...action.tags],
              stale: previous?.stale ?? false,
              initialized: previous?.initialized ?? false,
              transient: previous ? Boolean(previous.transient && action.transient) : Boolean(action.transient),
              latest: action.requestId,
              lastSuccessRevision: previous?.lastSuccessRevision ?? null,
              pending: {
                ...previous?.pending,
                [action.requestId]: {
                  revision: sourcePending?.revision ?? current.revision,
                  tags: action.tags,
                  ...(action.fence && source ? {
                    fence: {
                      identity: action.fence.identity,
                      epoch: current.epochs?.[action.fence.identity] ?? 0,
                      tags: source.tags,
                    },
                  } : {}),
                },
              },
            },
          },
        };

        return options.setState(state, pruneHistory(next));
      }

      if (action.kind === 'succeeded') {
        const previous = current.queries[action.identity];

        const pending = previous?.pending[action.requestId];

        if (!previous || !pending)
          return state;

        const eligible = isEligible(state, action);
        const remaining = Object.fromEntries(
          Object.entries(previous.pending).filter(([requestId]) => requestId !== action.requestId),
        );
        const latest = previous.latest === action.requestId;
        const discoveredInvalidation = !eligible && current.history.some((entry) =>
          entry.revision > pending.revision &&
          entry.revision > (previous.lastSuccessRevision ?? -1) &&
          entry.tags.some((invalidated) => [...previous.tags, ...action.tags, ...(pending.fence?.tags ?? [])].some((tag) =>
            tag.type === invalidated.type && tag.id === invalidated.id)));
        const next: InvalidationState<Name> = {
          ...current,
          queries: {
            ...current.queries,
            [action.identity]: {
              tags: latest && eligible
                ? [...(action.append ? previous.tags : pending.tags), ...action.tags]
                : discoveredInvalidation ? [...previous.tags, ...action.tags] : previous.tags,
              stale: latest && eligible
                ? action.append ? previous.stale : false
                : previous.stale || discoveredInvalidation,
              initialized: (latest && eligible) || previous.initialized,
              latest: latest ? null : previous.latest,
              lastSuccessRevision: latest && eligible ? current.revision : previous.lastSuccessRevision,
              pending: remaining,
            },
          },
        };

        return options.setState(state, pruneHistory(next));
      }

      if (action.kind !== 'invalidate')
        return state;

      const revision = current.revision + 1;
      const matched = Object.values(current.queries).filter((query) => !query.transient &&
        query.tags.some((tag) => action.tags.some((candidate) =>
          tag.type === candidate.type && tag.id === candidate.id))).length;
      const queries = Object.fromEntries(Object.entries(current.queries).map(([identity, query]) => [
        identity,
        {
          ...query,
          stale: query.stale || query.tags.some((tag) => action.tags.some((candidate) =>
            tag.type === candidate.type && tag.id === candidate.id)),
        },
      ]));
      const next: InvalidationState<Name> = {
        ...current,
        revision,
        queries,
        history: [...current.history, { revision, tags: action.tags }],
        ...(action.receipt === null ? {} : {
          receipts: { ...current.receipts, [action.receipt]: matched },
        }),
      };

      return options.setState(state, pruneHistory(next));
    }

    return {
      actions: { seed, invalidate, started, succeeded, finished, forget },
      reducer,
      isEligible,
      hasPending: (state: State, input: { readonly identity: string; readonly requestId: string }): boolean =>
        options.getState(state).queries[input.identity]?.pending[input.requestId] !== undefined,
      revision: (state: State): number => options.getState(state).revision,
      registerMutation,
      mutationReceipt,
      hasReceipt: (state: State, receipt: string): boolean =>
        options.getState(state).receipts?.[receipt] !== undefined,
      acknowledge: (receipt: string): InvalidationAction<Name> => ({
        type,
        kind: 'acknowledged',
        receipt,
      }),
      ensureInstalled: Effect.fnUntraced(function*(input: {
        readonly store: {
          readonly getState: Effect.Effect<State>;
          readonly dispatch: (action: InvalidationAction<Name>) => Effect.Effect<unknown>;
        };
      }): Effect.fn.Return<void, Error> {
        const receipt = yield* Effect.sync(() => crypto.randomUUID());

        yield* input.store.dispatch({ type, kind: 'probe', receipt });

        if (options.getState(yield* input.store.getState).receipts?.[receipt] === undefined)
          return yield* Effect.fail(new Error(`Could not find ${options.name} invalidation registry.`));

        yield* input.store.dispatch({ type, kind: 'acknowledged', receipt });

        if (options.getState(yield* input.store.getState).receipts?.[receipt] !== undefined)
          return yield* Effect.fail(new Error(`Could not acknowledge ${options.name} invalidation.`));
      }),
      invalidate: Effect.fnUntraced(function*(input: {
        readonly store: {
          readonly getState: Effect.Effect<State>;
          readonly dispatch: (action: InvalidationAction<Name>) => Effect.Effect<unknown>;
        };
        readonly tags: readonly InvalidationTag<Name>[];
      }): Effect.fn.Return<{ readonly matched: number }, Error> {
        const receipt = yield* Effect.sync(() => crypto.randomUUID());

        yield* input.store.dispatch({ type, kind: 'invalidate', tags: input.tags, receipt });
        const matched = options.getState(yield* input.store.getState).receipts?.[receipt];

        if (matched === undefined)
          return yield* Effect.fail(new Error(`Could not publish ${options.name} invalidation.`));

        yield* input.store.dispatch({ type, kind: 'acknowledged', receipt });

        if (options.getState(yield* input.store.getState).receipts?.[receipt] !== undefined)
          return yield* Effect.fail(new Error(`Could not acknowledge ${options.name} invalidation.`));

        return { matched };
      }),
      select: (state: State, identity: string): 'uninitialized' | 'fresh' | 'stale' => {
        const query = options.getState(state).queries[identity];

        return query?.stale ? 'stale' : query?.initialized ? 'fresh' : 'uninitialized';
      },
    };
  };
}
