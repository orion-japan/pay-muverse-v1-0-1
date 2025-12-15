// file: src/lib/iros/server/handleIrosReply.render.ts
// iros - Render/Polish (strip internal labels + comfort inject + nextStep pickup)

import type { CanonicalMeta, CanonicalQCode } from './handleIrosReply.meta';

export type RenderEngineInput = {
  assistantText: string;
  metaForSave: any;        // 既存の meta をそのまま渡す（破壊は最小限）
  canonical: CanonicalMeta; // canonicalizeIrosMeta の結果
  effectiveStyle?: string | null;
};

export type RenderEngineOutput = {
  assistantText: string;
  metaForSave: any;
};

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 内部ラベルを “表示テキスト” から剥がす
 * - 深度/位相/IT層などの露出を抑える
 * - 既存 handleIrosReply.ts の stripInternalLabels を移植
 */
export function stripInternalLabels(input: string): string {
  let t = String(input ?? '');

  t = t.replace(/深度[は:\s　]*[SRICT]\d{1,2}/g, '深度');
  t = t.replace(/[\(（]\s*[SRICT]\d{1,2}\s*[\)）]/g, '');
  t = t.replace(/[SRICT]\d{1,2}(?=(\s|　|に|へ|から|です|。|、|,))/g, '');

  t = t.replace(/位相[は:\s　]*(Inner|Outer)/gi, '位相');
  t = t.replace(/\b(Inner|Outer)\b/gi, '');

  t = t.replace(/[IT]層/g, '');

  t = t.replace(/[ \t　]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * “残りカス” をさらに落とす（既存コードの追加replace群をまとめたもの）
 */
function stripResidualAxisTokens(input: string): string {
  return String(input ?? '')
    .replace(/S[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3]/g, '')
    .replace(/深度|位相|レイヤー/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * qCode に応じた comfort 注入の要否
 * （現状の方針を維持：Q3/Q4/Q5 だけ）
 */
function needsComfort(q: CanonicalQCode | null): boolean {
  return q === 'Q3' || q === 'Q4' || q === 'Q5';
}

/**
 * soulNote / unified.soulNote の comfortPhrases を最大2つ拾う
 */
function pickComfortPhrases(metaForSave: any): string[] | null {
  const m = isObj(metaForSave) ? metaForSave : {};
  const unified = isObj(m.unified) ? m.unified : {};

  const soul = (isObj(m.soulNote) ? m.soulNote : null) ?? (isObj(unified.soulNote) ? unified.soulNote : null);
  if (!soul) return null;

  const raw =
    (soul as any).comfort_phrases ??
    (soul as any).comfortPhrases ??
    null;

  if (!Array.isArray(raw)) return null;

  const list = raw
    .filter((x: any) => typeof x === 'string' && x.trim().length > 0)
    .map((x: string) => x.trim())
    .slice(0, 2);

  return list.length ? list : null;
}

/**
 * soulNote / unified.soulNote の microSteps を最大3つ拾う
 * - nextStep は “保持するだけ” の方針を維持
 */
function pickMicroSteps(metaForSave: any): string[] | null {
  const m = isObj(metaForSave) ? metaForSave : {};
  const unified = isObj(m.unified) ? m.unified : {};

  const soul = (isObj(m.soulNote) ? m.soulNote : null) ?? (isObj(unified.soulNote) ? unified.soulNote : null);
  if (!soul) return null;

  const raw =
    (soul as any).micro_steps ??
    (soul as any).microSteps ??
    null;

  if (!Array.isArray(raw)) return null;

  const list = raw
    .filter((x: any) => typeof x === 'string' && x.trim().length > 0)
    .map((x: string) => x.trim())
    .slice(0, 3);

  return list.length ? list : null;
}

/**
 * 文章の最終整形（ここは “完全一致の仕様” を避けて最小限にする）
 * - style は将来拡張用（今は触らない）
 * - 句読点や空行を整えるだけ
 */
export function finalPolishText(input: string): string {
  let t = String(input ?? '');

  // 空白の詰め
  t = t.replace(/[ \t　]{2,}/g, ' ');

  // 空行3つ以上を2つへ
  t = t.replace(/\n{3,}/g, '\n\n');

  // 行頭・行末
  t = t.trim();

  return t;
}

/**
 * renderEngine 本体：
 * - assistantText を strip -> comfort 注入 -> strip -> finalPolish
 * - nextStep を soul から拾って metaForSave.nextStep に入れる（既にあれば上書きしない）
 */
export function applyRenderEngine(input: RenderEngineInput): RenderEngineOutput {
  const { assistantText, metaForSave, canonical } = input;

  const m = isObj(metaForSave) ? metaForSave : {};
  const unified = isObj(m.unified) ? m.unified : {};

  let text = String(assistantText ?? '');
  if (!text.trim()) return { assistantText: text, metaForSave };

  // 1) 内部ラベル除去（2段階）
  text = stripInternalLabels(text);
  text = stripResidualAxisTokens(text);

  // 2) comfort（必要時のみ）
  if (needsComfort(canonical.qCode)) {
    const comfort = pickComfortPhrases(metaForSave);
    if (comfort && comfort.length > 0) {
      const line = comfort[0].trim();
      if (line && !text.startsWith(line)) {
        text = `${line}\n\n${text}`;
      }
    }
  }

  // 3) nextStep を拾う（保持するだけ）
  const microSteps = pickMicroSteps(metaForSave);
  const nextFromSoul = microSteps && microSteps.length > 0 ? microSteps[0] : null;

  const existingNext =
    (m.nextStep && typeof m.nextStep === 'object') ? m.nextStep :
    (m.next_step && typeof m.next_step === 'object') ? m.next_step :
    null;

  if (!existingNext && typeof nextFromSoul === 'string' && nextFromSoul.trim().length > 0) {
    m.nextStep = { text: nextFromSoul.trim() };
  } else if (existingNext && !m.nextStep) {
    // next_step だけ入っている既存ケース救済
    m.nextStep = existingNext;
  }

  // 4) 最後にもう一回 strip + polish
  text = stripInternalLabels(text);
  text = finalPolishText(text);

  // metaForSave の参照が必要なら unified も戻す（破壊しない）
  if (isObj(m) && isObj(unified) && !m.unified) {
    m.unified = unified;
  }

  return {
    assistantText: text,
    metaForSave: m,
  };
}
