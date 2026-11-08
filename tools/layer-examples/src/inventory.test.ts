import {
  Deferred,
  Effect,
  Fiber,
} from 'effect';
import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';

import { createEffectRequests } from './effectRequests.js';
import { createReduxRequests } from './reduxRequests.js';
import type { InventoryState } from './inventory.js';

function pendingResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error('Transport has not started.');
  };
  const fetcher = vi.fn(() => new Promise<Response>((complete) => {
    resolve = complete;
  }));

  return { fetcher, resolve: (response: Response) => resolve(response) };
}

for (const [name, create] of [
  ['Redux', createReduxRequests],
  ['Effect', createEffectRequests],
] satisfies readonly (readonly [string, typeof createReduxRequests])[]) {
  describe(`${name} public request APIs in an inventory domain`, () => {
    test('shares a duplicate query triggered by a synchronous started observer', async () => {
      // Arrange: a started-action observer launches another query immediately.
      const inventory = create();
      const pending = pendingResponse();
      const duplicateTransport = vi.fn(async () => Response.json({
        data: { item: { sku: 'tea', label: 'Tea', quantity: 9 } },
      }));
      let observed = false;
      let duplicate: Promise<unknown> | undefined;
      const service: typeof inventory.service = {
        ...inventory.service,
        dispatch: (action) => Effect.gen(function*() {
          const result = yield* inventory.service.dispatch(action);
          if (!observed && action.type === 'inventory/item/started') {
            observed = true;
            duplicate = Effect.runPromise(inventory.read.run({
              store: service, variables: { sku: 'tea' }, fetcher: duplicateTransport,
            }));
          }
          return result;
        }),
      };

      try {
        // Act: start the original query, triggering the observer's duplicate.
        const first = Effect.runPromise(inventory.read.run({
          store: service, variables: { sku: 'tea' }, fetcher: pending.fetcher,
        }));
        expect(duplicate).toBeDefined();
        pending.resolve(Response.json({
          data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
        }));
        const results = await Promise.all([first, duplicate]);

        // Assert: registration precedes observers without treating the worker as closing.
        expect(results).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
        expect(duplicateTransport).not.toHaveBeenCalled();
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
        expect(inventory.snapshot().items.tea?.quantity).toBe(8);
      } finally {
        await inventory.dispose();
      }
    });

    test('preserves immediate ownership when executing with a synchronous service', async () => {
      // Arrange: transport stays pending after a synchronous ownership claim.
      const inventory = create();
      const pending = pendingResponse();
      const variables = { sku: 'tea' };
      const query = inventory.read.run({
        store: inventory.service, variables, fetcher: pending.fetcher,
      });

      // Act: execute until transport suspends.
      const fiber = Effect.runFork(query);

      try {
        // Assert: callers immediately observe loading state and started I/O.
        expect(inventory.snapshot().api.requests[inventory.read.key(variables)]?.status).toBe('pending');
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
        await inventory.dispose();
      }
    });

    test('keeps query construction lazy', async () => {
      // Arrange: an idle consumer and transport.
      const inventory = create();
      const fetcher = vi.fn(async () => Response.json({ data: {} }));
      const before = inventory.snapshot();

      try {
        // Act: construct without executing the query.
        inventory.read.run({ store: inventory.service, variables: { sku: 'tea' }, fetcher });

        // Assert: construction does not claim state or start transport.
        expect(inventory.snapshot()).toBe(before);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await inventory.dispose();
      }
    });

    test('shares a superseded query outcome with its waiters', async () => {
      // Arrange: identical old queries share one selected-item scope.
      const inventory = create();
      const pending = pendingResponse();
      const input = { store: inventory.service, variables: { sku: 'tea' }, fetcher: pending.fetcher };

      try {
        const first = Effect.runPromise(inventory.read.run(input));
        const duplicate = Effect.runPromise(inventory.read.run(input));
        await Effect.runPromise(Effect.yieldNow);

        // Act: a different key replaces the scope before the old response.
        await Effect.runPromise(inventory.read.run({
          store: inventory.service,
          variables: { sku: 'coffee' },
          fetcher: async () => Response.json({
            data: { item: { sku: 'coffee', label: 'Coffee', quantity: 5 } },
          }),
        }));
        pending.resolve(Response.json({
          data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
        }));
        const results = await Promise.all([first, duplicate]);

        // Assert: all old waiters see supersession, not false success.
        expect(results).toEqual([{ status: 'superseded' }, { status: 'superseded' }]);
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
        expect(inventory.snapshot().items.tea?.quantity).toBe(2);
      } finally {
        await inventory.dispose();
      }
    });

    test('does not share one operation across receiving stores', async () => {
      // Arrange: one definition is consumed by two independent stores.
      const first = create();
      const second = create();
      const pending = pendingResponse();
      const other = vi.fn(async () => Response.json({
        data: { item: { sku: 'tea', label: 'Tea', quantity: 9 } },
      }));

      try {
        const original = Effect.runPromise(first.read.run({
          store: first.service, variables: { sku: 'tea' }, fetcher: pending.fetcher,
        }));
        await Effect.runPromise(Effect.yieldNow);

        // Act: run the same definition/key against the second store.
        await Effect.runPromise(first.read.run({
          store: second.service, variables: { sku: 'tea' }, fetcher: other,
        }));
        pending.resolve(Response.json({
          data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
        }));
        await original;

        // Assert: each store owns its own execution and result.
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(first.snapshot().items.tea?.quantity).toBe(8);
        expect(second.snapshot().items.tea?.quantity).toBe(9);
      } finally {
        await Promise.all([first.dispose(), second.dispose()]);
      }
    });

    test('shares a failed query outcome with one lifecycle', async () => {
      // Arrange: two callers use one pending transport.
      const inventory = create();
      const pending = pendingResponse();
      const actions: string[] = [];
      const service = {
        ...inventory.service,
        dispatch: (action: Parameters<typeof inventory.service.dispatch>[0]) => {
          actions.push(action.type);
          return inventory.service.dispatch(action);
        },
      };
      const input = { store: service, variables: { sku: 'tea' }, fetcher: pending.fetcher };

      try {
        // Act: both callers await the original malformed response.
        const first = Effect.runPromise(inventory.read.run(input));
        const duplicateTransport = vi.fn(async () => Response.json({ data: {} }));
        const second = Effect.runPromise(inventory.read.run({ ...input, fetcher: duplicateTransport }));
        await Effect.runPromise(Effect.yieldNow);
        pending.resolve(Response.json({ data: {} }));
        const outcomes = await Promise.all([first, second]);

        // Assert: failure is shared without another lifecycle or transport.
        expect(outcomes[0]?.status).toBe('failed');
        expect(outcomes[1]).toBe(outcomes[0]);
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
        expect(duplicateTransport).not.toHaveBeenCalled();
        expect(actions).toEqual(['inventory/item/started', 'inventory/item/failed']);
      } finally {
        await inventory.dispose();
      }
    });

    test('shares a publication defect without retaining the failed execution', async () => {
      // Arrange: the receiving store fails while publishing success.
      const inventory = create();
      const pending = pendingResponse();
      let failPublication = true;
      const service = {
        ...inventory.service,
        dispatch: (action: Parameters<typeof inventory.service.dispatch>[0]) => Effect.suspend(() => {
          if (failPublication && action.type === 'inventory/item/succeeded')
            return Effect.die(new Error('Publication failed.'));
          return inventory.service.dispatch(action);
        }),
      };
      const input = { store: service, variables: { sku: 'tea' }, fetcher: pending.fetcher };

      try {
        // Act: both waiters receive the defect from one execution.
        const first = Effect.runPromise(Effect.exit(inventory.read.run(input)));
        const second = Effect.runPromise(Effect.exit(inventory.read.run(input)));
        await Effect.runPromise(Effect.yieldNow);
        pending.resolve(Response.json({
          data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
        }));
        const exits = await Promise.all([first, second]);

        // Assert: cleanup records failure and a later call can execute afresh.
        expect(exits[0]?._tag).toBe('Failure');
        expect(exits[1]).toEqual(exits[0]);
        expect(inventory.snapshot().api.requests[inventory.read.key(input.variables)]?.status).toBe('failed');
        failPublication = false;
        expect(await Effect.runPromise(inventory.read.run({
          ...input,
          fetcher: async () => Response.json({
            data: { item: { sku: 'tea', label: 'Tea', quantity: 9 } },
          }),
        }))).toEqual({ status: 'succeeded' });
      } finally {
        await inventory.dispose();
      }
    });

    test('waits for cancelled ownership cleanup before starting a new query', async () => {
      // Arrange: cancellation publication is deliberately held at the store boundary.
      const inventory = create();
      const entered = Deferred.makeUnsafe<void>();
      const cleanup = Deferred.makeUnsafe<void>();
      const service = {
        ...inventory.service,
        dispatch: (action: Parameters<typeof inventory.service.dispatch>[0]) => Effect.gen(function*() {
          if (action.type === 'inventory/item/cancelled') {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(cleanup);
          }
          return yield* inventory.service.dispatch(action);
        }),
      };
      const fetcher = vi.fn(async () => Response.json({
        data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
      }));
      const input = { store: service, variables: { sku: 'tea' }, fetcher };
      const first = Effect.runFork(inventory.read.run({
        ...input,
        execute: (_variables, signal) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true });
        }),
      }));

      try {
        await Effect.runPromise(Effect.yieldNow);

        // Act: a new caller arrives during the final departing waiter's cleanup.
        const cancellation = Effect.runFork(Fiber.interrupt(first));
        await Effect.runPromise(Deferred.await(entered));
        const retry = Effect.runFork(inventory.read.run(input));
        await Effect.runPromise(Effect.yieldNow);
        expect(fetcher).not.toHaveBeenCalled();
        await Effect.runPromise(Deferred.succeed(cleanup, undefined));
        await Effect.runPromise(Fiber.join(cancellation));
        const result = await Effect.runPromise(Fiber.join(retry));

        // Assert: the new caller starts fresh after ownership is released.
        expect(result).toEqual({ status: 'succeeded' });
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        await Effect.runPromise(Deferred.succeed(cleanup, undefined));
        await Effect.runPromise(Fiber.interrupt(first));
        await inventory.dispose();
      }
    });

    test.each([0, 1])('keeps a query alive when caller %i cancels', async (cancelledCaller) => {
      // Arrange: the original caller and duplicate await a pending response.
      const inventory = create();
      const pending = pendingResponse();
      const input = { store: inventory.service, variables: { sku: 'tea' }, fetcher: pending.fetcher };
      const first = Effect.runFork(inventory.read.run(input));
      const second = Effect.runFork(inventory.read.run(input));
      const leaving = cancelledCaller === 0 ? first : second;
      const remaining = cancelledCaller === 0 ? second : first;

      try {
        await Effect.runPromise(Effect.yieldNow);

        // Act: one caller leaves before transport completes.
        await Effect.runPromise(Fiber.interrupt(leaving));
        pending.resolve(Response.json({
          data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
        }));
        const result = await Effect.runPromise(Fiber.join(remaining));

        // Assert: the remaining caller receives the shared success.
        expect(result).toEqual({ status: 'succeeded' });
        expect(pending.fetcher).toHaveBeenCalledTimes(1);
        expect(inventory.snapshot().items.tea?.quantity).toBe(8);
      } finally {
        await Effect.runPromise(Fiber.interrupt(first));
        await Effect.runPromise(Fiber.interrupt(second));
        await inventory.dispose();
      }
    });

    test('aborts a shared query when its last waiter cancels', async () => {
      // Arrange: transport waits for its abort signal.
      const inventory = create();
      let signal: AbortSignal | null | undefined;
      const fetcher = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true });
        });
      });
      const input = { store: inventory.service, variables: { sku: 'tea' }, fetcher };
      const first = Effect.runFork(inventory.read.run(input));
      const second = Effect.runFork(inventory.read.run(input));

      try {
        await Effect.runPromise(Effect.yieldNow);

        // Act: all callers leave, then explicitly retry.
        await Effect.runPromise(Fiber.interrupt(first));
        expect(signal?.aborted).toBe(false);
        await Effect.runPromise(Fiber.interrupt(second));
        const afterCancellation = inventory.snapshot();
        const retry = await Effect.runPromise(inventory.read.run({
          ...input,
          fetcher: async () => Response.json({
            data: { item: { sku: 'tea', label: 'Tea', quantity: 9 } },
          }),
        }));

        // Assert: abort releases both local work and reducer ownership.
        expect(signal?.aborted).toBe(true);
        expect(afterCancellation.api.requests[inventory.read.key(input.variables)]?.status).toBe('cancelled');
        expect(retry).toEqual({ status: 'succeeded' });
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        await Effect.runPromise(Fiber.interrupt(first));
        await Effect.runPromise(Fiber.interrupt(second));
        await inventory.dispose();
      }
    });

    test('starts fresh transport after a shared query settles', async () => {
      // Arrange: a completed query must not become a response cache.
      const inventory = create();
      const fetcher = vi.fn(async () => Response.json({
        data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
      }));
      const input = { store: inventory.service, variables: { sku: 'tea' }, fetcher };

      try {
        await Effect.runPromise(inventory.read.run(input));

        // Act: repeat the same query after settlement.
        const result = await Effect.runPromise(inventory.read.run(input));

        // Assert: settled entries are released.
        expect(result).toEqual({ status: 'succeeded' });
        expect(fetcher).toHaveBeenCalledTimes(2);
      } finally {
        await inventory.dispose();
      }
    });

    test('keeps consumer store instances isolated', async () => {
      // Arrange: two consumers have independent inventory snapshots.
      const first = create();
      const second = create();

      try {
        // Act: write stock in only the first instance.
        await first.save({ sku: 'tea', value: 5 }, async () => 5);

        // Assert: no global request or entity state leaks.
        expect(first.snapshot().items.tea?.quantity).toBe(5);
        expect(second.snapshot().items.tea?.quantity).toBe(2);
        expect(second.snapshot().writes).toEqual({});
      } finally {
        await Promise.all([first.dispose(), second.dispose()]);
      }
    });

    test('normalizes a decoded read without tracker dependencies', async () => {
      // Arrange: the transport boundary returns an inventory response.
      const inventory = create();
      const fetcher = vi.fn(async () => Response.json({
        data: { item: { sku: 'tea', label: 'Tea', quantity: 8 } },
      }));

      try {
        // Act: execute a query with explicit registered cases.
        const result = await Effect.runPromise(inventory.read.run({
          store: inventory.service,
          variables: { sku: 'tea' },
          fetcher,
        }));

        // Assert: normalized data and request metadata belong to this store.
        expect(result).toEqual({ status: 'succeeded' });
        expect(inventory.snapshot().items.tea).toEqual({ sku: 'tea', label: 'Tea', quantity: 8 });
        expect(inventory.snapshot().api.requests[inventory.read.key({ sku: 'tea' })]?.status).toBe('succeeded');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expectTypeOf(inventory.snapshot()).toEqualTypeOf<InventoryState>();
      } finally {
        await inventory.dispose();
      }
    });

    test('surfaces malformed transport data without merging entities', async () => {
      // Arrange: the boundary returns a quantity of the wrong type.
      const inventory = create();

      try {
        // Act: runtime decoding rejects the response.
        const result = await Effect.runPromise(inventory.read.run({
          store: inventory.service,
          variables: { sku: 'tea' },
          fetcher: async () => Response.json({ data: { item: { sku: 'tea', label: 'Tea', quantity: 'eight' } } }),
        }));

        // Assert: an explicit failed outcome is retained in request metadata.
        expect(result).toEqual({ status: 'failed', error: 'Invalid inventory response.' });
        expect(inventory.snapshot().items.tea?.quantity).toBe(2);
        expect(inventory.snapshot().api.requests[inventory.read.key({ sku: 'tea' })]).toMatchObject({
          status: 'failed',
          error: 'Invalid inventory response.',
        });
      } finally {
        await inventory.dispose();
      }
    });

    test('settles an optimistic numeric write with the authoritative result', async () => {
      // Arrange: hold persistence so the optimistic value can be observed.
      const inventory = create();
      let complete: (value: number) => void = () => {
        throw new Error('Persistence has not started.');
      };
      const execute = vi.fn(() => new Promise<number>((resolve) => {
        complete = resolve;
      }));

      try {
        // Act: start a quantity write, then confirm a different saved value.
        const pending = Effect.runPromise(inventory.write.run({
          store: inventory.service,
          input: { sku: 'tea', value: 5 },
          execute,
        }));

        // Assert: optimism is synchronous before the transport completes.
        expect(inventory.snapshot().items.tea?.quantity).toBe(5);
        expect(inventory.snapshot().writes.tea?.status).toBe('saving');
        complete(4);
        expect(await pending).toEqual({ status: 'succeeded' });
        expect(inventory.snapshot().items.tea?.quantity).toBe(4);
        expect(inventory.snapshot().writes.tea).toBeUndefined();
        expect(execute).toHaveBeenCalledWith(expect.any(AbortSignal));
        expectTypeOf(inventory.write.actions.confirmed({
          sku: 'tea', value: 5, requestId: 'r', result: 4,
        }).payload.result).toEqualTypeOf<number>();
      } finally {
        await inventory.dispose();
      }
    });

    test('rolls back a rejected numeric write with a visible error', async () => {
      // Arrange: a second domain uses the same lifecycle mechanics.
      const inventory = create();

      try {
        // Act: reject persistence at its boundary.
        const result = await Effect.runPromise(inventory.write.run({
          store: inventory.service,
          input: { sku: 'tea', value: 5 },
          execute: async () => { throw new Error('Warehouse unavailable.'); },
        }));

        // Assert: only the quantity intent rolls back.
        expect(result).toEqual({ status: 'failed', error: 'Warehouse unavailable.' });
        expect(inventory.snapshot().items.tea).toEqual({ sku: 'tea', label: 'Tea', quantity: 2 });
        expect(inventory.snapshot().writes.tea).toEqual({ status: 'error', error: 'Warehouse unavailable.' });
      } finally {
        await inventory.dispose();
      }
    });

    test('rejects missing write registration before executing persistence', async () => {
      // Arrange: definitions exist but the consumer omitted the write cases.
      const inventory = create({ registerWrites: false });
      const execute = vi.fn(async () => 5);

      try {
        // Act: attempt execution with no ownership claim.
        const pending = Effect.runPromise(inventory.write.run({
          store: inventory.service,
          input: { sku: 'tea', value: 5 },
          execute,
        }));

        // Assert: no untracked write reaches the boundary.
        await expect(pending).rejects.toThrow('Could not claim inventory/quantity request.');
        expect(execute).not.toHaveBeenCalled();
        expect(inventory.snapshot().items.tea?.quantity).toBe(2);
      } finally {
        await inventory.dispose();
      }
    });

    test('rejects invalid quantities before starting a lifecycle', async () => {
      // Arrange: the domain policy prohibits negative stock.
      const inventory = create();
      const execute = vi.fn(async () => 5);
      const before = inventory.snapshot();

      try {
        // Act: use the consumer workflow, not the raw runner.
        const pending = inventory.save({ sku: 'tea', value: -1 }, execute);

        // Assert: explicit validation does not create metadata or run transport.
        await expect(pending).rejects.toThrow('Quantity must be a non-negative integer.');
        expect(execute).not.toHaveBeenCalled();
        expect(inventory.snapshot()).toBe(before);
      } finally {
        await inventory.dispose();
      }
    });

    test('rejects duplicate writes before a second persistence call', async () => {
      // Arrange: a dispatched start owns the quantity field.
      const inventory = create();
      const execute = vi.fn(async () => 9);

      try {
        await Effect.runPromise(inventory.service.dispatch(inventory.write.actions.started({
          sku: 'tea', value: 5, requestId: 'owner',
        })));
        const before = inventory.snapshot();

        // Act: the consumer workflow checks the pending domain state.
        const result = inventory.save({ sku: 'tea', value: 9 }, execute);

        // Assert: a duplicate write does not replace the current intent.
        await expect(result).rejects.toThrow('Quantity is already saving for tea.');
        expect(execute).not.toHaveBeenCalled();
        expect(inventory.snapshot()).toBe(before);
      } finally {
        await inventory.dispose();
      }
    });

    test('rejects pending query metadata without a local execution', async () => {
      // Arrange: explicit request metadata already owns this key.
      const inventory = create();
      const variables = { sku: 'tea' };
      const fetcher = vi.fn(async () => Response.json({ data: {} }));

      try {
        await Effect.runPromise(inventory.service.dispatch(inventory.read.actions.started({
          variables,
          key: inventory.read.key(variables),
          scope: 'item',
          requestId: 'owner',
        })));

        // Act: run a duplicate query with the same variables.
        const result = Effect.runPromise(inventory.read.run({
          store: inventory.service,
          variables,
          fetcher,
        }));

        // Assert: nonexistent work cannot be shared or silently skipped.
        await expect(result).rejects.toThrow('Pending item request has no local execution.');
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await inventory.dispose();
      }
    });

    test('suppresses stale confirmation after a newer write owns the field', async () => {
      // Arrange: hand dispatches model a newer ownership claim.
      const inventory = create();

      try {
        await Effect.runPromise(inventory.service.dispatch(inventory.write.actions.started({
          sku: 'tea', value: 5, requestId: 'new',
        })));
        const before = inventory.snapshot();

        // Act: publish a completion from an older owner.
        await Effect.runPromise(inventory.service.dispatch(inventory.write.actions.confirmed({
          sku: 'tea', value: 3, result: 3, requestId: 'old',
        })));

        // Assert: the new intent and snapshot identity are retained.
        expect(inventory.snapshot()).toBe(before);
        expect(inventory.snapshot().items.tea?.quantity).toBe(5);
      } finally {
        await inventory.dispose();
      }
    });
  });
}
