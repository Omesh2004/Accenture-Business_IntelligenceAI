/**
 * Dashboard Redux slice.
 * Single source of truth for: selectedTenants, timeRange, deploymentMode.
 * Data fetching is handled entirely by React Query, not Redux.
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TimeRange, DeploymentMode, KPIMetric } from '@/types';

export interface DashboardState {
  timeRange: TimeRange;
  selectedTenants: string[];
  deploymentMode: DeploymentMode;
  sidebarCollapsed: boolean;
  realTimeUsers: number;
  realTimeUsersTimestampIST: string | null;
  kpiMetrics: KPIMetric[];
}

const initialState: DashboardState = {
  timeRange: 'Last 7 Days',
  selectedTenants: [],
  deploymentMode: 'cloud',
  sidebarCollapsed: false,
  realTimeUsers: 0,
  realTimeUsersTimestampIST: null,
  kpiMetrics: [],
};

const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState,
  reducers: {
    setTimeRange(state, action: PayloadAction<TimeRange>) {
      state.timeRange = action.payload;
    },
    setSelectedTenants(state, action: PayloadAction<string[] | string>) {
      if (Array.isArray(action.payload)) {
        state.selectedTenants = action.payload;
      } else {
        state.selectedTenants = [action.payload];
      }
    },
    setDeploymentMode(state, action: PayloadAction<DeploymentMode>) {
      state.deploymentMode = action.payload;
    },
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    updateRealTimeUsers(state, action: PayloadAction<number>) {
      state.realTimeUsers = action.payload;
      const now = new Date();
      state.realTimeUsersTimestampIST = now.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    },
    updateKPIMetrics(state, action: PayloadAction<KPIMetric[]>) {
      state.kpiMetrics = action.payload;
    },
  },
});

export const {
  setTimeRange,
  setSelectedTenants,
  setDeploymentMode,
  toggleSidebar,
  updateRealTimeUsers,
  updateKPIMetrics,
} = dashboardSlice.actions;

export default dashboardSlice.reducer;
