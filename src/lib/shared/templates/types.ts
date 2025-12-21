export type Phase = 'Inner' | 'Outer';
export type Depth =
  | 'S1'|'S2'|'S3'
  | 'R1'|'R2'|'R3'
  | 'C1'|'C2'|'C3'
  | 'I1'|'I2'|'I3';

export interface Template {
  id: string;
  phase: Phase;
  depth: Depth;
  tone: string;     // 語感ラベル（例：静けさ・調和・創造・意図）
  lines: string[];  // [一言, 内面描写, 現実の一歩] など、短文の配列
}

/** 診断モード用：テンプレから {one, inner, real} を取り出す */
export type DiagnosisTemplate = { one: string; inner: string; real: string };

export function toDiagnosis(t: Template | undefined): DiagnosisTemplate {
  if (!t) return { one: '', inner: '', real: '' };
  const [one = '', inner = '', real = ''] = t.lines || [];
  return { one, inner, real };
}

/** phase/depth 一致で最適テンプレを取得 */
export function pickTemplate(
  templates: Template[],
  phase: Phase,
  depth: Depth
): Template | undefined {
  return templates.find((x) => x.phase === phase && x.depth === depth);
}
