import {
  combineReducers,
  configureStore,
  createAsyncThunk,
  createSlice,
} from '@reduxjs/toolkit';
import { Effect } from 'effect';
import { createEffectMiddleware } from './effectMiddleware';

const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    incremented(state) {
      state.value += 1;
    },
  },
});

const rootReducer = combineReducers({
  counter: counterSlice.reducer,
});

export const counterActions = counterSlice.actions;
export type RootState = ReturnType<typeof rootReducer>;

const effectMiddleware = createEffectMiddleware<RootState>();

const makeAppStore = () =>
  configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(effectMiddleware),
  });

export type AppStore = ReturnType<typeof makeAppStore>;
export type AppDispatch = AppStore['dispatch'];

export function createAppStore(): AppStore {
  return makeAppStore();
}

export const incrementAsync = createAsyncThunk<void, void>(
  'counter/incrementAsync',
  async (_, { dispatch }) => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 250);
    });
    dispatch(counterActions.incremented());
  },
);

export const persistCountEffect = (count: number) =>
  Effect.sync(() => {
    window.localStorage.setItem('redux-first:count', String(count));
  });
