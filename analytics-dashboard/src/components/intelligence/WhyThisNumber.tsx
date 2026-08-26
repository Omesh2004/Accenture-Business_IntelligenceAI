'use client';

/**
 * WhyThisNumber — Intelligence Layer shared primitive #6.
 * Popover: click any figure → see the signal-store record it was verified against.
 * Implements the core guarantee: "no number is invented."
 */

import React, { memo, useState, useRef, useEffect } from 'react';
import { Info, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import type { NarrativeFigure } from '@/types';

interface WhyThisNumberProps {
  /** The figure to explain */
  figure: NarrativeFigure;
  /** The displayed value (rendered inline) */
  children: React.ReactNode;
}

function WhyThisNumber({ figure, children }: WhyThisNumberProps) {
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  return (
    <span className="relative inline-flex items-center">
      <span
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`cursor-pointer border-b border-dashed transition-colors ${
          figure.verified
            ? 'border-blue-300 hover:border-blue-500 text-inherit'
            : 'border-amber-300 hover:border-amber-500 text-amber-700'
        }`}
        title="Click to see source"
        role="button"
        aria-expanded={isOpen}
      >
        {children}
      </span>

      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-72 animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info className="w-3.5 h-3.5 text-[#1a73e8]" />
                <span className="text-xs font-semibold text-gray-700">Why this number</span>
              </div>
              {figure.verified ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded-full border border-teal-200">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-200">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  Unverified
                </span>
              )}
            </div>

            {/* Body */}
            <div className="px-4 py-3 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Value</span>
                <span className="font-medium text-gray-900 tabular-nums">{figure.value}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Label</span>
                <span className="font-medium text-gray-700">{figure.label}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Source table</span>
                <span className="font-mono text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                  {figure.signal_store_table}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Record ref</span>
                <span className="font-mono text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded truncate max-w-[140px]">
                  {figure.signal_store_ref}
                </span>
              </div>
              {figure.qualifier && (
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Qualifier</span>
                  <span className="font-medium text-amber-600 italic">{figure.qualifier}</span>
                </div>
              )}
            </div>

            {/* Footer link */}
            <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
              <span className="text-[10px] text-gray-400 flex items-center gap-1">
                <ExternalLink className="w-2.5 h-2.5" />
                Trace to {figure.signal_store_table}.{figure.signal_store_ref}
              </span>
            </div>
          </div>
          {/* Arrow */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="w-3 h-3 bg-white border-r border-b border-gray-200 transform rotate-45 -translate-y-1.5" />
          </div>
        </div>
      )}
    </span>
  );
}

export default memo(WhyThisNumber);
