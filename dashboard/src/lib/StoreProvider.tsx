'use client';

/**
 * Redux Provider + PersistGate wrapper for Next.js App Router.
 * PersistGate delays rendering children until persisted state is rehydrated,
 * preventing the flash of default state (e.g. resetting "30d" back to "7d").
 */

import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from '@/lib/store';
import { ReactNode } from 'react';

interface StoreProviderProps {
  children: ReactNode;
}

export default function StoreProvider({ children }: StoreProviderProps) {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        {children}
      </PersistGate>
    </Provider>
  );
}
