import { redirect } from 'next/navigation';

export default async function AppScopedIndex({ params }: { params: Promise<{ appName: string }> }) {
  const { appName } = await params;
  redirect(`/${appName}/dashboard`);
}
