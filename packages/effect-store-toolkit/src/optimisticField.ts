import type { Draft } from 'immer';

export type OptimisticWrite<Value> =
  | {
    readonly status: 'saving';
    readonly requestId: string;
    readonly original: Value
  }
  | {
    readonly status: 'error';
    readonly error: string
  };

/**
 * Supplies field transitions only. Lifecycle ownership guards and explicit
 * case registration remain separate; canStart applies only to new writes.
 */
export function createOptimisticFieldReducers<State, Input>() {
  return function defineField<const Key extends string, Entity extends Record<Key, unknown>>(options: {
    readonly field: Key;
    readonly value: (input: Input) => NoInfer<Entity[Key]>;
    readonly canStart: (state: Draft<State>, input: Input) => boolean;
    readonly select: (state: Draft<State>, input: Input) => {
      readonly entity: Entity;
      readonly writes: Record<string, OptimisticWrite<Entity[Key]>>;
      readonly id: string;
    } | undefined;
  }) {
    return {
      onStarted(state: Draft<State>, payload: Input & { readonly requestId: string }): void {
        if (!options.canStart(state, payload))
          return;

        const target = options.select(state, payload);

        if (!target)
          return;

        target.writes[target.id] = {
          status: 'saving',
          requestId: payload.requestId,
          original: target.entity[options.field],
        };
        target.entity[options.field] = options.value(payload);
      },

      onConfirmed(
        state: Draft<State>,
        payload: Input & { readonly requestId: string },
        result: Entity[Key],
      ): void {
        const target = options.select(state, payload);

        if (!target)
          return;

        target.entity[options.field] = result;
        delete target.writes[target.id];
      },

      onFailed(
        state: Draft<State>,
        payload: Input & { readonly requestId: string; readonly error: string },
        pending: { readonly original: Entity[Key] },
      ): void {
        const target = options.select(state, payload);

        if (!target)
          return;

        target.entity[options.field] = pending.original;
        target.writes[target.id] = { status: 'error', error: payload.error };
      },
    };
  };
}
