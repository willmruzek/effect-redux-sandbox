import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope
} from 'effect';
import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi
} from 'vitest';

import { createAppStore } from './store';
import { ReduxStore } from './reduxStore';
import { trackerActions } from './reducer';

class Message extends Context.Service<Message, { readonly value: string }>()('redux-first/test/Message') { }

class Missing extends Context.Service<Missing, { readonly value: string }>()('redux-first/test/Missing') { }

const runtimes: ManagedRuntime.ManagedRuntime<Message, never>[] = [];

function arrange() {
  vi.stubEnv('DEV', false);

  const runtime = ManagedRuntime.make(Layer.succeed(Message, { value: 'provided' }));

  runtimes.push(runtime);

  return { runtime, store: createAppStore(runtime) };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('dispatch contract', () => {
  test('commits plain actions before returning', () => {
    // Arrange: observe notifications from an independent store.
    const { store } = arrange();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const action = trackerActions.projectSelected('atlas');

    // Act: dispatch without awaiting.
    const result = store.dispatch(action);

    // Assert: the action and state are available synchronously.
    expect(result).toBe(action);
    expect(store.getState().selectedProjectId).toBe('atlas');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test('uses application services at the external Promise boundary', async () => {
    // Arrange: the supplied runtime owns the Message service.
    const { store } = arrange();
    const program = Effect.gen(function*() {
      const message = yield* Message;
      const store = yield* ReduxStore;

      yield* store.dispatch(trackerActions.projectSelected('atlas'));

      return message.value;
    });

    // Act: dispatch through the application runtime.
    const result = store.dispatch(program);

    // Assert: service requirements are checked and success is inferred.
    expectTypeOf(result).toEqualTypeOf<Promise<string>>();
    expectTypeOf<Effect.Effect<void, never, Missing>>().not.toExtend<
      Parameters<typeof store.dispatch>[0]
    >();
    await expect(result).resolves.toBe('provided');
  });

  test(
    'preserves nested errors and caller dependencies without executing eagerly',
    async () => {
      // Arrange: the child requires a service absent from the application runtime.
      const { store } = arrange();
      const child = Effect.gen(function*() {
        yield* Missing;

        return yield* Effect.fail('expected failure');
      });
      const parent = Effect.gen(function*() {
        const store = yield* ReduxStore;
        const nested = store.dispatch(child);

        expectTypeOf(nested).toEqualTypeOf<Effect.Effect<never, string, Missing>>();

        return yield* nested.pipe(
          Effect.provideService(Missing, { value: 'caller supplied' }),
          Effect.catch((error) => Effect.succeed(error)),
        );
      });

      // Act: compose and recover without a Promise bridge.
      const result = await store.dispatch(parent);

      // Assert: typed failure recovery remains inside the caller.
      expect(result).toBe('expected failure');
    }
  );

  test('keeps internal plain-action dispatch lazy', async () => {
    // Arrange: create an action Effect without running it.
    const { store } = arrange();
    const parent = Effect.gen(function*() {
      const service = yield* ReduxStore;
      const action = service.dispatch(trackerActions.projectSelected('atlas'));

      expect((yield* service.getState).selectedProjectId).toBeNull();
      yield* action;

      return (yield* service.getState).selectedProjectId;
    });

    // Act: execute the action Effect.
    const result = await store.dispatch(parent);

    // Assert: executing the wrapper commits the action before the next read.
    expect(result).toBe('atlas');
  });

  test('preserves caller scopes across nested dispatch', async () => {
    // Arrange: the caller explicitly owns a scope.
    const { store } = arrange();
    const released = vi.fn();
    const scope = Effect.runSync(Scope.make());
    const child = Effect.acquireRelease(Effect.succeed('resource'), () => Effect.sync(released));
    const parent = Effect.gen(function*() {
      const store = yield* ReduxStore;
      const nested = store.dispatch(child);

      expectTypeOf(nested).toEqualTypeOf<Effect.Effect<string, never, Scope.Scope>>();

      return yield* Scope.provide(scope)(nested);
    });

    // Act: finish dispatch while leaving the caller's scope open.
    await store.dispatch(parent);

    // Assert: dispatch did not create or close an operation scope.
    expect(released).not.toHaveBeenCalled();
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    expect(released).toHaveBeenCalledTimes(1);
  });

  test('interrupts nested work with its dispatching fiber', async () => {
    // Arrange: the child signals startup and has a cleanup finalizer.
    const { store } = arrange();
    const started = Effect.runSync(Deferred.make<void>());
    const cleaned = vi.fn();
    const child = Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined);
      yield* Effect.never;
    }).pipe(Effect.ensuring(Effect.sync(cleaned)));
    const parent = Effect.gen(function*() {
      const store = yield* ReduxStore;
      const fiber = yield* Effect.forkChild(store.dispatch(child));

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
    });

    // Act: interrupt the composed child.
    await store.dispatch(parent);

    // Assert: nested dispatch did not detach the child's execution.
    expect(cleaned).toHaveBeenCalledTimes(1);
  });

  test('rejects unhandled failures without creating an error action', async () => {
    // Arrange: observe the unchanged snapshot.
    const { store } = arrange();
    const before = store.getState();
    const error = new Error('unhandled');

    // Act: dispatch a failed workflow.
    const result = store.dispatch(Effect.fail(error));

    // Assert: rejection does not invent a state transition.
    await expect(result).rejects.toBe(error);
    expect(store.getState()).toBe(before);
  });

  test('leaves runtime disposal to the application owner', async () => {
    // Arrange: an externally dispatched operation never finishes on its own.
    const { store, runtime } = arrange();
    const started = Effect.runSync(Deferred.make<void>());
    const cleaned = vi.fn();
    const pending = store.dispatch(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(cleaned)),
      ),
    );
    const rejected = expect(pending).rejects.toBeDefined();

    await Effect.runPromise(Deferred.await(started));

    // Act: the application shuts down its runtime.
    await runtime.dispose();

    // Assert: owned work ends, but plain Redux-style state remains usable.
    await rejected;
    expect(cleaned).toHaveBeenCalledTimes(1);
    store.dispatch(trackerActions.projectSelected('atlas'));
    expect(store.getState().selectedProjectId).toBe('atlas');
  });
});
