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
