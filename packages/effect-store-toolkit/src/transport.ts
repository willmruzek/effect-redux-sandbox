export type TransportReceipt =
  | {
    readonly status: 'received';
    readonly read: () => Promise<unknown>;
  }
  | {
    readonly status: 'failed';
    readonly error: Error;
    readonly serverMayHaveCommitted: boolean;
  };
