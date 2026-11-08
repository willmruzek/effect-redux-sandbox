import type { StoreMiddleware } from '@repo/effect-store';

/** Logs only synchronous plain-action transitions, never Effect programs. */
export function createLoggerMiddleware<
  State,
  Action extends { readonly type: string },
>(): StoreMiddleware<State, Action> {
  return ({
    action,
    getState,
    next
  }) => {
    const before = getState();
    const started = performance.now();
    let failure: unknown;
    let failed = false;

    try {
      return next();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const duration = performance.now() - started;

      console.groupCollapsed(
        `%c[effect-store] ${action.type} (${duration.toFixed(2)} ms)`,
        `color: ${failed ? '#dc2626' : '#16a34a'}; font-weight: bold`,
      );

      try {
        console.log('%cprev state', 'color: #64748b', before);
        console.log('%cinput', 'color: #2563eb', action);

        if (failed)
          console.log('%cfailure', 'color: #dc2626', failure);

        console.log('%cnext state', 'color: #16a34a', getState());
        console.log('%cduration', 'color: #64748b', duration, 'ms');
      } finally {
        console.groupEnd();
      }
    }
  };
}
