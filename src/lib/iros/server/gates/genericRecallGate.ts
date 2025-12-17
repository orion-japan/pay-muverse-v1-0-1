// src/lib/iros/server/gates/genericRecallGate.ts
// iros - Generic recall gate (conversation glue)
// - 「さっき/この前/昨日/何だっけ」等で履歴から拾って自然に会話をつなぐ
// - ここでは「候補抽出 + 返答文生成」までを担当（永続化は呼び出し側で行う）

export type GenericRecallGateResult =
  | {
      assistantText: string;
      recallKind: 'recall_from_history';
      recalledText: string;
    }
  | null;

/* ---------------------------
   判定
---------------------------- */

function normalize(s: any): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function isQuestionLike(s: string): boolean {
  if (!s) return true;
  if (/[？?]$/.test(s)) return true;
  if (/なんでしたっけ|何だっけ|どれだっけ|教えて|思い出|覚えて/.test(s))
    return true;
  return false;
}

export function isGenericRecallQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;

  // ★ まず「名前」系の誤爆を完全に殺す（"名前" が recall になる事故）
  // ここは安全のため明示的に除外しておく
  if (/^(あなたの名前|名前は\?|名前は？|名前教えて)$/i.test(t)) return false;

  // ★ 「前」単体は危険なので捨てる。文脈付きだけ拾う
  const hit =
    /さっき|今さっき|先ほど|この前|昨日|以前|その前|前に|覚えてる|思い出|何だっけ|なんだっけ|どれだっけ|どの話/.test(
      t,
    );

  if (!hit) return false;

  // 「それって/あれって」は質問っぽいときだけ
  if (/(それって|あれって)/.test(t) && !isQuestionLike(t)) return false;

  return true;
}


/* ---------------------------
   抽出ユーティリティ
---------------------------- */

/** 「recall返答そのもの」を拾ってしまう事故を防ぐ */
function isRecallAnswerLike(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;

  // これが二重ネスト事故の直接原因
  if (t.startsWith('たぶんこれのことかな：')) return true;
  if (t.startsWith('たぶんこれのことかな：「')) return true;

  return false;
}

/** クエリから “探すキーワード” を抽出（短くて強いものだけ） */
function extractRecallKeywords(q: string): string[] {
  const t = (q ?? '').trim();
  if (!t) return [];

  const cleaned = t
    .replace(/[？?!.。．！]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const strong: string[] = [];
  const presets = [
    '目標',
    'お礼',
    '感謝',
    'ありがとう',
    'サンキュー',
    'thanks',
    '名前',
    'URL',
    'リンク',
    'コード',
    'SQL',
    '関数',
    'ファイル',
    '予定',
    '時間',
    '場所',
  ];

  for (const p of presets) {
    if (cleaned.toLowerCase().includes(p.toLowerCase())) strong.push(p);
  }

  const stop =
    /^(さっき|この前|昨日|前|今さっき|なんだっけ|何だっけ|どれだっけ|どの話|それ|あれ|覚えてる|思い出)$/;

  const tokens = cleaned
    .split(' ')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2 && x.length <= 12)
    .filter((x) => !stop.test(x));

  const uniq: string[] = [];
  for (const x of [...strong, ...tokens]) {
    const k = x.toLowerCase();
    if (!uniq.some((u) => u.toLowerCase() === k)) uniq.push(x);
  }

  return uniq.slice(0, 4);
}

/**
 * 履歴から拾う（安全版）
 * - 原則 user 発話のみ
 * - recall返答っぽい文は除外（ネスト事故防止）
 * - 重要：query（今回の発話）と同一の文は除外（自己参照ループ防止）
 */
function pickRecallFromHistory(query: string, history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const qNorm = normalize(query);
  const keywords = extractRecallKeywords(query);

  const getRole = (m: any) => String(m?.role ?? '').toLowerCase();
  const getText = (m: any) =>
    normalize(m?.content ?? m?.text ?? (m as any)?.message ?? '');

  const looksAllowed = (s: string) => {
    if (!s) return false;

    // ★ 自己参照ループ防止：今回の入力と同一なら候補にしない
    if (qNorm && normalize(s) === qNorm) return false;

    if (isQuestionLike(s)) return false;
    if (isRecallAnswerLike(s)) return false;

    // 固定アンカーだけ拾う事故を避ける
    if (/^太陽SUN$/.test(s)) return false;

    // 開発ログ・コマンド除外
    if (/^(\$|>|\[authz\]|\[IROS\/|GET \/|POST \/)/.test(s)) return false;
    if (/^(rg |sed |npm |npx |curl )/.test(s)) return false;

    // 短すぎ除外
    if (s.length < 8) return false;

    return true;
  };

  // 1) キーワード一致（userのみ）
  if (keywords.length > 0) {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (!m) continue;
      if (getRole(m) !== 'user') continue;

      const s = getText(m);
      if (!looksAllowed(s)) continue;

      const anyHit = keywords.some((k) =>
        s.toLowerCase().includes(k.toLowerCase()),
      );
      if (anyHit) return s;
    }
  }

  // 2) フォールバック：直近の user「質問じゃない・recall返答じゃない」発話
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    if (getRole(m) !== 'user') continue;

    const s = getText(m);
    if (!looksAllowed(s)) continue;

    return s;
  }

  return null;
}

/* ---------------------------
   メイン
---------------------------- */

export function runGenericRecallGate(args: {
  text: string;
  history: any[];
}): GenericRecallGateResult {
  const { text, history } = args;

  if (!isGenericRecallQuestion(text)) return null;

  const recalled = pickRecallFromHistory(text, history);
  if (!recalled) return null;

  return {
    recallKind: 'recall_from_history',
    recalledText: recalled,
    assistantText: `たぶんこれのことかな：「${recalled}」です。🪔`,
  };
}
