'use client';
import React, { useMemo } from 'react';
import { useResonance } from '@/state/resonance/ResonanceContext';
import { useResonanceColors } from './useResonanceColors';

export default function ResonanceFieldBar() {
  const { state } = useResonance();
  const { primary, secondary, phase } = useResonanceColors();

  // 深度でアニメ速さを変える（浅い=ゆっくり / 深い=静止に近い）
  const dur = useMemo(() => {
    const m: Record<string, number> = { S1:14,S2:16,S3:18,S4:20, R1:12,R2:11,R3:10, C1:10,C2:9,C3:8, I1:7,I2:6,I3:5, T1:8,T2:7,T3:6 };
    return (state.depthStage && m[state.depthStage]) ? m[state.depthStage] : 12;
  }, [state.depthStage]);

  return (
    <div className="reso-field">
      <div className="reso-flow" />
      <div className="reso-overlay">
        <div className="reso-meta">
          <b>Field</b>
          <span>phase: {phase ?? '-'}</span>
          <span>depth: {state.depthStage ?? '-'}</span>
          <span>Q:{state.currentQ ?? '-'} → {state.nextQ ?? '-'}</span>
        </div>
      </div>
      <style jsx>{`
        .reso-field{
          position:relative; width:100%; height:18px; border-radius:999px; overflow:hidden;
          border:1px solid rgba(255,255,255,.12);
          background: linear-gradient(var(--reso-flow-angle, 215deg),
                     ${primary?.hex ?? '#6b7280'} 0%,
                     ${secondary?.hex ?? '#9ca3af'} 100%);
          box-shadow: inset 0 0 20px rgba(0,0,0,.35), 0 8px 30px rgba(0,0,0,.25);
        }
        .reso-flow{
          position:absolute; inset:-2px; pointer-events:none;
          background: repeating-linear-gradient(
            var(--reso-flow-angle, 215deg),
            rgba(255,255,255,.18) 0px,
            rgba(255,255,255,.18) 12px,
            rgba(255,255,255,0)   12px,
            rgba(255,255,255,0)   28px
          );
          animation: shift ${dur}s linear infinite;
          mix-blend-mode: soft-light;
        }
        .reso-overlay{
          position:absolute; inset:0; display:flex; align-items:center; justify-content:flex-end;
          padding:0 10px; color:#e5e7eb; font-size:11px; letter-spacing:.2px;
          text-shadow: 0 1px 0 rgba(0,0,0,.4);
        }
        .reso-meta{ display:flex; gap:10px; opacity:.85; }
        @keyframes shift {
          from { background-position: 0 0; }
          to   { background-position: 260px 0; }
        }
      `}</style>
    </div>
  );
}
