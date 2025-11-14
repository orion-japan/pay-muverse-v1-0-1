'use client';

import React from 'react';
import type { FineTuneInput } from './useIntentionPrompt';

type Props = {
  ft: FineTuneInput;
  onChange: <K extends keyof FineTuneInput>(key: K, value: FineTuneInput[K]) => void;
};

export default function FineTunePanel({ ft, onChange }: Props) {
  const update =
    (key: keyof FineTuneInput) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const v =
        e.target.type === 'number' ? Number(e.target.value) : (e.target.value as any);
      onChange(key as any, v);
    };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 20, fontWeight: 'bold' }}>Fine Tune</h2>

      <label>
        baseTone
        <input value={ft.baseTone} onChange={update('baseTone')} />
      </label>

      <label>
        Lightness（L%）
        <input
          type="number"
          value={ft.baseLPercent}
          onChange={update('baseLPercent')}
        />
      </label>

      <label>
        Texture
        <input value={ft.texture} onChange={update('texture')} />
      </label>

      <label>
        highlightClipPercent
        <input
          type="number"
          value={ft.highlightClipPercent}
          onChange={update('highlightClipPercent')}
        />
      </label>

      <label>
        Flow motif
        <input value={ft.flowMotif} onChange={update('flowMotif')} />
      </label>

      <label>
        Turbulence
        <input value={ft.obstaclePattern} onChange={update('obstaclePattern')} />
      </label>

      <label>
        addNotes（カンマ区切り）
        <input
          value={ft.addNotes.join(',')}
          onChange={(e) =>
            onChange('addNotes', e.target.value.split(',').map((t) => t.trim()))
          }
        />
      </label>
    </div>
  );
}
