// src/ui/iroschat/components/IrosMetaBadge.tsx
// IrosMetaBadge — 右上は従来メタ、会話行は e_turn / 深度帯 / レーン表示に対応

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

  // ✅ 新UI用
  eTurn?: 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | string | null;
  responseType?: string | null; // lane / 応答タイプ表示用

  // ✅ 既存追加メタ
  laneKey?: string | null;
  flowDelta?: string | null;
  returnStreak?: number | null;
  slotPlanPolicy?: string | null;
  exprLane?: string | null;
  itTriggered?: boolean | null;

  compact?: boolean; // ヘッダー右上用の小さな表示
};

/** 右上用：Qコード → 色/意味 */
const Q_META: Record<
  NonNullable<IrosMetaBadgeProps['qCode']>,
  { label: string; color: string }
> = {
  Q1: { label: '秩序・我慢', color: '#64748b' },
  Q2: { label: '怒り・成長', color: '#16a34a' },
  Q3: { label: '不安・安定', color: '#f59e0b' },
  Q4: { label: '恐れ・浄化', color: '#0ea5e9' },
  Q5: { label: '空虚・情熱', color: '#ef4444' },
};

/** 左側メッセージ用：e_turn → 色 */
const E_TURN_META: Record<
  'e1' | 'e2' | 'e3' | 'e4' | 'e5',
  { color: string; label: string }
> = {
  e1: { color: '#3b82f6', label: 'e1' }, // 青
  e2: { color: '#22c55e', label: 'e2' }, // 緑
  e3: { color: '#eab308', label: 'e3' }, // 黄
  e4: { color: '#a855f7', label: 'e4' }, // 紫
  e5: { color: '#ef4444', label: 'e5' }, // 赤
};

function normStr(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

function normPolicy(v: unknown): string | null {
  const s = normStr(v);
  return s ? s.toUpperCase() : null;
}

function normalizeETurn(v: unknown): 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | null {
  const s = normStr(v)?.toLowerCase();
  if (s === 'e1' || s === 'e2' || s === 'e3' || s === 'e4' || s === 'e5') return s;
  return null;
}

/** 左側メッセージ用：深度は先頭文字だけ */
function depthToBand(depth?: string | null): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' | null {
  const s = normStr(depth)?.toUpperCase() ?? '';
  const head = s.charAt(0);
  if (head === 'S' || head === 'F' || head === 'R' || head === 'C' || head === 'I' || head === 'T') {
    return head;
  }
  return null;
}

/** 右上用：従来ラベル */
function depthToLabel(depth?: string | null): string {
  if (!depth) return '';
  const head = depth.charAt(0).toUpperCase();
  if (head === 'S') return `Self (${depth})`;
  if (head === 'F') return `Forming (${depth})`;
  if (head === 'R') return `Resonance (${depth})`;
  if (head === 'C') return `Creation (${depth})`;
  if (head === 'I') return `Intention (${depth})`;
  if (head === 'T') return `Transcend (${depth})`;
  return depth;
}

/** 右上用：従来モード名称 */
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

function shortDelta(delta?: string | null): string | null {
  const d = normStr(delta);
  if (!d) return null;
  const u = d.toUpperCase();
  if (u === 'RETURN') return 'RETURN';
  if (u === 'FORWARD') return 'FORWARD';
  return u.slice(0, 12);
}

function Sep({ compact }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 1,
        height: compact ? 16 : 18,
        background: 'rgba(148, 163, 184, 0.6)',
      }}
    />
  );
}

export default function IrosMetaBadge(props: IrosMetaBadgeProps) {
  const {
    qCode,
    depth,
    mode,
    eTurn,
    responseType,
    laneKey,
    flowDelta,
    returnStreak,
    slotPlanPolicy,
    exprLane,
    itTriggered,
    compact,
  } = props;

  const eTurnSafe = normalizeETurn(eTurn);
  const eInfo = eTurnSafe ? E_TURN_META[eTurnSafe] : null;
  const depthBand = depthToBand(depth);
  const responseTypeSafe = normStr(responseType);

  // ✅ 左側メッセージ用の新表示
  const shouldUseTurnStyle = Boolean(eInfo || depthBand || responseTypeSafe);

  if (shouldUseTurnStyle) {
    const hasAnyTurnStyle = Boolean(eInfo) || Boolean(depthBand) || Boolean(responseTypeSafe);

    if (!hasAnyTurnStyle) return null;

    return (
      <div
        className="iros-meta-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: compact ? 6 : 8,
          padding: compact ? '3px 8px' : '5px 10px',
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
        {eInfo && (
          <div
            title={`e_turn: ${eInfo.label}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                width: compact ? 8 : 10,
                height: compact ? 8 : 10,
                borderRadius: 999,
                background: eInfo.color,
                boxShadow: '0 0 0 2px rgba(148, 163, 184, 0.25)',
              }}
            />
            <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>{eInfo.label}</span>
          </div>
        )}

        {eInfo && (depthBand || responseTypeSafe) && <Sep compact={compact} />}

        {depthBand && (
          <div
            title={`depth band: ${depthBand}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span style={{ opacity: 0.72 }}>深度</span>
            <span style={{ fontWeight: 700 }}>{depthBand}</span>
          </div>
        )}

        {depthBand && responseTypeSafe && <Sep compact={compact} />}

        {responseTypeSafe && (
          <div
            title={`response type: ${responseTypeSafe}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span style={{ opacity: 0.72 }}>type</span>
            <span style={{ fontWeight: 600 }}>{responseTypeSafe}</span>
          </div>
        )}
      </div>
    );
  }

  // ✅ 右上用の従来表示
  const qInfo = qCode ? Q_META[qCode] : null;
  const depthLabel = depthToLabel(depth);
  const modeLabel = modeToLabel(mode);

  const laneKeySafe = normStr(laneKey);
  const deltaShort = shortDelta(flowDelta);
  const rsSafe =
    typeof returnStreak === 'number' && Number.isFinite(returnStreak) ? returnStreak : null;

  const policySafe = normPolicy(slotPlanPolicy);
  const exprSafe = normStr(exprLane);
  const itSafe = typeof itTriggered === 'boolean' ? itTriggered : null;

  const hasAny =
    Boolean(qInfo) ||
    Boolean(depthLabel) ||
    Boolean(modeLabel) ||
    Boolean(laneKeySafe) ||
    Boolean(deltaShort) ||
    rsSafe !== null ||
    Boolean(policySafe) ||
    Boolean(exprSafe) ||
    itSafe !== null;

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

  const hasMain = Boolean(qInfo) || Boolean(depthLabel) || Boolean(modeLabel);
  const hasExtra =
    Boolean(laneKeySafe) ||
    Boolean(deltaShort) ||
    rsSafe !== null ||
    Boolean(policySafe) ||
    Boolean(exprSafe) ||
    itSafe !== null;

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

      {qInfo && (depthLabel || modeLabel) && <Sep compact={compact} />}

      {depthLabel && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={depthLabel}
        >
          <span style={{ opacity: 0.72 }}>Depth</span>
          <span style={{ fontWeight: 600 }}>{depth}</span>
        </div>
      )}

      {depthLabel && modeLabel && <Sep compact={compact} />}

      {modeLabel && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={modeLabel}
        >
          <span style={{ opacity: 0.72 }}>Mode</span>
          <span style={{ fontWeight: 600 }}>{String(mode)}</span>
        </div>
      )}

      {hasMain && hasExtra && <Sep compact={compact} />}

      {laneKeySafe && (
        <span title={`laneKey: ${laneKeySafe}`} style={{ opacity: 0.88 }}>
          lane:{laneKeySafe}
        </span>
      )}

      {deltaShort && (
        <span title={`flowDelta: ${flowDelta ?? ''}`} style={{ opacity: 0.88 }}>
          flow:{deltaShort}
        </span>
      )}

      {rsSafe !== null && (
        <span title={`returnStreak: ${rsSafe}`} style={{ opacity: 0.88 }}>
          return:{rsSafe}
        </span>
      )}

      {policySafe && (
        <span title={`slotPlanPolicy: ${policySafe}`} style={{ opacity: 0.88 }}>
          {policySafe}
        </span>
      )}

      {exprSafe && (
        <span title={`exprLane: ${exprSafe}`} style={{ opacity: 0.88 }}>
          expr:{exprSafe}
        </span>
      )}

      {itSafe !== null && (
        <span title={`itTriggered: ${String(itSafe)}`} style={{ opacity: 0.88 }}>
          {itSafe ? 'IT:on' : 'IT:off'}
        </span>
      )}
    </div>
  );
}
