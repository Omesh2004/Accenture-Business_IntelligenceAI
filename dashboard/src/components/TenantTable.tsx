'use client';

/**
 * Tenant Comparison table component.
 * Displays multi-tenant metrics in a clean table format with real data bars.
 * Shows feature usage, errors, adoption rate, unique users, and active features.
 */

import React, { memo } from 'react';
import ChartContainer from './ChartContainer';
import { Tenant } from '@/types';

interface TenantTableProps {
  data: Tenant[];
}

function TenantTable({ data }: TenantTableProps) {
  if (data.length === 0) {
    return (
      <ChartContainer title="Multi-Tenant Comparison" id="tenant-comparison-table" className="col-span-full">
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <p className="text-sm">No tenant data available.</p>
          <p className="text-xs mt-1 text-gray-300">Tenant data is populated from real ClickHouse analytics.</p>
        </div>
      </ChartContainer>
    );
  }

  // Find max values for relative bar widths
  const maxUsage = Math.max(...data.map((t) => t.featureUsage || 0), 1);

  return (
    <ChartContainer title="Multi-Tenant Comparison" id="tenant-comparison-table" className="col-span-full">
      <div className="overflow-x-auto mt-2">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider pb-3 pr-4">
                Tenant
              </th>
              <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider pb-3 pr-4 w-64">
                Total Events
              </th>
              <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider pb-3 pr-4">
                Errors
              </th>
              <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider pb-3 pr-4">
                Adoption
              </th>
              <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider pb-3">
                Plan
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((tenant) => {
              const barWidth = Math.round((tenant.featureUsage / maxUsage) * 100);
              return (
                <tr
                  key={tenant.id}
                  className="border-b border-gray-50 last:border-0 hover:bg-blue-50/30 transition-colors group"
                >
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[#1a73e8]/10 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-bold text-[#1a73e8]">
                          {tenant.name?.charAt(0)?.toUpperCase() || 'T'}
                        </span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-900 group-hover:text-[#1a73e8] transition-colors">
                          {tenant.name}
                        </p>
                        <p className="text-[11px] text-gray-400">{tenant.id}</p>
                      </div>
                    </div>
                  </td>

                  {/* Feature Usage Bar */}
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#1a73e8] rounded-full transition-all duration-700"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-gray-600 min-w-[60px] text-right">
                        {tenant.featureUsage?.toLocaleString() || 0}
                      </span>
                    </div>
                  </td>

                  {/* Errors */}
                  <td className="py-4 pr-4 text-center">
                    <span className={`text-sm font-semibold ${tenant.errors > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {tenant.errors?.toLocaleString() || 0}
                    </span>
                  </td>

                  {/* Adoption Rate */}
                  <td className="py-4 pr-4 text-center">
                    <span className="text-sm font-bold text-gray-900">
                      {tenant.adoptionRate}%
                    </span>
                  </td>

                  {/* Plan */}
                  <td className="py-4 text-center">
                    <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-white text-gray-600 border border-gray-300">
                      {tenant.plan || 'enterprise'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartContainer>
  );
}

export default memo(TenantTable);
