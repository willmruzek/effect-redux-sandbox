import { Cause, Effect } from 'effect';
import { produce, type Draft } from 'immer';

import { validateCursorPage } from './cursor.js';
import type { RequestOutcome, RequestResult } from './engine.js';
import type {
  InvalidationTag,
  QueryInvalidationRegistry,
} from './invalidation.js';

export type PaginationOutcome = RequestOutcome | { readonly status: 'stale' };

/** Returns the registry identity for a cursor chain. */
export function cursorChainKey(name: string, identity: string): string {
  return JSON.stringify([name, identity]);
}

export type PaginationRequest<Cursor> = {
  readonly requestId: string;
  readonly identity: string;
  readonly after: Cursor | null;
  readonly mode: 'next' | 'refresh';
};

export type CursorPaginationState<Cursor> = {
  readonly identity: string;
  readonly cursor: Cursor | null;
  readonly exhausted: boolean;
  readonly pending: PaginationRequest<Cursor> | null;
  readonly error: Omit<PaginationRequest<Cursor>, 'requestId'> & { readonly message: string } | null;
};

export type PaginationAction<Cursor, Page> =
  | { readonly type: string; readonly kind: 'started'; readonly request: PaginationRequest<Cursor> }
  | { readonly type: string; readonly kind: 'succeeded'; readonly request: PaginationRequest<Cursor>; readonly page: Page; readonly cursor: Cursor | null; readonly exhausted: boolean }
  | { readonly type: string; readonly kind: 'failed'; readonly request: PaginationRequest<Cursor>; readonly message: string }
  | { readonly type: string; readonly kind: 'abandoned'; readonly request: PaginationRequest<Cursor> };

type PaginationOptions<State, Cursor, Page, Name extends string, Action> = {
  readonly name: string;
  readonly getState: (state: State) => CursorPaginationState<Cursor>;
  readonly setState: (state: Draft<State>, pagination: CursorPaginationState<Cursor>) => void;
  readonly pageInfo: (page: Page) => { readonly cursor: Cursor | null; readonly hasNextPage: boolean };
  readonly merge: (state: Draft<State>, page: Page, request: PaginationRequest<Cursor>) => void;
  readonly invalidation?: {
    readonly registry: QueryInvalidationRegistry<State, Name, Action>;
    readonly fromIdentity: (identity: string) => readonly InvalidationTag<Name>[];
    readonly fromPage: (page: Page, request: PaginationRequest<Cursor>) => readonly InvalidationTag<Name>[];
  };
};

type RunInput<State, Cursor, Page, Action = never> = {
  readonly store: {
    readonly getState: Effect.Effect<State>;
    readonly dispatch: (action: PaginationAction<Cursor, Page> | Action) => Effect.Effect<unknown>;
  };
  readonly identity: string;
  readonly restart?: boolean;
} & (
  | { readonly execute: (after: Cursor | null, signal: AbortSignal) => Promise<Page> }
  | {
    readonly query: (
      after: Cursor | null,
      request: PaginationRequest<Cursor>,
    ) => Effect.Effect<RequestResult<Page>, Error>;
  }
);

/** Define a single store-owned cursor chain without installing its reducer. */
export function createCursorPagination<State, Cursor, Page>() {
  return function define<const Name extends string = never, Action = never>(
    options: PaginationOptions<State, Cursor, Page, Name, Action>,
  ) {
    const type = `${options.name}/pagination`;
    const invalidation = options.invalidation;
    const key = (identity: string): string => cursorChainKey(options.name, identity);

    function reducer(state: State, action: { readonly type: string }): State {
      function matches(value: { readonly type: string }): value is PaginationAction<Cursor, Page> {
        return value.type === type;
      }

      if (!matches(action))
        return state;

      const current = options.getState(state);

      if (action.kind !== 'started' && current.pending?.requestId !== action.request.requestId)
        return state;

      if (action.kind === 'succeeded' && invalidation && !invalidation.registry.isEligible(state, {
        identity: key(action.request.identity),
        requestId: action.request.requestId,
        tags: invalidation.fromPage(action.page, action.request),
      }))
        return state;

      return produce(state, (draft) => {
        if (action.kind === 'started') {
          options.setState(draft, { ...current, pending: action.request, error: null });
          return;
        }

        if (action.kind === 'failed') {
          const { identity, after, mode } = action.request;

          options.setState(draft, {
            ...current,
            pending: null,
            error: { identity, after, mode, message: action.message },
          });
          return;
        }

        if (action.kind === 'abandoned') {
          options.setState(draft, { ...current, pending: null });
          return;
        }

        options.merge(draft, action.page, action.request);
        options.setState(draft, {
          identity: action.request.identity,
          cursor: action.cursor,
          exhausted: action.exhausted,
          pending: null,
          error: null,
        });
      });
    }

    const run = Effect.fnUntraced(function*(
      input: RunInput<State, Cursor, Page, Action>,
      mode: 'next' | 'refresh',
    ): Effect.fn.Return<PaginationOutcome, Error> {
      if (invalidation)
        yield* invalidation.registry.ensureInstalled({ store: input.store });

      const current = options.getState(yield* input.store.getState);

      if (
        mode === 'next' &&
        !input.restart &&
        current.identity === input.identity &&
        invalidation?.registry.select(yield* input.store.getState, key(input.identity)) === 'stale'
      )
        return { status: 'stale' };

      if (mode === 'next' && current.pending?.identity === input.identity)
        return { status: 'skipped' };
      if (
        mode === 'next' &&
        !input.restart &&
        !current.pending &&
        current.identity === input.identity &&
        current.exhausted &&
        !current.error
      )
        return { status: 'skipped' };

      const retry = mode === 'next' && current.error?.identity === input.identity ? current.error : null;
      const actualMode = retry?.mode ?? mode;
      const after = actualMode === 'refresh' ||
        input.restart ||
        current.identity !== input.identity ||
        (current.pending !== null && current.pending.identity !== input.identity) ||
        (current.error !== null && current.error.identity !== input.identity)
        ? null
        : retry ? retry.after : current.cursor;
      const request: PaginationRequest<Cursor> = {
        requestId: yield* Effect.sync(() => crypto.randomUUID()),
        identity: input.identity,
        after,
        mode: actualMode,
      };
      let registered = false;

      const perform = Effect.fnUntraced(function*(): Effect.fn.Return<PaginationOutcome, Error> {
        yield* input.store.dispatch({ type, kind: 'started', request });

        if (options.getState(yield* input.store.getState).pending?.requestId !== request.requestId)
          return yield* Effect.fail(new Error(`Could not claim ${options.name} pagination request.`));

        if (invalidation) {
          registered = true;
          yield* input.store.dispatch(invalidation.registry.actions.started({
            identity: key(request.identity),
            requestId: request.requestId,
            tags: invalidation.fromIdentity(request.identity),
          }));

          if (!invalidation.registry.hasPending(yield* input.store.getState, {
            identity: key(request.identity),
            requestId: request.requestId,
          }))
            return yield* Effect.fail(new Error(`Could not register ${options.name} pagination dependencies.`));
        }

        const execution = 'query' in input
          ? input.query(after, request)
          : Effect.tryPromise({
            try: (signal) => input.execute(after, signal),
            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          }).pipe(Effect.map((page): RequestResult<Page> => ({ status: 'succeeded', result: page })));
        const result = yield* Effect.result(execution);

        if (options.getState(yield* input.store.getState).pending?.requestId !== request.requestId)
          return { status: 'superseded' };
        if (result._tag === 'Failure') {
          yield* input.store.dispatch({ type, kind: 'failed', request, message: result.failure.message });
          return { status: 'failed', error: result.failure.message };
        }

        if (result.success.status === 'failed') {
          yield* input.store.dispatch({ type, kind: 'failed', request, message: result.success.error });
          return result.success;
        }

        if (result.success.status !== 'succeeded') {
          yield* input.store.dispatch({ type, kind: 'abandoned', request });
          return result.success;
        }

        const page = result.success.result;
        const validated = yield* Effect.result(Effect.try({
          try: () => {
            const info = options.pageInfo(page);

            validateCursorPage({ after, endCursor: info.cursor, hasNextPage: info.hasNextPage });
            return info;
          },
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }));

        if (validated._tag === 'Failure') {
          yield* input.store.dispatch({ type, kind: 'failed', request, message: validated.failure.message });
          return { status: 'failed', error: validated.failure.message };
        }

        if (invalidation && !invalidation.registry.isEligible(yield* input.store.getState, {
          identity: key(request.identity),
          requestId: request.requestId,
          tags: invalidation.fromPage(page, request),
        })) {
          yield* input.store.dispatch(invalidation.registry.actions.succeeded({
            identity: key(request.identity),
            requestId: request.requestId,
            tags: invalidation.fromPage(page, request),
            append: request.after !== null,
          }));
          yield* input.store.dispatch({ type, kind: 'abandoned', request });
          return { status: 'superseded' };
        }

        yield* input.store.dispatch({
          type,
          kind: 'succeeded',
          request,
          page,
          cursor: validated.success.cursor,
          exhausted: !validated.success.hasNextPage,
        });

        if (invalidation) {
          const currentState = yield* input.store.getState;
          const eligible = invalidation.registry.isEligible(currentState, {
            identity: key(request.identity),
            requestId: request.requestId,
            tags: invalidation.fromPage(page, request),
          });
          const pending = options.getState(currentState).pending?.requestId === request.requestId;

          yield* input.store.dispatch(invalidation.registry.actions.succeeded({
            identity: key(request.identity),
            requestId: request.requestId,
            tags: invalidation.fromPage(page, request),
            append: request.after !== null,
          }));

          if (pending) {
            yield* input.store.dispatch({ type, kind: 'abandoned', request });

            if (eligible)
              return yield* Effect.fail(new Error(`Could not settle ${options.name} pagination request.`));

            return { status: 'superseded' };
          }
        }

        return { status: 'succeeded' };
      });

      return yield* perform().pipe(
        Effect.onError((cause) =>
          input.store.dispatch({
            type,
            kind: 'failed',
            request,
            message: Cause.hasInterruptsOnly(cause) ? 'Request interrupted.' : Cause.pretty(cause),
          }).pipe(Effect.asVoid)),
        Effect.ensuring(Effect.suspend(() => invalidation && registered
          ? input.store.dispatch(invalidation.registry.actions.finished({
            identity: key(request.identity),
            requestId: request.requestId,
          })).pipe(Effect.asVoid)
          : Effect.void)),
      );
    });

    return {
      reducer,
      key,
      selectFreshness: (state: State, identity: string) => {
        if (!invalidation)
          throw new Error(`Pagination ${options.name} has no invalidation dependencies.`);

        return invalidation.registry.select(state, key(identity));
      },
      next: (input: RunInput<State, Cursor, Page, Action>) => run(input, 'next'),
      refresh: (input: RunInput<State, Cursor, Page, Action>) => run(input, 'refresh'),
    };
  };
}
