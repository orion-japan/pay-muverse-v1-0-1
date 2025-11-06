export type Phase = 'Inner' | 'Outer';
export type Depth = 'S1'|'S2'|'S3'|'R1'|'R2'|'R3'|'C1'|'C2'|'C3'|'I1'|'I2'|'I3';

export interface Template {
  id: string;
  phase: Phase;
  depth: Depth;
  tone: string;     // 語感ラベル（例：静けさ・調和・創造・意図）
  lines: string[];  // [一言, 内面描写, 現実の一手] など、短文の配列
}

export function pickTemplate(
  templates: Template[],
  phase: Phase,
  depth: Depth
): Template | undefined {
  return templates.find(t => t.phase === phase && t.depth === depth);
}
