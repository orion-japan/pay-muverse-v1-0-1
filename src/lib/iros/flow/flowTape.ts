// src/lib/iros/flow/flowTape.ts
// iros — FlowTape (JSONL)
//
// 目的:
// - flow の “連続性” を、他LLMでも読める素直な JSONL で保持する
// - ここでは禁止/縛り/評価は一切しない（ログとして正直に刻むだけ）
//
// 形式（1行1イベント）:
// {"t":"META","k":"coord","v":{...},"at":"2026-01-29T00:00:00.000Z"}
// {"t":"OBS","k":"topic","v":"...","at":"..."}

export type FlowTapeType = 'META' | 'OBS' | 'SHIFT' | 'NEXT' | 'HOLD' | 'NOTE';

export type FlowTapeEvent = {
  t: FlowTapeType;
  k?: string | null;
  v?: any;
  at?: string; // ISO
};

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function toIsoNow(): string {
  return new Date().toISOString();
}

export function parseFlowTape(flowTape: string | null | undefined): FlowTapeEvent[] {
  const raw = String(flowTape ?? '').trim();
  if (!raw) return [];
  const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);

  const out: FlowTapeEvent[] = [];
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (!obj || typeof obj !== 'object') continue;

    const t = String((obj as any).t ?? '').toUpperCase();
    if (!t) continue;

    // t は許容セット以外も一応 NOTE に寄せる（破壊しない）
    const tt: FlowTapeType =
      t === 'META' || t === 'OBS' || t === 'SHIFT' || t === 'NEXT' || t === 'HOLD'
        ? (t as FlowTapeType)
        : 'NOTE';

    out.push({
      t: tt,
      k: (obj as any).k ?? null,
      v: (obj as any).v,
      at: typeof (obj as any).at === 'string' ? (obj as any).at : undefined,
    });
  }
  return out;
}

export function appendFlowTape(
  prev: string | null | undefined,
  ev: Omit<FlowTapeEvent, 'at'> & { at?: string | null }
): string {
  const p = String(prev ?? '').trim();
  const e: FlowTapeEvent = {
    t: ev.t,
    k: ev.k ?? null,
    v: ev.v,
    at: (typeof ev.at === 'string' && ev.at) ? ev.at : toIsoNow(),
  };
  const line = JSON.stringify(e);
  return p ? `${p}\n${line}` : line;
}
