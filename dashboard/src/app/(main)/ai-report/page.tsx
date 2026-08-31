'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation, useIsMutating } from '@tanstack/react-query';
import { dashboardAPI } from '@/lib/api';
import { useDashboardData } from '@/hooks/useDashboard';
import { AIInsight } from '@/types';
import { Printer, Loader2, Sparkles, Clock3, TrendingUp, ShieldCheck, Timer, Lightbulb } from 'lucide-react';
import AIInsightsPanel from '@/components/AIInsightsPanel';
import { ChartSkeleton } from '@/components/Skeletons';

function simpleMarkdownToHtml(md: string) {
  const html = md
    .replace(/^### (.*$)/gim, '<h3 class="text-2xl font-bold mt-8 mb-3 text-slate-800 print:text-black">$1</h3>')
    .replace(/^## (.*$)/gim, '<h2 class="text-3xl font-bold mt-10 mb-4 border-b pb-2 text-slate-900 print:text-black">$1</h2>')
    .replace(/^# (.*$)/gim, '<h1 class="text-4xl font-extrabold mt-12 mb-6 text-slate-900 print:text-black">$1</h1>')
    .replace(/\*\*(.*)\*\*/gim, '<strong class="font-semibold text-slate-900 print:text-black">$1</strong>')
    .replace(/\*(.*)\*/gim, '<em class="italic text-slate-700 print:text-black">$1</em>')
    .replace(/^\* (.*$)/gim, '<li class="ml-6 list-disc mb-2 text-slate-700 print:text-black">$1</li>')
    .replace(/^- (.*$)/gim, '<li class="ml-6 list-disc mb-2 text-slate-700 print:text-black">$1</li>')
    .replace(/<mark>(.*?)<\/mark>/gim, '<mark class="bg-yellow-200 px-1 rounded text-yellow-900 font-semibold">$1</mark>')
    .replace(/\n\n/gim, '</p><p class="mt-5 mb-5 leading-relaxed text-lg text-slate-700 print:text-black">')
    .replace(/\n(?!(<li|<\/ul>|<ul|<h|<p|<\/p>|<div|<\/div>|<span|<\/span>|<hr|<table|<\/table>|<\/tbody>|<tbody>|<tr|<\/tr>|<td|<\/td>|<th|<\/th>|<mark|<\/mark>))/gim, '<br/>');
  return `<p class="mt-5 mb-5 leading-relaxed text-lg text-slate-700 print:text-black">${html}</p>`;
}

function buildHybridReportHtml(raw: string) {
  const dividerMatch = raw.match(/<hr[^>]*>/i);
  if (!dividerMatch || dividerMatch.index === undefined) {
    return simpleMarkdownToHtml(raw);
  }

  const splitAt = dividerMatch.index + dividerMatch[0].length;
  const visualHtml = raw.slice(0, splitAt);
  const markdownPart = raw.slice(splitAt).trim();

  return `${visualHtml}${simpleMarkdownToHtml(markdownPart)}`;
}

type FocusArea = {
  label: string;
  colorClass: string;
  keywords: string[];
};

const FOCUS_AREAS: FocusArea[] = [
  { label: 'Onboarding', colorClass: 'bg-[#1a73e8]', keywords: ['onboarding', 'signup', 'first session', 'new user'] },
  { label: 'Activation', colorClass: 'bg-[#4285F4]', keywords: ['activation', 'first value', 'adoption', 'discoverability'] },
  { label: 'Engagement', colorClass: 'bg-gray-400', keywords: ['engagement', 'session', 'feature usage', 'interaction'] },
  { label: 'Conversion', colorClass: 'bg-gray-500', keywords: ['conversion', 'drop-off', 'funnel', 'completion'] },
  { label: 'Retention', colorClass: 'bg-gray-600', keywords: ['retention', 'churn', 'stickiness', 'returning users'] },
  { label: 'Trust', colorClass: 'bg-[#8AB4F8]', keywords: ['trust', 'transparency', 'security', 'compliance'] },
];

type AIReportData = {
  report?: string;
  insights?: AIInsight[];
  generated_at?: string | null;
  cached?: boolean;
};

function countMatches(text: string, keywords: string[]) {
  const lower = text.toLowerCase();
  return keywords.reduce((acc, keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = lower.match(new RegExp(escaped, 'g'));
    return acc + (matches?.length || 0);
  }, 0);
}

function buildPotentialIdeas(topFocus: string[]) {
  const ideas: Record<string, string> = {
    Onboarding: 'Introduce a 2-step contextual onboarding checklist that adapts based on first-session behavior.',
    Activation: 'Surface intent-based nudges after key user pauses to accelerate first-value discovery.',
    Engagement: 'Launch a weekly value digest that highlights unused but high-impact features for each segment.',
    Conversion: 'Instrument stage-specific friction prompts and A/B test shorter completion paths for high-exit steps.',
    Retention: 'Create a proactive re-engagement journey triggered by early inactivity signals and feature gaps.',
    Trust: 'Add visible privacy and control affordances at critical decision points to reduce hesitation.',
  };

  const selected = topFocus.slice(0, 3).map((focus) => ideas[focus]).filter(Boolean);
  if (selected.length >= 3) return selected;

  return [
    ...selected,
    'Build a journey health score by cohort and auto-alert product owners when stage drop-offs spike.',
    'Prioritize microcopy and feedback improvements in high-friction flows to reduce cognitive load.',
    'Add lifecycle messaging tied to milestone completion to improve habit formation and weekly retention.',
  ].slice(0, 3);
}

function extractSectionTitles(md: string): string[] {
  return (md.match(/^##\s+.+$/gm) || [])
    .map((line) => line.replace(/^##\s+/, '').trim())
    .slice(0, 6);
}

function extractStrategicBullets(md: string): string[] {
  const lines = md.split('\n').map((line) => line.trim());
  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean);

  const unique: string[] = [];
  for (const bullet of bullets) {
    if (!unique.includes(bullet)) unique.push(bullet);
    if (unique.length >= 5) break;
  }

  if (unique.length > 0) return unique;

  return [
    'Address the top funnel drop-off with simplified flow and sharper guidance.',
    'Prioritize onboarding-to-activation improvements for faster first value.',
    'Strengthen trust signals near decision points to improve conversion confidence.',
  ];
}

export default function AIReportPage() {
  const { tenantsParam, selectedTenants, rangeParam, timeRange } = useDashboardData();
  const queryClient = useQueryClient();
  // Use React Query's global mutation tracking to survive unmounts
  const mutationKey = ['generateAIReport', tenantsParam, rangeParam];
  const activeMutations = useIsMutating({ mutationKey });
  const generating = activeMutations > 0;

  const { data = {} as AIReportData, isLoading: loading, refetch } = useQuery<AIReportData>({
    queryKey: ['aiReport', tenantsParam, rangeParam],
    queryFn: () => dashboardAPI.getLatestAIReport(tenantsParam, rangeParam),
  });

  const report = data.report || '';
  const insights = (data.insights || []) as AIInsight[];
  const generatedAt = data.generated_at || null;
  const cached = Boolean(data.cached);

  const generateMutation = useMutation({
    mutationKey,
    mutationFn: () => dashboardAPI.generateAIReport(tenantsParam, rangeParam),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(['aiReport', tenantsParam, rangeParam], snapshot);
    },
  });

  const handleGenerate = () => {
    if (!generating) {
      generateMutation.mutate();
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const reportText = report || '';
  const focusData = (() => {
    const raw = FOCUS_AREAS.map((area) => ({
      label: area.label,
      score: countMatches(reportText, area.keywords),
      colorClass: area.colorClass,
    }));
    const max = Math.max(...raw.map((item) => item.score), 1);
    return raw.map((item) => ({
      ...item,
      normalized: Math.max(8, Math.round((item.score / max) * 100)),
    }));
  })();

  const topFocus = focusData.slice().sort((a, b) => b.score - a.score).map((x) => x.label);

  const potentialIdeas = buildPotentialIdeas(topFocus);
  const reportSections = extractSectionTitles(reportText);
  const strategicBullets = extractStrategicBullets(reportText);
  const sectionCount = (reportText.match(/##\s/g) || []).length;
  const highlightCount = (reportText.match(/\*\*/g) || []).length / 2;
  const reportRichnessScore = Math.min(100, Math.round((Math.min(reportText.length, 5000) / 5000) * 70 + Math.min(sectionCount, 8) * 3 + Math.min(highlightCount, 8) * 2));

  return (
    <div className="flex-1 space-y-6 lg:p-4 print:p-0">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between print:hidden">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">AI Summary Report</h1>
          <p className="text-muted-foreground relative text-gray-500 max-w-3xl">
            The report is reused from the latest stored snapshot for {timeRange} until you explicitly generate a new one.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => refetch()}
            className="flex cursor-pointer items-center rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-100"
          >
            <Clock3 className="mr-2 h-4 w-4" />
            Load latest
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center cursor-pointer rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-60"
          >
            {generating ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Sparkles className="mr-2 h-5 w-5" />}
            Generate report
          </button>
          <button
            onClick={handlePrint}
            className="flex cursor-pointer items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-black"
          >
            <Printer className="mr-2 h-5 w-5" />
            Print / Save as PDF
          </button>
        </div>
      </div>

      <section className="rounded-2xl border-gray-200 border bg-white p-5 shadow-sm print:hidden">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Executive Snapshot</h3>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">Readiness Score</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{reportRichnessScore}/100</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">Sections Covered</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{sectionCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">Top Focus</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{topFocus[0] || 'N/A'}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">Critical Callouts</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{Math.round(highlightCount)}</p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <TrendingUp className="h-4 w-4 text-[#1a73e8]" />
              Focus Distribution
            </div>
            <div className="space-y-3">
              {focusData.map((item) => (
                <div key={item.label}>
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                    <span>{item.label}</span>
                    <span>{item.score}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className={`${item.colorClass} h-2 rounded-full transition-all duration-500`} style={{ width: `${item.normalized}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-500">
              <Lightbulb className="h-4 w-4 text-gray-500" /> Potential Product Ideas
            </h3>
            <div className="mt-3 space-y-2">
              {potentialIdeas.map((idea, index) => (
                <div key={idea} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Idea {index + 1}</p>
                  <p className="mt-1 text-sm text-slate-700">{idea}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Ideas are aligned to the report focus areas for stronger UX and retention outcomes.
            </p>
          </div>
        </div>
      </section>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm print:hidden">
        <AIInsightsPanel insights={insights} />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm print:border-0 print:shadow-none w-full min-h-[500px] p-10 print:p-0">
        <div className="mb-8 border-b border-slate-100 pb-5 print:hidden">
          <h2 className="text-2xl font-semibold leading-none tracking-tight">Detailed Analytics Summary</h2>
          <p className="text-sm text-gray-500 mt-2">Generated for {selectedTenants.join(', ').toUpperCase()}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1">
              {cached ? 'Last saved snapshot' : 'Freshly generated'}
            </span>
            {generatedAt && (
              <span className="rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1">
                {new Date(generatedAt).toLocaleString()}
              </span>
            )}
            <span className="rounded-full border border-[#1a73e8]/20 bg-[#1a73e8]/10 px-2.5 py-1 text-[#1a73e8]">
              <ShieldCheck className="mr-1 inline h-3 w-3" /> Product-grade report view
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
              <Timer className="mr-1 inline h-3 w-3" /> Strategy-ready insights
            </span>
          </div>
        </div>

        <div className="prose max-w-none prose-headings:font-semibold prose-a:text-blue-600 prose-p:text-gray-800 text-gray-800">
          {loading ? (
            <ChartSkeleton height="h-[520px]" />
          ) : report ? (
            <div className="space-y-6">
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 not-prose">
                <div className="flex flex-wrap items-center gap-2">
                  {reportSections.length > 0 ? (
                    reportSections.map((section, idx) => (
                      <span
                        key={idx}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
                      >
                        {section}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">Report sections will appear after generation.</span>
                  )}
                </div>
              </section>

              <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 not-prose">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm border-t-4 border-t-[#1a73e8]">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Key Takeaways</h4>
                  <ul className="mt-3 space-y-2 text-sm text-gray-800">
                    {strategicBullets.slice(0, 3).map((item, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#1a73e8]" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm border-t-4 border-t-[#1a73e8]">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-gray-700">Next 7-Day Action Plan</h4>
                  <ul className="mt-3 space-y-2 text-sm text-gray-800">
                    <li className="flex items-start gap-2"><span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#4285F4]" />Prioritize the single highest-friction funnel stage.</li>
                    <li className="flex items-start gap-2"><span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#4285F4]" />Ship one onboarding clarity improvement for first-session users.</li>
                    <li className="flex items-start gap-2"><span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#4285F4]" />Track cohort retention impact and compare week-over-week.</li>
                  </ul>
                </div>
              </section>

              <div className="space-y-2" dangerouslySetInnerHTML={{ __html: buildHybridReportHtml(report) }} />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-100 p-10 text-center">
              <h3 className="text-lg font-semibold text-gray-900">No report snapshot found</h3>
              <p className="mt-2 text-sm text-gray-500">
                Generate a report to store the current snapshot and reuse it across the dashboard.
              </p>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="mt-4 inline-flex cursor-pointer items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-60"
              >
                {generating ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Sparkles className="mr-2 h-5 w-5" />}
                Generate report
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="hidden print:block mb-10 border-b-2 border-slate-900 pb-6">
        <h1 className="text-5xl font-black text-black tracking-tight">NexaBank Analytics</h1>
        <h2 className="text-2xl mt-4 font-semibold text-slate-700">Strategic Critical Analysis & Insights</h2>
        <p className="mt-2 text-base text-slate-600 font-medium">Target Tenant: {selectedTenants.join(', ').toUpperCase()}</p>
        <p className="text-base text-slate-600 font-medium">Generated on: {new Date().toLocaleDateString()}</p>
      </div>
    </div>
  );
}
