// src/lib/iros/intent.ts
// Iros: 入力テキストから会話モードなどを推定する最小実装。
// - detectMode(): Mode を返す（hint > キーワード）
// - containsBannedAbstractIntro / inferGoal / detectIsDark は他ルート互換用の薄い実装
// 既存コードの import 互換のため、detectMode は named と default の両方で export

export type Mode = 'auto' | 'diagnosis' | 'counsel' | 'structured';

type DetectArgs = {
  text: string;
  hint?: Mode | string | null;
};

export const TRIGGERS = {
  counsel: [
    /相談(が|です|したい|あります)/i,
    /悩み|困って|助けて|どうしたら/i,
  ],
  structured: [
    /レポート形式|構造化|要件を.*まとめて/i,
    /箇条書き|整理して.*提示/i,
  ],
  diagnosis: [
    /ir診断|診断してください|診断モード/i,
  ],
} as const;

export async function detectMode(args: DetectArgs): Promise<{ mode: Mode }> {
  const raw = String(args.text ?? '').trim();

  // 1) ヒント最優先（妥当であれば採用）
  const hint = (args.hint ?? '').toString().toLowerCase();
  if (hint === 'counsel') return { mode: 'counsel' };
  if (hint === 'structured') return { mode: 'structured' };
  if (hint === 'diagnosis') return { mode: 'diagnosis' };

  // 2) キーワードで判定
  if (TRIGGERS.counsel.some((re) => re.test(raw))) return { mode: 'counsel' };
  if (TRIGGERS.structured.some((re) => re.test(raw))) return { mode: 'structured' };
  if (TRIGGERS.diagnosis.some((re) => re.test(raw))) return { mode: 'diagnosis' };

  // 3) 既定
  return { mode: 'auto' };
}

/* ===== 互換ユーティリティ（別ルートが import しているため最低限を提供） ===== */

// 「抽象イントロ（定義の押し付け）」を禁止する軽い検出。
// 実際の運用ロジックが別にあるなら差し替えてOK。
export function containsBannedAbstractIntro(text: string): boolean {
  const s = (text ?? '').slice(0, 80);
  return /あなたは|君は|人はこうだ|定義します|結論として/i.test(s);
}

// ざっくりゴール推定（structured 用の見出し生成などで利用される想定）
export function inferGoal(text: string): string | null {
  const m =
    text.match(/(?:目的|ゴール|目標)[：:]\s*([^\n。]+)/) ||
    text.match(/(?:達成したいこと|やりたいこと)[：:]\s*([^\n。]+)/);
  return m ? m[1].trim() : null;
}

// ネガティブ・ダークトーンの簡易検出（相談/闇モードの分岐補助）
export function detectIsDark(text: string): boolean {
  return /(不安|恐れ|怒り|絶望|無力|つらい|苦しい|闇|憎しみ)/i.test(text ?? '');
}

// 互換性のため default でも export（どちらの import 形でも動く）
export default detectMode;
