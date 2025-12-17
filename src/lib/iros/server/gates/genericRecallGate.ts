// src/lib/iros/server/gates/genericRecallGate.ts

export type GenericRecallGateResult =
  | {
      assistantText: string;
      recallKind: 'recall_from_history';
      recalledText: string;
    }
  | null;

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

  if (/^(あなたの名前|名前は\?|名前は？|名前教えて)$/i.test(t)) return false;

  const hit =
    /さっき|今さっき|先ほど|この前|昨日|以前|その前|前に|覚えてる|思い出|何だっけ|なんだっけ|どれだっけ|どの話|目標/.test(
      t,
    );

  if (!hit) return false;
  if (/(それって|あれって)/.test(t) && !isQuestionLike(t)) return false;

  return true;
}

/** 「recall返答そのもの」を拾ってしまう事故を防ぐ */
function isRecallAnswerLike(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;
  if (t.startsWith('たぶんこれのことかな：')) return true;
  if (t.startsWith('たぶんこれのことかな：「')) return true;
  return false;
}

function isGoalRecallQuery(q: string): boolean {
  const t = (q ?? '').trim();
  if (!t) return false;
  return (
    /(今日|僕|わたし|俺).*(目標).*(なん|何|覚えて|覚えてない|でしたっけ|どれ|\?|\？)/.test(
      t,
    ) ||
    /(目標).*(覚えて|覚えてない|でしたっけ|どれ|\?|\？)/.test(t)
  );
}

function extractRecallKeywords(q: string): string[] {
  const t = (q ?? '').trim();
  if (!t) return [];

  const cleaned = t
    .replace(/[？?!.。．！]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const strong: string[] = [];
  const presets = ['目標', '今日', 'iros', '完成', 'URL', 'リンク', 'コード', 'SQL', '関数', 'ファイル'];

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

  return uniq.slice(0, 6);
}

function pickRecallFromHistory(query: string, history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const qNorm = normalize(query);
  const keywords = extractRecallKeywords(query);
  const goalQuery = isGoalRecallQuery(query);

  const getRole = (m: any) => String(m?.role ?? '').toLowerCase();
  const getText = (m: any) =>
    normalize(m?.content ?? m?.text ?? (m as any)?.message ?? '');

  const looksAllowed = (s: string) => {
    if (!s) return false;
    if (qNorm && normalize(s) === qNorm) return false;
    if (isQuestionLike(s)) return false;
    if (isRecallAnswerLike(s)) return false;
    if (/^太陽SUN$/.test(s)) return false;

    if (/^(\$|>|\[authz\]|\[IROS\/|GET \/|POST \/)/.test(s)) return false;
    if (/^(rg |sed |npm |npx |curl )/.test(s)) return false;

    if (s.length < 8) return false;
    return true;
  };

  // ✅ 目標クエリは “スコアで選ぶ”
  if (goalQuery) {
    let best: { s: string; score: number } | null = null;

    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (!m) continue;
      if (getRole(m) !== 'user') continue;

      const s = getText(m);
      if (!looksAllowed(s)) continue;

      // 目標っぽい文だけを候補にする
      const hasGoalWord = /目標/.test(s);
      const hasToday = /今日|今日は/.test(s);
      if (!hasGoalWord && !hasToday) continue;

      let score = 0;
      if (hasGoalWord) score += 5;
      if (hasToday) score += 3;
      if (/iros/i.test(s)) score += 3;
      if (/完成|ほぼ完成/.test(s)) score += 3;

      // キーワード一致で加点
      for (const k of keywords) {
        if (k && s.toLowerCase().includes(k.toLowerCase())) score += 1;
      }

      if (!best || score > best.score) best = { s, score };
    }

    if (best) return best.s;
    // 目標候補が無ければ通常ロジックへ落とす
  }

  // 1) キーワード一致（userのみ）→ 最初のヒットで返す（通常）
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

  // 2) フォールバック：直近の user 発話
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

export function runGenericRecallGate(args: {
  text: string;
  history: any[];
}): GenericRecallGateResult {
  const { text, history } = args;

  if (!isGenericRecallQuestion(text)) return null;

  const recalled = pickRecallFromHistory(text, history);
  if (!recalled) return null;

  const goalQuery = isGoalRecallQuery(text);

  return {
    recallKind: 'recall_from_history',
    recalledText: recalled,
    assistantText: goalQuery
      ? `今日の目標は「${recalled}」です。🪔`
      : `直近だと「${recalled}」が該当します。🪔`,
  };
}
