// src/app/intention-prompt/FineTunePanel.tsx
'use client';

import React from 'react';
import type { FineTuneInput } from '@/lib/intentPrompt/schema';

type Props = {
  ft: FineTuneInput;
  onChange: <K extends keyof FineTuneInput>(key: K, value: FineTuneInput[K]) => void;
};

/* === 共通ラベル構造 === */
const Label: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <label style={labelWrap}>
    <div style={labelTitle}>{title}</div>
    {children}
  </label>
);

export default function FineTunePanel({ ft, onChange }: Props) {
  return (
    <section style={panel}>
      <h2 style={h2}>🎨 微調整パネル</h2>

      <Label title="基調トーン（baseTone）">
        <input
          style={input}
          value={ft.baseTone ?? ''}
          onChange={(e) => onChange('baseTone', e.target.value as FineTuneInput['baseTone'])}
          placeholder="例: deep ultramarine"
        />
      </Label>

      <Label title="明度（L%）">
        <input
          style={input}
          type="number"
          value={ft.baseLPercent ?? ''}
          onChange={(e) =>
            onChange('baseLPercent', Number(e.target.value) || undefined)
          }
          min={0}
          max={100}
        />
      </Label>

      <Label title="質感（texture）">
        <input
          style={input}
          value={ft.texture ?? ''}
          onChange={(e) => onChange('texture', e.target.value as FineTuneInput['texture'])}
          placeholder="例: soft grain / oil pastel"
        />
      </Label>

      <Label title="光層の透過（sheetGlow%）">
        <input
          style={input}
          type="number"
          value={ft.sheetGlowPercent ?? ''}
          onChange={(e) =>
            onChange('sheetGlowPercent', Number(e.target.value) || undefined)
          }
          min={0}
          max={100}
        />
      </Label>

      <Label title="流れのモチーフ（flowMotif）">
        <input
          style={input}
          value={ft.flowMotif ?? ''}
          onChange={(e) => onChange('flowMotif', e.target.value as FineTuneInput['flowMotif'])}
          placeholder="例: converging streams / gentle arcs"
        />
      </Label>

      <Label title="障害パターン（obstaclePattern）">
        <input
          style={input}
          value={ft.obstaclePattern ?? ''}
          onChange={(e) => onChange('obstaclePattern', e.target.value as FineTuneInput['obstaclePattern'])}
          placeholder="例: turbulence / noise"
        />
      </Label>

      <Label title="ハイライト・クリップ閾値（%）">
        <input
          style={input}
          type="number"
          value={ft.highlightClipPercent ?? ''}
          onChange={(e) =>
            onChange('highlightClipPercent', Number(e.target.value) || undefined)
          }
          min={0}
          max={100}
        />
      </Label>

      <Label title="追加ノート（addNotes）">
        <textarea
          style={textarea}
          rows={2}
          value={(ft.addNotes || []).join(', ')}
          onChange={(e) =>
            onChange(
              'addNotes',
              e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean)
            )
          }
          placeholder="例: light spark, transparency, harmony"
        />
      </Label>
    </section>
  );
}

/* ===== スタイル群 ===== */
const panel: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 10,
  padding: 20,
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const h2: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  marginBottom: 4,
};

const labelWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const labelTitle: React.CSSProperties = {
  fontSize: 13,
  color: '#555',
};

const input: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 14,
  lineHeight: 1.5,
};

const textarea: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 14,
  lineHeight: 1.6,
  resize: 'vertical',
};
