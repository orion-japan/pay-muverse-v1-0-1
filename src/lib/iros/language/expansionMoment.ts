// src/lib/iros/language/expansionMoment.ts
// iros — Expansion Moment Detector (human-language safe)
// 目的：
// - 「展開しそうな瞬間」だけを機械的に検出する
// - 意味解析に寄りすぎず、語尾/構造/量の3系統で判定する
// - 返すのは “次に出す型” だけ（BRANCH / TENTATIVE / NONE）

export type ExpansionKind = 'NONE' | 'BRANCH' | 'TENTATIVE';

export type ExpansionSignal = {
  kind: ExpansionKind;
  reasons: string[]; // ログ用（ユーザーには出さない）
};

export type ExpansionInput = {
  userText: string;
  // 直近の「ユーザー発話の列」（最新が末尾）
  recentUserTexts?: string[];
};

const LANG_TRIGGERS = [
  'つまり',
  '結局',
  'なんか',
  'たぶん',
  'もういい',
  'ここかな',
];

function normalize(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function isShort(s: string): boolean {
  const t = normalize(s);
  // 句読点を除いた長さで判定
  const core = t.replace(/[。、！!？?「」『』（）()\[\]【】…・]/g, '');
  return core.length <= 14;
}

function hasLanguageTrigger(s: string): boolean {
  const t = normalize(s);
  return LANG_TRIGGERS.some((w) => t.includes(w));
}

function isSentenceFinalAssert(s: string): boolean {
  const t = normalize(s);
  // 言い切り系（「。」で終わる / 断定っぽい終端）を軽く拾う
  if (t.endsWith('。')) return true;
  if (t.endsWith('だ') || t.endsWith('です') || t.endsWith('する')) return true;
  return false;
}

function isLoopish(recentUserTexts: string[]): boolean {
  if (recentUserTexts.length < 3) return false;

  const a = normalize(recentUserTexts[recentUserTexts.length - 1]);
  const b = normalize(recentUserTexts[recentUserTexts.length - 2]);
  const c = normalize(recentUserTexts[recentUserTexts.length - 3]);

  // “同じ語” を繰り返す感じを雑に拾う（完全一致ではなく、末尾一致・高い類似だけ）
  if (a === b) return true;
  if (a.length >= 8 && b.includes(a.slice(0, 8))) return true;
  if (b.length >= 8 && a.includes(b.slice(0, 8))) return true;
  if (a === c) return true;

  return false;
}

export function detectExpansionMoment(input: ExpansionInput): ExpansionSignal {
  const userText = normalize(input.userText);
  const recentUserTexts = (input.recentUserTexts ?? []).map(normalize).filter(Boolean);

  const reasons: string[] = [];

  // ① まとめ始め兆候（言語トリガー）
  const lang = hasLanguageTrigger(userText);
  if (lang) reasons.push('LANG_TRIGGER');

  // ② 停止兆候（構造トリガー）
  const loop = isLoopish(recentUserTexts);
  if (loop) reasons.push('LOOPISH');

  // ③ 圧縮兆候（量トリガー）
  const short = isShort(userText);
  if (short) reasons.push('SHORT');

  const assert = isSentenceFinalAssert(userText);
  if (assert) reasons.push('ASSERT_END');

  // ---- 判定（優先順位）
  // “展開しそう” でないなら NONE
  const likely = lang || loop || short || assert;
  if (!likely) return { kind: 'NONE', reasons };

  // 分岐か仮決めかは、迷いそう度で振り分ける
  // - 迷いが強いとき（短文 + ループ）→ 仮決め
  // - それ以外は分岐（2択提示の余地がある想定）
  const tentative = (short && loop) || (short && lang) || (loop && assert);
  if (tentative) return { kind: 'TENTATIVE', reasons: [...reasons, 'PICK_TENTATIVE'] };

  return { kind: 'BRANCH', reasons: [...reasons, 'PICK_BRANCH'] };
}
