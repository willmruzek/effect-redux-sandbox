import { produce } from 'immer';

import type {
  ActionCreator,
  PayloadAction,
  CaseReducer,
  ExtraReducersBuilder,
  SliceBuilder
} from './contracts.js';

export type {
  ActionCreator,
  ExtraReducersBuilder,
  PayloadAction,
  SliceActions,
  SliceBuilder
} from './contracts.js';

function isInitializer<State>(value: State | (() => State)): value is () => State {
  return typeof value === 'function';
}

/**
 * Registers synchronous Immer case reducers and returns their action creators.
 * The callback returns creators directly so payload inference needs no type casts.
 * External actions are handled through explicit extraReducers.addCase registration.
 */
export function createSlice<State, const Name extends string, Creators extends Readonly<Record<string, unknown>>>(options: {
  readonly name: Name;
  readonly initialState: State | (() => State);
  readonly reducers: (slice: SliceBuilder<State, Name>) => Creators;
  readonly extraReducers?: (builder: ExtraReducersBuilder<State>) => void;
}) {
  const handlers = new Map<string, (state: State, action: { readonly type: string }) => State>();
  let registering = true;

  function addCase<Payload, const Type extends string>(
    creator: ActionCreator<Payload, Type>,
    handler: CaseReducer<State, Payload>,
  ): void {
    if (!registering)
      throw new Error('Reducers can only be registered while creating a slice.');

    const type = creator.type;

    if (handlers.has(type))
      throw new Error(`Duplicate reducer: ${type}`);

    // Like RTK, registered action types identify trusted, typed dispatch payloads.
    function matches(action: { readonly type: string }): action is PayloadAction<Payload, typeof type> {
      return action.type === type;
    }

    handlers.set(type, (state, action) => {
      if (!matches(action))
        return state;

      return produce<State>((draft) => handler(draft, action))(state);
    });
  }

  function reducer<const Key extends string, Payload = void>(
    key: Key,
    handler: CaseReducer<State, Payload>,
  ): ActionCreator<Payload, `${Name}/${Key}`> {
    const type: `${Name}/${Key}` = `${options.name}/${key}`;
    const creator = Object.assign(
      (payload: Payload): PayloadAction<Payload, typeof type> => ({ type, payload }),
      { type },
    );

    addCase(creator, handler);
    return creator;
  }

  const actions = options.reducers({ reducer });

  options.extraReducers?.({ addCase });
  registering = false;

  function getInitialState(): State {
    const initial = isInitializer(options.initialState) ? options.initialState() : options.initialState;

    return produce<State>(initial, () => { });
  }

  return {
    name: options.name,
    actions,
    getInitialState,

    reducer({ state = getInitialState(), action }: Readonly<{
      state: State | undefined;
      action: { readonly type: string };
    }>): State {
      const handler = handlers.get(action.type);

      return handler ? handler(state, action) : state;
    },
  };
}
