import React, { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '@/lib/api';
import { UserData } from './UserContext';

interface FeatureToggles {
  [key: string]: boolean;
}

interface FeatureToggleContextType {
  toggles: FeatureToggles;
  loading: boolean;
  refreshToggles: () => Promise<void>;
}

const FeatureToggleContext = createContext<FeatureToggleContextType>({
  toggles: {},
  loading: true,
  refreshToggles: async () => {},
});

export const FeatureToggleProvider = ({ children }: { children: React.ReactNode }) => {
  const [toggles, setToggles] = useState<FeatureToggles>({});
  const [loading, setLoading] = useState(true);
  const { tenantId, isAuth } = UserData();

  const refreshToggles = async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    
    try {
      setLoading(true);
      const res = await axios.get(`${API_BASE_URL}/events/toggles/${tenantId}`);
      setToggles(res.data);
    } catch (error) {
      console.error("Failed to fetch feature toggles:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuth) {
      refreshToggles();
    }
  }, [tenantId, isAuth]);

  return (
    <FeatureToggleContext.Provider value={{ toggles, loading, refreshToggles }}>
      {children}
    </FeatureToggleContext.Provider>
  );
};

export const useFeatureToggles = () => useContext(FeatureToggleContext);
