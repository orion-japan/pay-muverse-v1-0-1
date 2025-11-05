// src/lib/iros/intent.ts

/**
 * Iros の「モード」定義。
 */
export type Mode = 'Light' | 'Deep' | 'Harmony' | 'Transcend';

/**
 * ユーザ入力が抽象的すぎる/禁止したい導入句を含むかの簡易判定。
 */
export function containsBannedAbstractIntro(text?: string): boolean {
  const t = (text ?? '').toLowerCase();
  const patterns = [
    'まずは自己紹介',
    '概要を教えて',
    '抽象的に',
    'とりあえず',
    '何でもいい',
    'なんでもいい',
  ];
  return patterns.some((p) => t.includes(p));
}

/**
 * 簡易ゴール推定（将来差し替え可）。
 */
export function inferGoal(text?: string): 'diagnosis' | 'brainstorm' | 'advice' | 'chat' {
  const t = (text ?? '').toLowerCase();
  if (/\b(ir|ir診断|診断|analysis|analyze)\b/.test(t)) return 'diagnosis';
  if (/\b(brainstorm|案出し|アイデア|発想)\b/.test(t)) return 'brainstorm';
  if (/\b(help|advice|助言|アドバイス|どうすれば)\b/.test(t)) return 'advice';
  return 'chat';
}

/**
 * 「暗（ダーク）寄り」かの簡易判定。
 */
export function detectIsDark(text?: string): boolean {
  const t = (text ?? '').toLowerCase();
  const neg = ['無理', '疲れ', 'しんど', '不安', '怖', 'つら', '怒', 'やめたい', '最悪', 'ダメ'];
  const score = neg.reduce((acc, w) => (t.includes(w) ? acc + 1 : acc), 0);
  return score >= 2;
}

/**
 * 文字列から最終モードを決定する正規化関数。
 * 第2引数 contextText は任意の文脈。未指定/不明時のフォールバックに利用。
 *
 * 呼び出し互換:
 *   deriveFinalMode(seedMode)
 *   deriveFinalMode(seedMode, body.user_text)
 */
export function deriveFinalMode(input?: string | null, contextText?: string | null): Mode {
  const s = String(input ?? '').trim().toLowerCase();

  // 既知エイリアス吸収
  if (['light', 'lite', 'l', 'normal', 'basic', 'default', 'デフォルト', 'ライト'].includes(s))
    return 'Light';
  if (['deep', 'd', 'heavy', '深い', 'ディープ'].includes(s)) return 'Deep';
  if (['harmony', 'harmonic', 'bal', 'balance', '調和', 'ハーモニー'].includes(s)) return 'Harmony';
  if (['transcend', 't', 'trans', 'beyond', '超越', 'トランセンド'].includes(s))
    return 'Transcend';

  if (['light', 'deep', 'harmony', 'transcend'].includes(s)) {
    return (s.charAt(0).toUpperCase() + s.slice(1)) as Mode;
  }

  // --- フォールバック判断（contextText を活用）---
  const ctx = (contextText ?? '').toLowerCase();
  if (ctx) {
    if (detectIsDark(ctx)) return 'Deep';
    if (/(調和|バランス|和|仲直り|折衷|harmon)/.test(ctx)) return 'Harmony';
    if (/(越える|超える|突破|超越|transcen)/.test(ctx)) return 'Transcend';
  }
  return 'Light';
}

/**
 * もしモード正規化だけ使いたい場合のエイリアス。
 */
export function normalizeMode(m?: string | null): Mode {
  return deriveFinalMode(m);
}
