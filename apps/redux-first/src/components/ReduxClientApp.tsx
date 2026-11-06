import { useState } from 'react';
import { Provider } from 'react-redux';
import { createAppStore } from '../store';
import { Counter } from './Counter';

export function ReduxClientApp() {
  const [store] = useState(createAppStore);

  return (
    <Provider store={store}>
      <Counter />
    </Provider>
  );
}
