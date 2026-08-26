"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboard';
import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';
import { Search, User, Clock, AlertCircle } from 'lucide-react';
import ChartContainer from '@/components/ChartContainer';
import { TableSkeleton, ChartSkeleton } from '@/components/Skeletons';
import type { JourneyEvent } from '@/types';

export default function UserJourneyPage() {
  const { tenantsParam, rangeParam, selectedTenants, timeRange } = useDashboardData();
  const [selectedUser, setSelectedUser] = useState<string>('');
  const { lastEvent } = useRealtimeEvents({ maxEvents: 1 });
  const lastRealtimeRefetchAt = useRef(0);

  const { data: usersData, isLoading: loadingUsers, refetch: refetchUsers } = useQuery({
    queryKey: ['journeyUsers', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getJourneyUsers(tenantsParam, rangeParam),
    staleTime: 15 * 1000,
    refetchInterval: 15 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const { data: journeyData, isLoading: loadingJourney, refetch: refetchJourney } = useQuery({
    queryKey: ['userJourney', tenantsParam, selectedUser, rangeParam],
    queryFn: () => dashboardAPI.getUserJourney(tenantsParam, selectedUser, rangeParam),
    enabled: !!selectedUser,
    staleTime: 15 * 1000,
    refetchInterval: 15 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setSelectedUser('');
  }, [tenantsParam, rangeParam]);

  // Real-time refetch trigger with 4-second throttle
  useEffect(() => {
    if (!lastEvent) return;
    const now = Date.now();
    if (now - lastRealtimeRefetchAt.current < 4000) return;
    lastRealtimeRefetchAt.current = now;
    void refetchUsers();
    if (selectedUser) void refetchJourney();
  }, [lastEvent, refetchUsers, refetchJourney, selectedUser]);

  const users = usersData?.users || [];
  const journey = journeyData || null;

  const loadJourney = (userId: string) => {
    setSelectedUser(userId);
  };

  const channelColors: Record<string, string> = {
    web: 'border border-gray-200 bg-white text-gray-700',
    mobile: 'border border-gray-200 bg-white text-gray-700',
    api: 'border border-gray-200 bg-white text-gray-700',
    batch: 'border border-gray-200 bg-white text-gray-700',
  };

  return (
    <div className="animate-in fade-in duration-500 space-y-6">
      <div>
        <h1 className="text-[22px] font-medium text-gray-900 tracking-tight">User Journey Mapping</h1>
        <p className="text-sm text-gray-500 mt-1">Track individual user flows, session breaks, and drop-off points for <strong className="text-gray-700">{selectedTenants.join(', ')}</strong> in <strong className="text-gray-700">{timeRange}</strong>.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* User List */}
        <div className="lg:col-span-1">
          <ChartContainer title="Select User" id="user-list">
            <div className="mt-2 space-y-2 max-h-[600px] overflow-y-auto">
              {loadingUsers ? (
                <TableSkeleton rows={8} />
              ) : users.length === 0 ? (
                <p className="text-center text-gray-400 py-8">No users found.</p>
              ) : (
                users.map((u: any) => (
                  <button
                    key={u.user_id}
                    onClick={() => loadJourney(u.user_id)}
                    className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${selectedUser === u.user_id
                        ? 'border-blue-500 bg-blue-50 shadow-sm'
                        : 'border-gray-100 hover:border-gray-200 hover:bg-gray-100'
                      }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <User className="h-4 w-4 text-gray-400" />
                      <span className="text-sm font-medium text-gray-900 truncate">{u.user_id}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{u.event_count} events</span>
                      <span>Last: {u.last_seen}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ChartContainer>
        </div>

        {/* Timeline */}
        <div className="lg:col-span-2">
          <ChartContainer title={selectedUser ? `Journey: ${selectedUser}` : 'Select a user'} id="journey-timeline">
            {!selectedUser ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <Search className="h-12 w-12 mb-3" />
                <p className="text-sm">Select a user from the left to view their journey.</p>
              </div>
            ) : loadingJourney ? (
              <ChartSkeleton height="h-[500px]" />
            ) : (
              <div className="mt-4">
                {/* Stats */}
                <div className="flex gap-4 mb-6">
                  <div className="px-4 py-2 border border-[#1a73e8] bg-[#1a73e8]/5 rounded-lg text-sm">
                    <span className="text-gray-500">Events:</span> <span className="font-bold text-[#1a73e8]">{journey?.total_events}</span>
                  </div>
                  <div className="px-4 py-2 border border-[#1a73e8] bg-[#1a73e8]/5 rounded-lg text-sm">
                    <span className="text-gray-500">Sessions:</span> <span className="font-bold text-[#1a73e8]">{journey?.total_sessions}</span>
                  </div>
                  <div className="px-4 py-2 border border-blue-200 bg-white rounded-lg text-sm">
                    <span className="text-gray-500">Last Event:</span> <span className="font-bold text-gray-700">{journey?.last_event || 'N/A'}</span>
                  </div>
                </div>

                {/* Vertical Timeline */}
                <div className="relative pl-6 border-l-2 border-gray-200 space-y-0">
                  {(journey?.sessions || []).map((session: JourneyEvent[], sIdx: number) => (
                    <div key={sIdx}>
                      {/* Session Header */}
                      <div className="relative mb-4 -ml-[25px] flex items-center gap-2">
                        <div className="w-4 h-4 bg-[#1a73e8] rounded-full border-2 border-white shadow z-10"></div>
                        <span className="text-xs font-bold text-[#1a73e8] uppercase tracking-wider bg-white border border-[#1a73e8]/30 px-2 py-0.5 rounded">Session {sIdx + 1}</span>
                      </div>

                      {session.map((evt: JourneyEvent, eIdx: number) => (
                        <div key={eIdx} className="relative mb-4 -ml-[25px] flex items-start gap-3">
                          <div className="w-3 h-3 mt-1.5 bg-white border-2 border-gray-300 rounded-full z-10 flex-shrink-0"></div>
                          <div className="flex-1 p-3 bg-white border border-gray-100 rounded-lg shadow-sm hover:shadow transition-shadow">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-semibold text-gray-900">{evt.event_name}</span>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${channelColors[evt.channel] || 'bg-gray-100 text-gray-600'}`}>
                                {evt.channel}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-gray-400">
                              <Clock className="h-3 w-3" />
                              <span>{evt.timestamp}</span>
                            </div>
                          </div>
                        </div>
                      ))}

                      {/* Session Break */}
                      {sIdx < (journey?.sessions || []).length - 1 && (
                        <div className="relative mb-4 -ml-[25px] flex items-center gap-2">
                          <div className="w-4 h-4 bg-gray-500 rounded-full border-2 border-white shadow z-10 flex items-center justify-center">
                            <AlertCircle className="h-3 w-3 text-white" />
                          </div>
                          <span className="text-xs font-medium text-gray-600 border border-gray-200 bg-white px-2 py-0.5 rounded">Session Break (30+ min gap)</span>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Drop-off */}
                  {journey?.last_event && (
                    <div className="relative -ml-[25px] flex items-center gap-2 mt-2">
                      <div className="w-4 h-4 bg-gray-400 rounded-full border-2 border-white shadow z-10"></div>
                      <span className="text-xs font-bold text-gray-600 bg-white border border-gray-200 px-2 py-0.5 rounded">
                        Drop-off → Last action: {journey.last_event}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </ChartContainer>
        </div>
      </div>
    </div>
  );
}
