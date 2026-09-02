/**
 * Dashboard page - Server component wrapper.
 * Renders the main analytics dashboard with all widgets.
 */

import DashboardContent from './DashboardContent';

export const metadata = {
  title: 'FinInsight Dashboard | Analytics Overview',
  description:
    'Enterprise analytics dashboard providing real-time insights into feature usage, user behavior, and tenant metrics.',
};

export default function DashboardPage() {
  return (
    <DashboardContent />
  );
}
