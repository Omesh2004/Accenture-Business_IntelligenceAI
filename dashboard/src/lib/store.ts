/**
 * Redux store with redux-persist for localStorage persistence.
 * Persists stable dashboard preferences (timeRange, deploymentMode).
 * Tenant selection is intentionally not persisted to avoid cross-app bleed
 * when multiple bank dashboards are opened side-by-side.
 * Transient state (realTimeUsers, kpiMetrics) is handled via rehydration transforms.
 */

import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from 'redux-persist';
import createWebStorage from 'redux-persist/lib/storage/createWebStorage';
import dashboardReducer from './dashboardSlice';

/* ---------- storage (SSR-safe) ---------- */

function createNoopStorage() {
  return {
    getItem(_key: string) {
      return Promise.resolve(null);
    },
    setItem(_key: string, value: string) {
      return Promise.resolve(value);
    },
    removeItem(_key: string) {
      return Promise.resolve();
    },
  };
}

const storage =
  typeof window !== 'undefined'
    ? createWebStorage('local')
    : createNoopStorage();

/* ---------- persist config ---------- */

// Apply persistence directly to the dashboard reducer so whitelist
// targets the slice's own keys (timeRange, deploymentMode).
// Transient keys like realTimeUsers, kpiMetrics are excluded.
const dashboardPersistConfig = {
  key: 'nucleus-dashboard',
  storage,
  whitelist: ['timeRange', 'deploymentMode'],
};

const persistedDashboardReducer = persistReducer(dashboardPersistConfig, dashboardReducer);

/* ---------- store ---------- */

export const store = configureStore({
  reducer: {
    dashboard: persistedDashboardReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
  devTools: process.env.NODE_ENV !== 'production',
});

export const persistor = persistStore(store);

/* ---------- types + hooks ---------- */

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
