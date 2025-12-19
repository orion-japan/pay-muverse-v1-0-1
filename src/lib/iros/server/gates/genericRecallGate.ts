// src/lib/iros/server/gates/genericRecallGate.ts

export type GenericRecallGateResult =
  | {
      assistantText: string;
      recallKind: 'recall_from_history';
      recalledText: string;
    }
  | null;

type RecallScope = 'yesterday' | 'today' | 'last_week' | 'any';

function normalize(s: any): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function isQuestionLike(s: string): boolean {
  if (!s) return true;
  if (/[？?]$/.test(s)) return true;
  if (/なんでしたっけ|なんだっけ|何だっけ|どれだっけ|教えて|思い出|覚えて/.test(s))
    return true;
  return false;
}

export function isGenericRecallQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;

  // 明確に除外したいもの
  if (/^(あなたの名前|名前は\?|名前は？|名前教えて)$/i.test(t)) return false;

  const hit =
    /さっき|今さっき|先ほど|この前|昨日|きのう|yesterday|今日|きょう|today|先週|last week|以前|その前|前に|覚えてる|思い出|何だっけ|なんだっけ|どれだっけ|どの話|目標|抱負|豊富/.test(
      t,
    );

  if (!hit) return false;

  // 「それって/あれって」だけで断定調は除外
  if (/(それって|あれって)/.test(t) && !isQuestionLike(t)) return false;

  return true;
}

/** 「recall返答そのもの」を拾ってしまう事故を防ぐ */
function isRecallAnswerLike(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;

  // 旧テンプレ群
  if (t.startsWith('たぶんこれのことかな：')) return true;
  if (t.startsWith('たぶんこれのことかな：「')) return true;

  // この gate 自身が返すテンプレも自己参照ループになるので除外
  if (/^直近だと「.+」が該当します/.test(t)) return true;
  if (/^(今日|昨日|目標)の目標は「.+」です/.test(t)) return true;

  return false;
}

function isGoalRecallQuery(q: string): boolean {
  const t = (q ?? '').trim();
  if (!t) return false;

  if (
    /(目標|抱負|方針|やりたいこと)/.test(t) &&
    /(覚えて|思い出|何|なん|どれ|でしたっけ|\?|？)/.test(t)
  )
    return true;

  if (/(目標|抱負|方針)/.test(t) && isQuestionLike(t)) return true;

  return false;
}

function detectScopeFromQuery(q: string): RecallScope {
  const t = (q ?? '').trim();
  if (!t) return 'any';
  if (/(昨日|きのう|yesterday)/i.test(t)) return 'yesterday';
  if (/(今日|きょう|today)/i.test(t)) return 'today';
  if (/(先週|last week)/i.test(t)) return 'last_week';
  return 'any';
}

function getJstDateKey(d: Date): string {
  const ms = d.getTime() + 9 * 60 * 60 * 1000; // +09:00
  const j = new Date(ms);
  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, '0');
  const day = String(j.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isInScopeByCreatedAt(m: any, scope: RecallScope): boolean {
  if (scope === 'any') return true;

  const raw = m?.created_at ?? m?.createdAt ?? null;
  if (!raw) return true; // 判定不能は落とさない（互換）

  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return true;

  const todayKey = getJstDateKey(new Date());
  const msgKey = getJstDateKey(d);

  if (scope === 'today') return msgKey === todayKey;

  if (scope === 'yesterday') {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yKey = getJstDateKey(y);
    return msgKey === yKey;
  }

  if (scope === 'last_week') {
    const msgMs = d.getTime();
    const nowMs = Date.now();
    const diffDays = (nowMs - msgMs) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 7.5;
  }

  return true;
}

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
    '抱負',
    '豊富',
    '来年',
    '今年',
    '今日',
    '昨日',
    '先週',
    'iros',
    '完成',
    'URL',
    'リンク',
    'コード',
    'SQL',
    '関数',
    'ファイル',
    // ここに増やしてOK（話題系）
    'パワハラ',
  ];

  for (const p of presets) {
    if (cleaned.toLowerCase().includes(p.toLowerCase())) strong.push(p);
  }
  if (strong.includes('豊富') && !strong.includes('抱負')) strong.push('抱負');

  const stop =
    /^(さっき|この前|昨日|きのう|今日|きょう|先週|前|今さっき|先ほど|なんだっけ|何だっけ|どれだっけ|どの話|それ|あれ|覚えてる|思い出|覚えて|教えて)$/;

  const tokens = cleaned
    .split(' ')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2 && x.length <= 18)
    .filter((x) => !stop.test(x));

  const uniq: string[] = [];
  for (const x of [...strong, ...tokens]) {
    const k = x.toLowerCase();
    if (!uniq.some((u) => u.toLowerCase() === k)) uniq.push(x);
  }

  return uniq.slice(0, 8);
}

function pickRecallFromHistory(query: string, history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const qNorm = normalize(query);
  const keywords = extractRecallKeywords(query);
  const goalQuery = isGoalRecallQuery(query);
  const scope = detectScopeFromQuery(query);

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

  let best: { s: string; score: number } | null = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    if (getRole(m) !== 'user') continue;
    if (!isInScopeByCreatedAt(m, scope)) continue;

    const s = getText(m);
    if (!looksAllowed(s)) continue;

    let score = 0;

    const hasGoalWord = /(目標|抱負|方針|やりたいこと)/.test(s);
    const hasToday = /今日|今日は|きょう/.test(s);
    const hasYesterday = /昨日|きのう/.test(s);
    const hasYear = /来年|今年/.test(s);

    // goal クエリは “goalっぽい文” だけ
    if (goalQuery) {
      if (!hasGoalWord && !hasToday && !hasYesterday && !hasYear) continue;
      if (hasGoalWord) score += 8;
      if (hasToday) score += 4;
      if (hasYesterday) score += 4;
      if (hasYear) score += 3;
    }

    // キーワード一致
    for (const k of keywords) {
      if (k && s.toLowerCase().includes(k.toLowerCase())) score += 2;
    }

    if (/iros/i.test(s)) score += 1;
    if (/完成|ほぼ完成|仕上げ/.test(s)) score += 1;

    const pass = goalQuery ? score >= 6 : score > 0;
    if (!pass) continue;

    if (!best || score > best.score) best = { s, score };
  }

  return best?.s ?? null;
}

export function runGenericRecallGate(args: {
  text: string;
  history: any[];
}): GenericRecallGateResult {
  const { text, history } = args;

  if (!isGenericRecallQuestion(text)) return null;

  const recalled = pickRecallFromHistory(text, history);

  // ✅ ここが今回の修正ポイント：
  // 見つからないなら “recallモードにしない” で null を返す（通常応答へ）
  if (!recalled) return null;

  const goalQuery = isGoalRecallQuery(text);
  const scope = detectScopeFromQuery(text);

  const prefix =
    goalQuery && scope === 'yesterday'
      ? '昨日の目標は'
      : goalQuery && scope === 'today'
        ? '今日の目標は'
        : goalQuery
          ? '目標は'
          : '直近だと';

  return {
    recallKind: 'recall_from_history',
    recalledText: recalled,
    assistantText: goalQuery
      ? `${prefix}「${recalled}」です。🪔`
      : `${prefix}「${recalled}」が該当します。🪔`,
  };
}
