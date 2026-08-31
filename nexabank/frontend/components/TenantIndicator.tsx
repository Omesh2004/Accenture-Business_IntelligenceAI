"use client";

import { UserData } from "@/components/context/UserContext";
import { Badge } from "@/components/ui/badge";

export const TenantIndicator = () => {
  const { tenantId, role } = UserData();

  if (!tenantId) return null;

  const getBankName = () => {
    if (tenantId === 'bank_a') return 'NexaBank';
    if (tenantId === 'bank_b') return 'SafeX Bank';
    return 'Demo Bank';
  };

  const getBankColor = () => {
    if (tenantId === 'bank_a') return 'bg-violet-100 text-violet-700 border-violet-200';
    if (tenantId === 'bank_b') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    return 'bg-blue-100 text-blue-700 border-blue-200';
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className={`${getBankColor()} flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full`}>
        {getBankName()}
      </Badge>
    </div>
  );
};
