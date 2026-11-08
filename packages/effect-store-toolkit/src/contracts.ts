import type { Draft } from 'immer';

export type PayloadAction<Payload = void, Type extends string = string> = {
  readonly type: Type;
  readonly payload: Payload;
};

export type ActionCreator<Payload, Type extends string> = {
  (payload: Payload): PayloadAction<Payload, Type>;
  readonly type: Type;
};

export type SliceActions<Creators extends Readonly<Record<string, unknown>>> = ReturnType<
  Extract<Creators[keyof Creators], (...args: never[]) => PayloadAction<unknown>>
>;

export type CaseReducer<State, Payload> = (
  state: Draft<State>,
  action: PayloadAction<Payload>,
) => State | void;

export type SliceBuilder<State, Name extends string> = {
  reducer<const Key extends string, Payload = void>(
    key: Key,
    handler: CaseReducer<State, Payload>,
  ): ActionCreator<Payload, `${Name}/${Key}`>;
};

export type ExtraReducersBuilder<State> = {
  addCase<Payload, const Type extends string>(
    creator: ActionCreator<Payload, Type>,
    handler: CaseReducer<State, Payload>,
  ): void;
};
