'use client';
import React from 'react';
import { useResonance } from '@/state/resonance/ResonanceContext';
import { useResonanceColors } from './useResonanceColors';

export default function ResonanceBadge() {
  const { state } = useResonance();
  const { primary, secondary } = useResonanceColors();

  return (
    <div className="reso-badge" title="Resonance Field">
      <div className="reso-ring" />
      <div className="reso-labels">
        <span>Q:{state.currentQ ?? '-'}</span>
        <span>→ {state.nextQ ?? '-'}</span>
        <span>{state.phase ?? '-'}</span>
        <span>{state.depthStage ?? '-'}</span>
      </div>
      <style jsx>{`
        .reso-badge{
          display:inline-flex; align-items:center; gap:10px;
          padding:10px 12px; border-radius:14px; border:1px solid rgba(255,255,255,.12);
          background: radial-gradient(circle at 30% 30%, ${primary?.hex ?? '#6b7280'} 0%, transparent 60%),
                      radial-gradient(circle at 70% 70%, ${secondary?.hex ?? '#9ca3af'} 0%, transparent 55%),
                      rgba(15,17,26,0.6);
          box-shadow: 0 6px 20px rgba(0,0,0,.25), inset 0 0 24px rgba(255,255,255,.04);
          color:#e5e7eb; font: 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", sans-serif;
        }
        .reso-ring{
          width:18px; height:18px; border-radius:50%;
          background: conic-gradient(from var(--reso-flow-angle, 215deg),
                      ${primary?.hex ?? '#6b7280'}, ${secondary?.hex ?? '#9ca3af'});
          box-shadow: 0 0 0 2px rgba(255,255,255,.08) inset, 0 0 10px ${primary?.hex ?? '#6b7280'};
        }
        .reso-labels{ display:flex; gap:8px; opacity:.9; }
        .reso-labels > span{ white-space:nowrap; }
      `}</style>
    </div>
  );
}
