// src/lib/qcode/qcode-adapter.ts
import type { QSymbol } from '../qcodes';

export type QCodeForDB = {
  code: QSymbol; // ← MVや集計の主キーはこれ
  current_q?: QSymbol | null;
  depth_stage?: string | null;
  intent?: string | null;
  ts_at?: string | null;
};

/** buildQCode() の戻り値 → DB保存用 {code:'Qx', ...} に整形 */
export function asDbQCode(qc: {
  current_q: QSymbol;
  depth_stage?: string | null;
  intent?: string | null;
  ts_at?: string | null;
}): QCodeForDB {
  return {
    code: qc.current_q,
    current_q: qc.current_q,
    depth_stage: qc.depth_stage ?? null,
    intent: qc.intent ?? null,
    ts_at: qc.ts_at ?? null,
  };
}
