// src/ui/iroschat/components/IrosMetaBadge.tsx
// IrosMetaBadge — Iros が今どのモード／深度／Qコードで応答しているかを小さく表示するバッジ

'use client';

import React from 'react';

export type IrosMetaBadgeProps = {
  qCode?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  depth?: string | null; // 例: S3 / I1 / C2 など
  mode?:
    | 'light'
    | 'consult'
    | 'mirror'
    | 'resonate'
    | 'counsel'
    | 'structured'
    | 'diagnosis'
    | 'auto'
    | string
    | null;
  compact?: boolean; // ヘッダー右上用の小さな表示
};

/** Qコード → 色/意味 */
const Q_META: Record<
  NonNullable<IrosMetaBadgeProps['qCode']>,
  { label: string; color: string }
> = {
  Q1: { label: '秩序・我慢', color: '#64748b' }, // 金
  Q2: { label: '怒り・成長', color: '#16a34a' }, // 木
  Q3: { label: '不安・安定', color: '#f59e0b' }, // 土
  Q4: { label: '恐れ・浄化', color: '#0ea5e9' }, // 水
  Q5: { label: '空虚・情熱', color: '#ef4444' }, // 火
};

/** 深度（S/R/C/I/T）を読みやすいラベルに */
function depthToLabel(depth?: string | null): string {
  if (!depth) return '';
  const head = depth.charAt(0).toUpperCase();
  if (head === 'S') return `Self (${depth})`;
  if (head === 'R') return `Resonance (${depth})`;
  if (head === 'C') return `Creation (${depth})`;
  if (head === 'I') return `Intention (${depth})`;
  if (head === 'T') return `Transcend (${depth})`;
  return depth;
}

/** モード名称 */
function modeToLabel(mode?: IrosMetaBadgeProps['mode']): string {
  if (!mode) return '';
  const m = String(mode).toLowerCase();
  if (m === 'light') return 'Light（雑談）';
  if (m === 'consult' || m === 'counsel') return 'Consult（相談）';
  if (m === 'structured') return 'Structured（整理）';
  if (m === 'diagnosis') return 'Diagnosis（診断）';
  if (m === 'mirror') return 'Mirror（内面反射）';
  if (m === 'resonate') return 'Resonate（共鳴）';
  if (m === 'auto') return 'Auto（自動）';
  return String(mode);
}

export default function IrosMetaBadge(props: IrosMetaBadgeProps) {
  const { qCode, depth, mode, compact } = props;

  const qInfo = qCode ? Q_META[qCode] : null;
  const depthLabel = depthToLabel(depth);
  const modeLabel = modeToLabel(mode);

  const hasAny = qInfo || depthLabel || modeLabel;

  // 何も meta が無いとき
  if (!hasAny) {
    return (
      <div
        className="iros-meta-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: compact ? '2px 6px' : '4px 10px',
          borderRadius: 999,
          border: '1px solid rgba(148, 163, 184, 0.35)',
          background: 'linear-gradient(90deg, #f8fafc, #eef2ff)',
          fontSize: compact ? 10 : 11,
          color: '#64748b',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            width: compact ? 6 : 8,
            height: compact ? 6 : 8,
            borderRadius: '999px',
            background: '#cbd5f5',
          }}
        />
        <span style={{ opacity: 0.7 }}>Iros meta: -</span>
      </div>
    );
  }

  return (
    <div
      className="iros-meta-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 6 : 10,
        padding: compact ? '3px 8px' : '5px 12px',
        borderRadius: 999,
        border: '1px solid rgba(148, 163, 184, 0.45)',
        background: 'linear-gradient(90deg, #f9fafb, #e5edff)',
        fontSize: compact ? 10 : 11,
        color: '#475569',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
      }}
    >
      {/* Qコード */}
      {qInfo && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={qInfo.label}
        >
          <span
            style={{
              width: compact ? 8 : 10,
              height: compact ? 8 : 10,
              borderRadius: 999,
              background: qInfo.color,
              boxShadow: `0 0 0 2px rgba(148, 163, 184, 0.25)`,
            }}
          />
          <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>{qCode}</span>
        </div>
      )}

      {/* 区切り線 */}
      {qInfo && (depthLabel || modeLabel) && (
        <span
          aria-hidden="true"
          style={{
            width: 1,
            height: compact ? 16 : 18,
            background: 'rgba(148, 163, 184, 0.6)',
          }}
        />
      )}

      {/* 深度 */}
      {depthLabel && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={`Depth: ${depth}`}
        >
          <span
            style={{
              padding: compact ? '1px 4px' : '2px 6px',
              borderRadius: 999,
              background: 'rgba(129, 140, 248, 0.12)',
              fontWeight: 500,
            }}
          >
            {depth}
          </span>
          {!compact && (
            <span style={{ opacity: 0.7 }}>{depthLabel}</span>
          )}
        </div>
      )}

      {/* モード */}
      {modeLabel && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={`Mode: ${mode}`}
        >
          <span
            style={{
              padding: compact ? '1px 4px' : '2px 6px',
              borderRadius: 999,
              background: 'rgba(56, 189, 248, 0.12)',
              fontWeight: 500,
            }}
          >
            {String(mode).toUpperCase()}
          </span>
          {!compact && (
            <span style={{ opacity: 0.7 }}>{modeLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
