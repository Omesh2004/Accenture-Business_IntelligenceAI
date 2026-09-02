import React, { ReactNode } from 'react';
import DashboardLayoutClient from './DashboardLayoutClient';

export const metadata = {
  title: 'FinInsight | Analytics',
  description: 'Analytics Dashboard',
};

export default function MainLayout({ children }: { children: ReactNode }) {
  return <DashboardLayoutClient>{children}</DashboardLayoutClient>;
}
