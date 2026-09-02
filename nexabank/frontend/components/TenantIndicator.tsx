"use client";

import { UserData } from "@/components/context/UserContext";
import { Badge } from "@/components/ui/badge";

export const TenantIndicator = () => {
  const { tenantId, role } = UserData();

  if (!tenantId) return null;

  const getBankName = () => (tenantId === 'bank_a' ? 'NexaBank' : 'Demo Bank');

  const getBankColor = () =>
    tenantId === 'bank_a'
      ? 'bg-violet-100 text-violet-700 border-violet-200'
      : 'bg-blue-100 text-blue-700 border-blue-200';

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className={`${getBankColor()} flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full`}>
        {getBankName()}
      </Badge>
    </div>
  );
};
