// src/lib/iros/memory/mode.ts
// iros — mode vocabulary (single source of truth)
//
// 注意:
// - ここは「UIの表示モード」ではなく、IROSパイプラインの実効モード語彙。
// - 既存コードの揺れ（counsel/consult など）を吸収して正規化する。

export type IrosMode =
  | 'auto'
  | 'mirror'
  | 'resonate'
  | 'reflect'
  | 'counsel'
  | 'diagnosis'
  | 'intention'
  | 'vision'
  | 'recall';

const MODE_ALIASES: Record<string, IrosMode> = {
  // canonical
  auto: 'auto',
  mirror: 'mirror',
  resonate: 'resonate',
  reflect: 'reflect',
  counsel: 'counsel',
  diagnosis: 'diagnosis',
  intention: 'intention',
  vision: 'vision',
  recall: 'recall',

  // aliases / legacy
  consult: 'counsel',
  diag: 'diagnosis',
  ir: 'diagnosis',

  // old PascalCase (legacy)
  Auto: 'auto' as IrosMode,
  Reflect: 'reflect' as IrosMode,
  Resonate: 'resonate' as IrosMode,
  Diagnosis: 'diagnosis' as IrosMode,
  Intention: 'intention' as IrosMode,
};

/** 文字列を IrosMode に正規化。未知は null */
export function normalizeIrosMode(mode?: unknown): IrosMode | null {
  const raw = String(mode ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  return MODE_ALIASES[key] ?? MODE_ALIASES[raw] ?? null;
}

/**
 * userText からの簡易検出（明示がある時だけ）。
 * - 強制コマンドは orchestrator 側で strip する想定なので、ここは軽く。
 */
export function detectMode(userText: string): IrosMode {
  const t = (userText || '').trim();

  if (/(?:^|[\s\u3000])(?:ir\s*\u8a3a\u65ad|ir\u8a3a\u65ad|ir\u3067\u898b\u3066|ir\s*\u304a\u9858\u3044\u3057\u307e\u3059)/i.test(t)) return 'diagnosis';
  if (/意図(トリガー)?/i.test(t)) return 'intention';

  return 'auto';
}
