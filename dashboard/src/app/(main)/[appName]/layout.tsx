import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SUPPORTED_APP_IDS, normalizeAppSlug } from '@/lib/feature-map';

export default async function AppScopedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ appName: string }>;
}) {
  const { appName: rawAppName } = await params;
  const appName = normalizeAppSlug(rawAppName);
  if (!SUPPORTED_APP_IDS.includes(appName)) {
    notFound();
  }

  return children;
}
