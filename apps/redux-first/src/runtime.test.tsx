// @vitest-environment happy-dom

import {
  Effect,
  type ManagedRuntime
} from 'effect';
import {
  act,
  StrictMode
} from 'react';
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
  test,
  vi
} from 'vitest';

import { useDemoRuntime } from './runtime';

function Consumer({ capture }: Readonly<{
  capture: (runtime: ManagedRuntime.ManagedRuntime<never, never>) => void;
}>) {
  capture(useDemoRuntime());

  return <p>Runtime owner</p>;
}

describe('demo runtime ownership', () => {
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
    vi.restoreAllMocks();
  });

  test('survives Strict Mode replay and disposes on unmount', async () => {
    // Arrange: capture the application's runtime at the React boundary.
    let runtime: ManagedRuntime.ManagedRuntime<never, never> | undefined;

    await act(async () => root.render(
      <StrictMode><Consumer capture={(value) => {
        runtime = value;
      }} /></StrictMode>,
    ));

    if (!runtime)
      throw new Error('Runtime was not rendered.');

    const active = runtime;
    const dispose = vi.spyOn(active, 'dispose');

    await expect(active.runPromise(Effect.succeed(42))).resolves.toBe(42);

    // Act: remove the committed owner.
    await act(async () => root.render(null));

    // Assert: replay did not dispose the runtime, but real unmount did.
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(active.runPromise(Effect.succeed(42))).rejects.toThrow();
  });

  test('does not acquire runtime services during server rendering', async () => {
    // Arrange: SSR never executes a dispatched browser workflow.
    let runtime: ManagedRuntime.ManagedRuntime<never, never> | undefined;

    // Act: render a server-only owner.
    const html = renderToString(<Consumer capture={(value) => {
      runtime = value;
    }} />);

    // Assert: the application layer has not been initialized.
    expect(html).toBe('<p>Runtime owner</p>');

    if (!runtime)
      throw new Error('Runtime was not rendered.');

    expect(runtime.cachedContext).toBeUndefined();
    await runtime.dispose();
  });
});
