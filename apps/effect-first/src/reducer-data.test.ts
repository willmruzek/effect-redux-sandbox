import {
  describe,
  expect,
  test
} from 'vitest';

import { createTrackerApiState } from './api';
import {
  rootReducer,
  trackerActions
} from './reducer';

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
    const initial = createTrackerApiState();

    // Act: select a project through a plain action.
    const updated = rootReducer({ state: initial, action: trackerActions.projectSelected('atlas') });

    // Assert: both reducer outputs remain data-only.
    expectDataOnly(initial);
    expectDataOnly(updated);
    expect(updated.selectedProjectId).toBe('atlas');
  });
});
