import {
  Cause,
  Effect
} from 'effect';
import type { Draft } from 'immer';

import type {
  ActionCreator,
  CaseReducer,
  PayloadAction
} from './contracts.js';
import type { RequestOutcome } from './engine.js';

type Started<Input> = Input & { readonly requestId: string };

type Confirmed<Input, Result> = Started<Input> & { readonly result: Result };

type Failed<Input> = Started<Input> & { readonly error: string };

type LifecycleReducers<State, Input, Result, Pending> = {
  readonly onStarted: (state: Draft<State>, payload: Started<Input>) => void;
  readonly onConfirmed: (
    state: Draft<State>,
    payload: Started<Input>,
    result: Result,
    pending: Pending,
  ) => void;
  readonly onFailed: (state: Draft<State>, payload: Failed<Input>, pending: Pending) => void;
};

type Lifecycle<State, Prefix extends string, Input, Result, Pending> = {
  readonly actions: {
    readonly started: ActionCreator<Started<Input>, `${Prefix}Started`>;
    readonly confirmed: ActionCreator<Confirmed<Input, Result>, `${Prefix}Confirmed`>;
    readonly failed: ActionCreator<Failed<Input>, `${Prefix}Failed`>;
  };
  readonly reducers: (handlers: LifecycleReducers<State, Input, Result, Pending>) => {
    readonly started: CaseReducer<State, Started<Input>>;
    readonly confirmed: CaseReducer<State, Confirmed<Input, Result>>;
    readonly failed: CaseReducer<State, Failed<Input>>;
  };
  readonly run: (input: {
    readonly store: {
      readonly getState: Effect.Effect<State>;
      readonly dispatch: (action:
        | PayloadAction<Started<Input>, `${Prefix}Started`>
        | PayloadAction<Confirmed<Input, Result>, `${Prefix}Confirmed`>
        | PayloadAction<Failed<Input>, `${Prefix}Failed`>
      ) => Effect.Effect<unknown>;
    };
    readonly input: Input;
    readonly execute: (signal: AbortSignal) => Promise<Result>;
  }) => Effect.Effect<RequestOutcome, Error>;
};

function createAction<Payload, const Type extends string>(type: Type): ActionCreator<Payload, Type> {
  return Object.assign(
    (payload: Payload): PayloadAction<Payload, Type> => ({ type, payload }),
    { type },
  );
}

/**
 * Defines actions and execution without installing reducers in any store.
 * Guarded case reducers are optional helpers; consumers register them explicitly.
 */
export function createRequestLifecycle<State, Result>() {
  return function defineLifecycle<
    const Prefix extends string,
    Input extends object,
    Pending extends { readonly requestId: string },
  >(
    prefix: Prefix,
    options: {
      readonly pending: (state: State | Draft<State>, input: Input) => Pending | undefined;
    },
  ): Lifecycle<State, Prefix, Input, Result, Pending> {
    const started = createAction<Started<Input>, `${Prefix}Started`>(`${prefix}Started`);
    const confirmed = createAction<Confirmed<Input, Result>, `${Prefix}Confirmed`>(`${prefix}Confirmed`);
    const failed = createAction<Failed<Input>, `${Prefix}Failed`>(`${prefix}Failed`);

    return {
      actions: {
        started,
        confirmed,
        failed,
      },

      reducers: (handlers) => ({
        started: (state, { payload }) => {
          if (options.pending(state, payload))
            return;

          handlers.onStarted(state, payload);
        },

        confirmed: (state, { payload }) => {
          const pending = options.pending(state, payload);

          if (!pending || pending.requestId !== payload.requestId)
            return;

          handlers.onConfirmed(state, payload, payload.result, pending);
        },

        failed: (state, { payload }) => {
          const pending = options.pending(state, payload);

          if (!pending || pending.requestId !== payload.requestId)
            return;

          handlers.onFailed(state, payload, pending);
        },
      }),

      run: Effect.fnUntraced(function*(
        input: Parameters<Lifecycle<State, Prefix, Input, Result, Pending>['run']>[0],
      ): Effect.fn.Return<RequestOutcome, Error> {
        const requestId = yield* Effect.sync(() => crypto.randomUUID());
        const payload = { ...input.input, requestId };

        const perform = Effect.fnUntraced(function*() {
          yield* input.store.dispatch(started(payload));

          if (options.pending(yield* input.store.getState, payload)?.requestId !== requestId) {
            return yield* Effect.fail(new Error(`Could not claim ${prefix} request.`));
          }

          const result = yield* Effect.result(Effect.tryPromise({
            try: (signal) => input.execute(signal),
            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          }));

          if (options.pending(yield* input.store.getState, payload)?.requestId !== requestId) {
            return { status: 'superseded' } satisfies RequestOutcome;
          }

          if (result._tag === 'Failure') {
            yield* input.store.dispatch(failed({
              ...payload,
              error: result.failure.message,
            }));

            return { status: 'failed', error: result.failure.message } satisfies RequestOutcome;
          }

          yield* input.store.dispatch(confirmed({ ...payload, result: result.success }));
          return { status: 'succeeded' } satisfies RequestOutcome;
        });

        return yield* perform().pipe(Effect.onError((cause) =>
          input.store.dispatch(failed({
            ...payload,
            error: Cause.hasInterruptsOnly(cause) ? 'Request interrupted.' : Cause.pretty(cause),
          })).pipe(Effect.asVoid)));
      }),
    };
  };
}
