import {
  describe,
  expect,
  test
} from 'vitest';

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

describe('Redux reducer state', () => {
  test('contains only data after initialization and a plain action', () => {
    // Arrange: initialize the reducer with an ordinary Redux action.
    const initial = rootReducer(undefined, { type: '@@test/init' });

    // Act: select a project through a plain action.
    const updated = rootReducer(initial, trackerActions.projectSelected('atlas'));

    // Assert: both reducer outputs remain data-only.
    expectDataOnly(initial);
    expectDataOnly(updated);
    expect(updated.selectedProjectId).toBe('atlas');
  });
});
