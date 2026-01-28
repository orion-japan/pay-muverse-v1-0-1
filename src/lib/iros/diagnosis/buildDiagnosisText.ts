// src/lib/iros/diagnosis/buildDiagnosisText.ts
// iros — ir diagnosis OS (deterministic text builder)
//
// 目的：LLMなしで「診断文（確定文）」を生成する。
// - rephraseEngine / llmGate / renderGateway に依存しない
// - metaの揺れ（unified/intent_anchor 等）を吸収して “読む”
// - 出力はそのまま commit できる「本文」

import type { DiagnosisMetaLike, DiagnosisSlotLike } from './diagnosisTypes';

const norm = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();

  if (Array.isArray(v)) {
    return v
      .map((x) => norm(x))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (typeof v === 'object') {
    const t =
      (typeof (v as any).text === 'string' && (v as any).text) ||
      (typeof (v as any).content === 'string' && (v as any).content) ||
      (typeof (v as any).message === 'string' && (v as any).message) ||
      '';
    return String(t).replace(/\s+/g, ' ').trim();
  }

  return String(v).replace(/\s+/g, ' ').trim();
};

function pickMeta(meta: DiagnosisMetaLike) {
  const q = norm((meta as any)?.qPrimary ?? (meta as any)?.q_code ?? '');
  const depth = norm((meta as any)?.depthStage ?? (meta as any)?.depth_stage ?? '');
  const phase = norm((meta as any)?.phase ?? '');
  const layer = norm((meta as any)?.intentLayer ?? (meta as any)?.intent_layer ?? '');
  const anchor =
    norm((meta as any)?.intentAnchor ?? '') ||
    norm((meta as any)?.intent_anchor?.text ?? (meta as any)?.intent_anchor?.anchor_text ?? '');
  const itx = norm((meta as any)?.itxStep ?? (meta as any)?.itx_step ?? '');

  const u: any = (meta as any)?.unified ?? null;
  const uq = norm(u?.qPrimary ?? u?.q_code ?? '');
  const udepth = norm(u?.depthStage ?? u?.depth_stage ?? '');
  const uphase = norm(u?.phase ?? '');
  const ulayer = norm(u?.intentLayer ?? u?.intent_layer ?? '');
  const uanchor =
    norm(u?.intentAnchor ?? '') ||
    norm(u?.intent_anchor?.text ?? u?.intent_anchor?.anchor_text ?? '');
  const uitx = norm(u?.itxStep ?? u?.itx_step ?? '');

  return {
    q: q || uq || '',
    depth: depth || udepth || '',
    phase: phase || uphase || '',
    layer: layer || ulayer || '',
    anchor: anchor || uanchor || '',
    itx: itx || uitx || '',
    situationSummary: norm((meta as any)?.situationSummary ?? u?.situationSummary ?? ''),
    situationTopic: norm((meta as any)?.situationTopic ?? u?.situationTopic ?? ''),
  };
}

function pickSlotsHint(slots?: DiagnosisSlotLike[] | null): string {
  const arr = Array.isArray(slots) ? slots : [];
  const texts = arr
    .map((s) => norm((s as any)?.text ?? (s as any)?.content ?? ''))
    .filter(Boolean);

  if (!texts.length) return '';
  const head = texts.join(' / ');
  return head.length > 220 ? head.slice(0, 220) + '…' : head;
}

export function buildDiagnosisText(args: {
  targetLabel: string;
  meta: DiagnosisMetaLike;
  slots?: DiagnosisSlotLike[] | null;
}): { text: string; head: string; debug: Record<string, any> } {
  const targetLabel = norm(args.targetLabel) || '対象';
  const m = pickMeta(args.meta ?? ({} as any));
  const slotsHint = pickSlotsHint(args.slots);

  const head = `ir診断：${targetLabel}`;

  const lines: string[] = [];
  lines.push(head);
  lines.push('');
  lines.push(`観測対象：${targetLabel}`);

  const metaParts = [
    m.q ? `Q:${m.q}` : '',
    m.depth ? `Depth:${m.depth}` : '',
    m.phase ? `Phase:${m.phase}` : '',
    m.layer ? `Layer:${m.layer}` : '',
    m.itx ? `T:${m.itx}` : '',
    m.anchor ? `Anchor:${m.anchor}` : '',
  ].filter(Boolean);
  lines.push(`現在座標：${metaParts.length ? metaParts.join(' / ') : '（不明）'}`);

  if (m.situationSummary) lines.push(`状況サマリ：${m.situationSummary}`);
  if (m.situationTopic) lines.push(`トピック：${m.situationTopic}`);

  if (slotsHint) {
    lines.push('');
    lines.push(`観測メモ：${slotsHint}`);
  }

  lines.push('');
  lines.push('診断：');
  if (m.q || m.depth || m.phase || m.layer || m.itx) {
    lines.push('いまの会話状態は、上の「現在座標」として確定しました。');
  } else {
    lines.push('現在座標が未確定のため、診断の軸は最小で確定します。');
  }
  lines.push('この診断は “本文として確定（commit）” されます。');

  const text = lines.join('\n');

  return {
    text,
    head,
    debug: {
      picked: m,
      slotsHintLen: slotsHint.length,
    },
  };
}
