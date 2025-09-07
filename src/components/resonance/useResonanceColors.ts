'use client';
import { useEffect, useMemo } from 'react';
import { useResonance } from '@/state/resonance/ResonanceContext';
import { mapQToColor } from '@/lib/sofia/qcolor';

export function useResonanceColors() {
  const { state } = useResonance();
  const primary = useMemo(() => mapQToColor(state.currentQ ?? ''), [state.currentQ]);
  const secondary = useMemo(() => mapQToColor(state.nextQ ?? '') ?? primary, [state.nextQ, primary]);

  useEffect(() => {
    const root = document.documentElement;
    const p = primary?.hex ?? '#6b7280';   // fallback gray
    const s = secondary?.hex ?? p;
    root.style.setProperty('--reso-color-primary', p);
    root.style.setProperty('--reso-color-secondary', s);
    // phase に応じた“流れ方向”（Inner:内向き / Outer:外向き）
    root.style.setProperty('--reso-flow-angle', state.phase === 'Outer' ? '35deg' : '215deg');
  }, [primary, secondary, state.phase]);

  return { primary, secondary, phase: state.phase, depth: state.depthStage };
}
