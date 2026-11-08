// @vitest-environment happy-dom

import { act } from 'react';
import {
  createRoot,
  type Root
} from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi
} from 'vitest';

import { useStoreSnapshot } from './index.js';

type State = { readonly message: string };

function createSnapshotSource(message: string) {
  let state: State = { message };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn((listener: () => void) => {
    listeners.delete(listener);
  });
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);

    return () => unsubscribe(listener);
  });

  return {
    subscribe,
    unsubscribe,

    getSnapshot: () => state,

    update: (message: string) => {
      state = { message };

      for (const listener of listeners)
        listener();
    },
  };
}

function Message({ store }: Readonly<{ store: ReturnType<typeof createSnapshotSource> }>) {
  const state = useStoreSnapshot(store);

  expectTypeOf(state).toEqualTypeOf<State>();

  return <p>{state.message}</p>;
}

describe('useStoreSnapshot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('renders the typed initial snapshot', async () => {
    // Arrange: provide a store with immutable state.
    const store = createSnapshotSource('Hello');

    // Act: render a consumer of the hook.
    await act(async () => root.render(<Message store={store} />));

    // Assert: the initial snapshot is available immediately.
    expect(container.textContent).toBe('Hello');
  });

  test('renders new snapshots without resubscribing', async () => {
    // Arrange: mount a subscribed consumer.
    const store = createSnapshotSource('Hello');

    await act(async () => root.render(<Message store={store} />));

    // Act: notify subscribers of an immutable update.
    await act(async () => store.update('Updated'));

    // Assert: the consumer updates using the existing subscription.
    expect(container.textContent).toBe('Updated');
    expect(store.subscribe).toHaveBeenCalledTimes(1);
  });

  test('unsubscribes when the consumer unmounts', async () => {
    // Arrange: mount a subscribed consumer.
    const store = createSnapshotSource('Hello');

    await act(async () => root.render(<Message store={store} />));

    // Act: remove the consumer.
    await act(async () => root.render(null));

    // Assert: the listener is removed exactly once.
    expect(store.unsubscribe).toHaveBeenCalledTimes(1);
    expect(store.unsubscribe).toHaveBeenCalledWith(expect.any(Function));
  });

  test('switches subscriptions when the store changes', async () => {
    // Arrange: mount the first of two independent stores.
    const first = createSnapshotSource('First');
    const second = createSnapshotSource('Second');

    await act(async () => root.render(<Message store={first} />));

    // Act: replace the consumer's store.
    await act(async () => root.render(<Message store={second} />));

    // Assert: the old listener is removed and the new snapshot is rendered.
    expect(container.textContent).toBe('Second');
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
  });

  test('renders its request-scoped snapshot on the server', () => {
    // Arrange: each SSR request owns an independent source.
    const store = createSnapshotSource('Server state');

    // Act: render without subscribing to the source.
    const html = renderToString(<Message store={store} />);

    // Assert: the server snapshot is available without a client-only boundary.
    expect(html).toBe('<p>Server state</p>');
    expect(store.subscribe).not.toHaveBeenCalled();
  });
});
