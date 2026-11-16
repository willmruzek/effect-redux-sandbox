import {
  describe,
  expect,
  test
} from 'vitest';

import {
  trackerActions
} from './reducer';
import { createTrackerServices } from './trackerServices';

function expectDataOnly(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'function')
    throw new Error('Reducer state must not contain functions.');

  if (typeof value !== 'object' || value === null || seen.has(value))
    return;

  seen.add(value);

  for (const child of Object.values(value))
    expectDataOnly(child, seen);
}

describe('Effect reducer state', () => {
  test('contains only data after initialization and a plain action', () => {
    // Arrange: initialize app state with its data-only API metadata.
    const services = createTrackerServices();
    const initial = services.createInitialState();

    // Act: select a project through a plain action.
    const updated = services.reducer({
      state: initial,
      action: trackerActions.projectSelected('atlas'),
    });

    // Assert: both reducer outputs remain data-only.
    expectDataOnly(initial);
    expectDataOnly(updated);
    expect(updated.selectedProjectId).toBe('atlas');
  });
});
