/** A server operation succeeded, but its local settlement did not complete reliably. */
export class PostCommitError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`Server operation ${operation} succeeded, but local settlement failed: ${detail}`);
    this.name = 'PostCommitError';
    this.operation = operation;
  }
}
