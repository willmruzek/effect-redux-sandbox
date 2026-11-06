import type { Middleware } from '@reduxjs/toolkit';
import { Effect } from 'effect';

export type DispatchableEffect<A = unknown, E = unknown> = Effect.Effect<
  A,
  E,
  never
>;

export type EffectDispatch = <A, E>(
  effect: DispatchableEffect<A, E>,
) => Promise<A>;

function isDispatchableEffect(value: unknown): value is DispatchableEffect {
  return Effect.isEffect(value);
}

export function createEffectMiddleware<State extends object>(): Middleware<
  EffectDispatch,
  State
> {
  return () => (next) => (action) => {
    if (isDispatchableEffect(action)) {
      return Effect.runPromise(action);
    }

    return next(action);
  };
}
