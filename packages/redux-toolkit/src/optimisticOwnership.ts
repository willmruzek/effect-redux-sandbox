export type OptimisticTarget = {
  readonly table: string;
  readonly id: string;
  readonly incarnation: string;
  readonly field: string;
};

type ClaimResult =
  | { readonly status: 'claimed' }
  | { readonly status: 'conflict' }
  | { readonly status: 'invalid'; readonly error: string };

function targetKey(target: OptimisticTarget): string {
  return JSON.stringify([target.table, target.id, target.incarnation, target.field]);
}

export function createOptimisticOwnership() {
  const owners = new Map<string, string>();
  const claims = new Map<string, readonly string[]>();

  return {
    claim(input: {
      readonly requestId: string;
      readonly targets: readonly OptimisticTarget[];
    }): ClaimResult {
      const keys = input.targets.map(targetKey);

      if (new Set(keys).size !== keys.length)
        return { status: 'invalid', error: 'Duplicate optimistic target.' };

      if (claims.has(input.requestId))
        return { status: 'invalid', error: 'Duplicate optimistic request.' };

      if (keys.some((key) => owners.has(key)))
        return { status: 'conflict' };

      for (const key of keys)
        owners.set(key, input.requestId);

      claims.set(input.requestId, keys);
      return { status: 'claimed' };
    },

    owns(requestId: string, target: OptimisticTarget): boolean {
      return owners.get(targetKey(target)) === requestId;
    },

    release(requestId: string): void {
      const keys = claims.get(requestId);

      if (!keys)
        return;

      for (const key of keys) {
        if (owners.get(key) === requestId)
          owners.delete(key);
      }

      claims.delete(requestId);
    },
  };
}
