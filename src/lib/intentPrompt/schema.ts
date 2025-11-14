// src/lib/intentPrompt/schema.ts
// 目的：フォーム値と微調整値のバリデーション／正規化を分離して保守性を高める。
// 依存：外部ライブラリ不使用（「見当で進めない」方針に合わせて純TSで実装）

/* ========= フォーム型（generatePrompt へ依存しない独立定義） ========= */
export type Mood = '静けさ' | '希望' | '情熱' | '不安' | '迷い' | '感謝';
export type Visibility = '公開' | '非公開';
export type TLayer = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export type Season = '未指定' | '夏' | '秋' | '冬' | '春';
export type Timing = '設けない' | '早急' | '近未来' | '将来' | '使命';

export type IntentionForm = {
  name: string;
  target: string;
  desire: string;
  reason: string;
  vision: string;
  mood: Mood;
  visibility: Visibility;
  lat?: number;
  lon?: number;
  season: Season;
  timing: Timing;
  tLayer: TLayer;
};

/* ========= 選択肢（唯一のソース） ========= */
export const MOODS: readonly Mood[] = ['静けさ', '希望', '情熱', '不安', '迷い', '感謝'] as const;
export const VISIBILITIES: readonly Visibility[] = ['公開', '非公開'] as const;
export const TLAYERS: readonly TLayer[] = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export const SEASONS: readonly Season[] = ['未指定', '夏', '秋', '冬', '春'] as const;
export const TIMINGS: readonly Timing[] = ['設けない', '早急', '近未来', '将来', '使命'] as const;

/* ========= 仕様に基づく下限・上限 ========= */
export const BASE_L_MIN = 12; // 黒つぶれ回避の下限
export const BASE_L_MAX = 22; // T5レンジ考慮の安全上限
export const HCLIP_MIN = 70;  // 露光クリップの推奨下限
export const HCLIP_MAX = 90;  // 露光クリップの推奨上限

/* ========= FineTune の型 ========= */
export type FineTuneInput = Partial<{
  baseTone: 'deep ultramarine' | 'forest gray' | 'indigo';
  baseLPercent: number;
  texture: 'oil pastel' | 'nebula dust' | 'soft grain';
  sheetGlowPercent: number;
  flowMotif: 'gentle arcs' | 'converging streams' | 'soft vortices' | 'radiant spiral';
  obstaclePattern: 'turbulence' | 'noise' | 'opacity';
  highlightClipPercent: number;
  colorRatioOverride: string;
  grainNoteOverride: string;
  addNotes: string[];
}>;

/* ========= エラーモデル ========= */
export type FieldError = { field: string; message: string };
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };

/* ========= ユーティリティ ========= */
const isFiniteNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);

// 文字列の必須チェック
function reqStr(field: string, v: unknown, errors: FieldError[]) {
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push({ field, message: `${field} is required` });
  }
}

// 列挙のチェック
function inSet<T extends string>(field: string, v: any, set: readonly T[], errors: FieldError[]) {
  if (!set.includes(v)) errors.push({ field, message: `${field} must be one of: ${set.join(', ')}` });
}

// 数値の範囲クランプ（仕様厳守）
export function clampBaseL(v: number): number {
  return Math.max(BASE_L_MIN, Math.min(BASE_L_MAX, Math.round(v)));
}
export function clampHighlightClip(v: number): number {
  return Math.max(HCLIP_MIN, Math.min(HCLIP_MAX, Math.round(v)));
}

/* ========= フォーム検証 ========= */
export function validateForm(input: Partial<IntentionForm>): ValidationResult<IntentionForm> {
  const errors: FieldError[] = [];
  reqStr('name', input.name, errors);
  reqStr('target', input.target, errors);
  reqStr('desire', input.desire, errors);
  reqStr('reason', input.reason, errors);
  reqStr('vision', input.vision, errors);

  if (input.mood === undefined) errors.push({ field: 'mood', message: 'mood is required' });
  else inSet('mood', input.mood, MOODS, errors);

  if (input.visibility === undefined) errors.push({ field: 'visibility', message: 'visibility is required' });
  else inSet('visibility', input.visibility, VISIBILITIES, errors);

  if (input.season === undefined) errors.push({ field: 'season', message: 'season is required' });
  else inSet('season', input.season, SEASONS, errors);

  if (input.timing === undefined) errors.push({ field: 'timing', message: 'timing is required' });
  else inSet('timing', input.timing, TIMINGS, errors);

  if (input.tLayer === undefined) errors.push({ field: 'tLayer', message: 'tLayer is required' });
  else inSet('tLayer', input.tLayer, TLAYERS, errors);

  // lat/lon は任意だが、与えられた場合は有限数であるべき
  if (input.lat !== undefined && !isFiniteNum(input.lat)) errors.push({ field: 'lat', message: 'lat must be a finite number' });
  if (input.lon !== undefined && !isFiniteNum(input.lon)) errors.push({ field: 'lon', message: 'lon must be a finite number' });

  if (errors.length) return { ok: false, errors };
  // 型の完全性をここで保証（検証済みのため安全）
  return { ok: true, data: input as IntentionForm };
}

/* ========= FineTune の正規化（安全ガード適用） ========= */
export function normalizeFineTune(ft?: FineTuneInput) {
  if (!ft) return undefined;

  const out: FineTuneInput = { ...ft };

  if (isFiniteNum(out.baseLPercent)) out.baseLPercent = clampBaseL(out.baseLPercent!);
  if (isFiniteNum(out.highlightClipPercent)) out.highlightClipPercent = clampHighlightClip(out.highlightClipPercent!);

  // sheetGlowPercent は 0–100 の範囲に丸める（指定がある場合のみ）
  if (isFiniteNum(out.sheetGlowPercent)) {
    const v = Math.round(out.sheetGlowPercent!);
    out.sheetGlowPercent = Math.max(0, Math.min(100, v));
  }

  // 追加ノートは空行を除去して正規化
  if (Array.isArray(out.addNotes)) {
    out.addNotes = out.addNotes.map((s) => String(s).trim()).filter(Boolean);
  }

  return out;
}
