// src/lib/iros/intent.ts
import type { IrosMode } from '@/lib/iros/system';

// orchestrator 側の実装差に耐性を持たせる（関数名/引数形の差異を吸収）
import detect from '@/lib/iros/orchestratorCore';

/** summarize 側が期待している型の互換名 */
export type Mode = IrosMode;

/** detectIntentMode: 受け取り {text} | string、返り { mode } に統一 */
export type DetectArgs = { text: string };

export default async function detectIntentMode(
  arg: DetectArgs | string,
): Promise<{ mode: IrosMode }> {
  const text = typeof arg === 'string' ? arg : arg.text;

  // ① （text）→ IrosMode | {mode} 返し
  try {
    const out = await (detect as any)(text);
    const mode = (out as any)?.mode ?? out;
    if (typeof mode === 'string') return { mode: mode as IrosMode };
  } catch { /* 次へ */ }

  // ② ({text}) → IrosMode | {mode} 返し
  try {
    const out2 = await (detect as any)({ text });
    const mode = (out2 as any)?.mode ?? out2;
    if (typeof mode === 'string') return { mode: mode as IrosMode };
  } catch { /* フォールバック */ }

  // フォールバック（安全側）
  return { mode: 'counsel' };
}

/* =========================
 *  互換：named exports
 *  summarize/route.ts が import する想定の関数群を提供
 *  - まず orchestratorCore 上の同名実装があれば委譲
 *  - 無ければ安全なデフォルトへフォールバック
 * ========================= */

/** 学術的/抽象的な前置きNG判定（委譲 or ヒューリスティック） */
export function containsBannedAbstractIntro(text: string): boolean {
  // orchestrator 側にあれば優先
  const fn = (detect as any)?.containsBannedAbstractIntro;
  if (typeof fn === 'function') {
    try { return !!fn(text); } catch {}
  }
  // 簡易ヒューリスティック（必要なら精緻化）
  const t = (text || '').trim();
  if (t.length < 4) return false;
  const ngPats = [
    /^本\s*稿[は]|^本\s*論[は]/,
    /^本研究[は]|^本調査[は]/,
    /^序論|^抽象的に|^一般論として/,
    /^AIとは|^歴史的には/,
  ];
  return ngPats.some((re) => re.test(t));
}

/** ゴール推定（要約タイトル/目的抽出）。なければ null */
export function inferGoal(text: string): string | null {
  const fn = (detect as any)?.inferGoal;
  if (typeof fn === 'function') {
    try {
      const r = fn(text);
      return typeof r === 'string' ? r : (r ?? null);
    } catch {}
  }
  // 簡易抽出（句点・改行まで）
  const t = (text || '').trim();
  if (!t) return null;
  const m = t.match(/^(.+?)(。|\n|$)/);
  return (m?.[1] ?? t).slice(0, 80);
}

/** 闇系（ネガ傾向）検知。なければヒューリスティックで判定 */
export function detectIsDark(text: string): boolean {
  const fn = (detect as any)?.detectIsDark;
  if (typeof fn === 'function') {
    try { return !!fn(text); } catch {}
  }
  const t = (text || '').toLowerCase();
  if (!t) return false;
  const ngWords = [
    '不安', '恐れ', '恐怖', '絶望', '無力', '自己否定', '攻撃', '怒り',
    'つらい', '疲れた', '死にたい', 'やめたい', '最悪', '無価値',
    // 英語も少し
    'anxious', 'fear', 'hopeless', 'worthless', 'angry', 'tired',
  ];
  return ngWords.some((w) => t.includes(w));
}
