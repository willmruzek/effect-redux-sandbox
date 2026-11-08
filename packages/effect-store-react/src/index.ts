import type { Store } from '@repo/effect-store';

import { useSyncExternalStore } from 'react';

/**
 * Subscribes to immutable snapshots. SSR callers must create a request-scoped
 * store from the same initial state that is serialized for browser hydration.
 */
export function useStoreSnapshot<State>(
  store: Pick<Store<State, unknown, unknown>, 'subscribe' | 'getSnapshot'>,
): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
