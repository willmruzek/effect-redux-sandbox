import { describe, expect, test } from 'vitest';

import { validateCursorPage } from './cursor.js';

describe('validateCursorPage', () => {
  test('accepts a new cursor when another page is reported', () => {
    // Arrange: the transport advances to a distinct cursor.
    const page = { after: 'old', endCursor: 'new', hasNextPage: true };

    // Act / Assert: the next page can be requested.
    expect(() => validateCursorPage(page)).not.toThrow();
  });

  test('accepts a final page without a cursor', () => {
    // Arrange: the transport reports an exhausted chain.
    const page = { after: 'old', endCursor: null, hasNextPage: false };

    // Act / Assert: no further cursor is necessary.
    expect(() => validateCursorPage(page)).not.toThrow();
  });

  test('rejects a missing cursor when another page is reported', () => {
    // Arrange: the transport reports more data but no way to reach it.
    const page = { after: 'old', endCursor: null, hasNextPage: true };

    // Act / Assert: invalid pagination is surfaced explicitly.
    expect(() => validateCursorPage(page)).toThrow('A page with more results must provide a new cursor.');
  });

  test('rejects a repeated cursor when another page is reported', () => {
    // Arrange: the transport repeats the cursor it was given.
    const page = { after: 'old', endCursor: 'old', hasNextPage: true };

    // Act / Assert: the chain cannot enter an infinite loop.
    expect(() => validateCursorPage(page)).toThrow('A page with more results must provide a new cursor.');
  });
});
