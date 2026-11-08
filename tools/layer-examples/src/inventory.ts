export type Item = {
  readonly sku: string;
  readonly label: string;
  readonly quantity: number;
};

export type QuantityInput = {
  readonly sku: string;
  readonly value: number;
};

// Structural domain metadata keeps these types independent of either toolkit.
export type InventoryState = {
  readonly items: Readonly<Record<string, Item>>;
  readonly writes: Readonly<Record<string,
    | { readonly status: 'saving'; readonly requestId: string; readonly original: number }
    | { readonly status: 'error'; readonly error: string }
  >>;
  readonly api: {
    readonly requests: Readonly<Record<string,
      | { readonly status: 'pending' | 'succeeded' | 'superseded'; readonly requestId: string }
      | { readonly status: 'failed' | 'cancelled'; readonly requestId: string; readonly error: string }
    >>;
    readonly latest: Readonly<Record<string, {
      readonly key: string;
      readonly requestId: string;
    }>>;
  };
};

export function initialInventory(): InventoryState {
  return {
    items: { tea: { sku: 'tea', label: 'Tea', quantity: 2 } },
    writes: {},
    api: { requests: {}, latest: {} },
  };
}

/** Transport data is unknown until it satisfies the consumer's domain contract. */
export function decodeItem(data: unknown, variables: { readonly sku: string }): Item {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('item' in data) ||
    typeof data.item !== 'object' ||
    data.item === null ||
    !('sku' in data.item) ||
    data.item.sku !== variables.sku ||
    !('label' in data.item) ||
    typeof data.item.label !== 'string' ||
    !('quantity' in data.item) ||
    typeof data.item.quantity !== 'number' ||
    !Number.isInteger(data.item.quantity) ||
    data.item.quantity < 0
  ) {
    throw new Error('Invalid inventory response.');
  }

  return {
    sku: variables.sku,
    label: data.item.label,
    quantity: data.item.quantity,
  };
}

export function quantityError(state: InventoryState, input: QuantityInput): string | undefined {
  if (!state.items[input.sku])
    return `Unknown item: ${input.sku}.`;

  if (!Number.isInteger(input.value) || input.value < 0)
    return 'Quantity must be a non-negative integer.';

  if (state.writes[input.sku]?.status === 'saving')
    return `Quantity is already saving for ${input.sku}.`;

  return undefined;
}
