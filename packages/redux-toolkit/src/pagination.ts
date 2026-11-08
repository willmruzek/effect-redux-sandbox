import { Cause, Effect } from 'effect';
import { produce, type Draft } from 'immer';

import { validateCursorPage } from './cursor.js';
import type { RequestOutcome, RequestResult } from './engine.js';

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

type PaginationOptions<State, Cursor, Page> = {
  readonly name: string;
  readonly getState: (state: State) => CursorPaginationState<Cursor>;
  readonly setState: (state: Draft<State>, pagination: CursorPaginationState<Cursor>) => void;
  readonly pageInfo: (page: Page) => { readonly cursor: Cursor | null; readonly hasNextPage: boolean };
  readonly merge: (state: Draft<State>, page: Page, request: PaginationRequest<Cursor>) => void;
};

type RunInput<State, Cursor, Page> = {
  readonly store: {
    readonly getState: Effect.Effect<State>;
    readonly dispatch: (action: PaginationAction<Cursor, Page>) => Effect.Effect<unknown>;
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
  return function define(options: PaginationOptions<State, Cursor, Page>) {
    const type = `${options.name}/pagination`;

    function reducer(state: State, action: { readonly type: string }): State {
      function matches(value: { readonly type: string }): value is PaginationAction<Cursor, Page> {
        return value.type === type;
      }

      if (!matches(action))
        return state;

      const current = options.getState(state);

      if (action.kind !== 'started' && current.pending?.requestId !== action.request.requestId)
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
      input: RunInput<State, Cursor, Page>,
      mode: 'next' | 'refresh',
    ): Effect.fn.Return<RequestOutcome, Error> {
      const current = options.getState(yield* input.store.getState);

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

      const perform = Effect.fnUntraced(function*(): Effect.fn.Return<RequestOutcome, Error> {
        yield* input.store.dispatch({ type, kind: 'started', request });

        if (options.getState(yield* input.store.getState).pending?.requestId !== request.requestId)
          return yield* Effect.fail(new Error(`Could not claim ${options.name} pagination request.`));

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

        yield* input.store.dispatch({
          type,
          kind: 'succeeded',
          request,
          page,
          cursor: validated.success.cursor,
          exhausted: !validated.success.hasNextPage,
        });
        return { status: 'succeeded' };
      });

      return yield* perform().pipe(Effect.onError((cause) =>
        input.store.dispatch({
          type,
          kind: 'failed',
          request,
          message: Cause.hasInterruptsOnly(cause) ? 'Request interrupted.' : Cause.pretty(cause),
        }).pipe(Effect.asVoid)));
    });

    return {
      reducer,
      next: (input: RunInput<State, Cursor, Page>) => run(input, 'next'),
      refresh: (input: RunInput<State, Cursor, Page>) => run(input, 'refresh'),
    };
  };
}
