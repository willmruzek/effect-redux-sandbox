/** Reject a page that claims another page without advancing its cursor. */
export function validateCursorPage<Cursor>(input: Readonly<{
  after: Cursor | null;
  endCursor: Cursor | null;
  hasNextPage: boolean;
}>): void {
  if (input.hasNextPage && (input.endCursor === null || Object.is(input.endCursor, input.after)))
    throw new Error('A page with more results must provide a new cursor.');
}
