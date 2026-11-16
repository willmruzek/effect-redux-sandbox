import {
  Context,
  Effect,
  type ManagedRuntime
} from 'effect';

export type DispatchableEffect<Id, A = unknown, E = unknown, R = never> = Effect.Effect<A, E, Id | R>;

export type EffectDispatch<Action, Id> = {
  (action: Action): Effect.Effect<Action>;
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Id>>;
};

export type StoreService<
  State,
  Action,
  Id,
  Services extends object = Record<never, never>,
> = Services & {
  readonly getState: Effect.Effect<State>;
  readonly dispatch: EffectDispatch<Action, Id>;
};

export type StoreMiddleware<State, Action> = (context: {
  readonly action: Action;
  readonly getState: () => State;
  readonly dispatch: (action: Action) => Action;
  readonly next: () => Action;
}) => Action;

export type StoreDispatch<Action, Id, R> = {
  (action: Action): Action;
  <A, E>(program: DispatchableEffect<Id, A, E, R>): Promise<A>;
};

export type Store<State, Action, Id, R = never> = {
  readonly dispatch: StoreDispatch<Action, Id, R>;
  readonly getSnapshot: () => State;
  readonly subscribe: (listener: () => void) => () => void;
};

type StoreActionService<State, Action> = {
  readonly getState: Effect.Effect<State>;
  readonly dispatch: {
    bivarianceHack(action: Action): Effect.Effect<unknown>;
  }['bivarianceHack'];
};

export type StoreOptions<
  State,
  Action,
  Id,
  R,
  ER,
  Services extends object = Record<never, never>,
> = {
  readonly service: Context.Service<
    Id,
    StoreService<State, Action, Id, Services>
  >;
  readonly services?: Services;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, ER>;
  readonly initialState: State;
  readonly reducer: (input: Readonly<{
    state: State;
    action: Action
  }>) => State;
  readonly middleware?: readonly StoreMiddleware<State, Action>[];
};

export type StoreOptionsWithContext<
  State,
  Action,
  Id,
  R,
  ER,
  AdditionalId,
  Services extends object = Record<never, never>,
> = StoreOptions<State, Action, Id, R, ER, Services> & {
  readonly context: (
    store: StoreActionService<State, Action>,
  ) => Context.Context<AdditionalId>;
};

/**
 * Plain actions and notifications are synchronous. Internal Effect dispatch
 * composes in the caller; only external dispatch uses the supplied runtime.
 * The application owns runtime disposal and all resource scopes.
 */
function createStoreInternal<
  State,
  Action extends { readonly type: string },
  Id,
  R,
  ER,
  AdditionalId,
  Services extends object = Record<never, never>,
>(
  options: StoreOptionsWithContext<
    State,
    Action,
    Id,
    R,
    ER,
    AdditionalId,
    Services
  >,
): Store<State, Action, Id | AdditionalId, R> {
  let state = options.initialState;
  let reducing = false;
  const listeners = new Set<() => void>();

  function getSnapshot(): State {
    if (reducing)
      throw new Error('Cannot read state while the reducer is executing.');

    return state;
  }

  function reduce(action: Action): Action {
    if (reducing)
      throw new Error('Cannot dispatch while the reducer is executing.');

    try {
      reducing = true;
      state = options.reducer({ state, action });
    } finally {
      reducing = false;
    }

    for (const listener of [...listeners])
      listener();

    return action;
  }

  function dispatchAction(action: Action): Action {
    const next = (options.middleware ?? []).reduceRight<() => Action>(
      (next, handler) => () => handler({
        action,
        getState: getSnapshot,
        dispatch: dispatchAction,
        next
      }),
      () => reduce(action),
    );

    return next();
  }

  function provideServices<A, E, Requirements>(
    program: Effect.Effect<A, E, Requirements>,
  ): Effect.Effect<A, E, Exclude<Requirements, Id>> {
    const storeContext = Context.make(options.service, service);

    return Effect.provideContext(program, storeContext);
  }

  function dispatchEffect(action: Action): Effect.Effect<Action>;

  function dispatchEffect<A, E, Requirements>(
    program: Effect.Effect<A, E, Requirements>,
  ): Effect.Effect<A, E, Exclude<Requirements, Id>>;

  function dispatchEffect<A, E, Requirements>(
    input: Action | Effect.Effect<A, E, Requirements>,
  ): Effect.Effect<Action | A, E, Exclude<Requirements, Id>> {
    return Effect.isEffect(input)
      ? provideServices(input)
      : Effect.sync(() => dispatchAction(input));
  }

  const service: StoreService<State, Action, Id, Services> = Object.assign(
    {},
    options.services,
    {
      getState: Effect.sync(getSnapshot),
      dispatch: dispatchEffect,
    },
  );

  function dispatch(action: Action): Action;

  function dispatch<A, E>(
    program: DispatchableEffect<Id | AdditionalId, A, E, R>,
  ): Promise<A>;

  function dispatch<A, E>(
    input: Action | DispatchableEffect<Id | AdditionalId, A, E, R>,
  ): Action | Promise<A> {
    if (!Effect.isEffect(input))
      return dispatchAction(input);

    const additionalContext = options.context({
      getState: Effect.sync(getSnapshot),
      dispatch: (action) => Effect.sync(() => dispatchAction(action)),
    });
    const program = Effect.provideContext(input, additionalContext);

    return options.runtime.runPromise(dispatchEffect(program));
  }

  return {
    dispatch,
    getSnapshot,

    subscribe: (listener) => {
      if (reducing)
        throw new Error('Cannot subscribe while the reducer is executing.');

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createStore<
  State,
  Action extends { readonly type: string },
  Id,
  R,
  ER,
  Services extends object = Record<never, never>,
>(
  options: StoreOptions<State, Action, Id, R, ER, Services>,
): Store<State, Action, Id, R> {
  return createStoreInternal({
    ...options,
    context: () => Context.empty(),
  });
}

export function createStoreWithContext<
  State,
  Action extends { readonly type: string },
  Id,
  R,
  ER,
  AdditionalId,
  Services extends object = Record<never, never>,
>(
  options: StoreOptionsWithContext<
    State,
    Action,
    Id,
    R,
    ER,
    AdditionalId,
    Services
  >,
): Store<State, Action, Id | AdditionalId, R> {
  return createStoreInternal(options);
}
