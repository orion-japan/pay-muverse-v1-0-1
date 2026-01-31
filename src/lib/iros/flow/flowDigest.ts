// src/lib/iros/flow/flowDigest.ts
// iros — FlowDigest (LLM-facing tiny continuity summary)
//
// 目的:
// - FlowTape(JSONL) を “LLMが一瞬で読める短文” に変換する
// - 禁止や縛りはここでは入れない（まず自由に流す）
//
// 方針:
// - 直近の META を1行に圧縮（座標の確定感）
// - 直近の SHIFT/NEXT/HOLD を1行だけ添える（流れの連続性）
// - 直近の OBS を1行だけ添える（会話の芯）
// - 出力は最大3行（長文化させない）

import { parseFlowTape, type FlowTapeEvent } from './flowTape';

export type FlowDigestOptions = {
  maxLines?: number; // default 3
};

const DEFAULT_MAX_LINES = 3;

function pickLast(events: FlowTapeEvent[], t: string): FlowTapeEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.t === t) return events[i];
  }
  return null;
}

function compactCoord(v: any): string {
  if (!v || typeof v !== 'object') return '';
  const depthStage = v.depthStage ?? null;
  const phase = v.phase ?? null;
  const intentLayer = v.intentLayer ?? null;
  const itxStep = v.itxStep ?? null;
  const anchor = v.anchor ?? null;

  const parts: string[] = [];
  if (depthStage) parts.push(`Depth:${depthStage}`);
  if (phase) parts.push(`Phase:${phase}`);
  if (intentLayer) parts.push(`Layer:${intentLayer}`);
  if (itxStep) parts.push(`T:${itxStep}`);
  if (anchor) parts.push(`Anchor:${anchor}`);
  return parts.join(' / ');
}

function oneLine(v: any): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

export function buildFlowDigest(flowTape: string | null | undefined, opt?: FlowDigestOptions): string {
  const maxLines = Math.max(1, opt?.maxLines ?? DEFAULT_MAX_LINES);
  const events = parseFlowTape(flowTape);
  if (events.length === 0) return '';

  const lines: string[] = [];

  // 1) META（座標の確定）
  const meta = pickLast(events, 'META');
  if (meta?.k === 'coord') {
    const coord = compactCoord(meta.v);
    if (coord) lines.push(`【確定】${coord}`);
  }

  // 2) SHIFT/NEXT/HOLD（流れ）
  const shift = pickLast(events, 'SHIFT');
  const next = pickLast(events, 'NEXT');
  const hold = pickLast(events, 'HOLD');
  const flowEv = next ?? shift ?? hold;
  if (flowEv) {
    const label = flowEv.t === 'NEXT' ? '次' : flowEv.t === 'SHIFT' ? '転' : '保';
    const k = flowEv.k ? `${flowEv.k}:` : '';
    const v = oneLine(flowEv.v);
    if (v) lines.push(`【流れ】(${label}) ${k}${v}`);
  }

  // 3) OBS（芯）
  const obs = pickLast(events, 'OBS');
  if (obs) {
    const k = obs.k ? `${obs.k}:` : '';
    const v = oneLine(obs.v);
    if (v) lines.push(`【観測】${k}${v}`);
  }

  return lines.slice(0, maxLines).join('\n');
}
