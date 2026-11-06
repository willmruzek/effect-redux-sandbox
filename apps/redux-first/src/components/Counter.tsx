import { Effect } from 'effect';
import { useAppDispatch, useAppSelector } from '../hooks';
import {
  counterActions,
  incrementAsync,
  persistCountEffect,
} from '../store';

export function Counter() {
  const count = useAppSelector((state) => state.counter.value);
  const dispatch = useAppDispatch();

  return (
    <main>
      <h1>Redux First</h1>
      <p>Count: {count}</p>
      <button onClick={() => dispatch(counterActions.incremented())}>
        Increment
      </button>
      <button onClick={() => void dispatch(incrementAsync())}>
        Increment with Thunk
      </button>
      <button
        onClick={() => {
          void dispatch(persistCountEffect(count)).catch((error: unknown) => {
            console.error('Could not persist the counter value.', error);
          });
        }}
      >
        Persist count with Effect
      </button>
      <button
        onClick={() => {
          void dispatch(
            Effect.sync(() => {
              document.title = `Redux First: ${count}`;
            }),
          ).catch((error: unknown) => {
            console.error('Could not update the document title.', error);
          });
        }}
      >
        Set title with Effect
      </button>
    </main>
  );
}
