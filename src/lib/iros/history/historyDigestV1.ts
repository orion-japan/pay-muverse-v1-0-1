// src/lib/iros/history/historyDigestV1.ts
// iros — HistoryDigest v1 (single place builder + injector)

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type Phase = 'Inner' | 'Outer';

export type HistoryDigestV1 = {
  anchor: { key: string; phrase: string };
  state: { q: QCode; depth: string; phase: Phase };
  topic: { situationTopic: string; situationSummary: string };
  continuity: {
    last_user_core: string;
    last_assistant_core: string;
    repeat_signal: boolean;
  };
};

export type BuildHistoryDigestV1Args = {
  // anchor priority: fixedNorth > metaForSave.intent_anchor_key > memoryState.intentAnchor
  fixedNorth?: { key: string; phrase?: string } | null;

  metaAnchorKey?: string | null; // metaForSave.intent_anchor_key など
  memoryAnchorKey?: string | null; // memoryState.intentAnchor など

  qPrimary: QCode;
  depthStage: string;
  phase: Phase;

  situationTopic: string;
  situationSummary: string;

  lastUserCore: string;
  lastAssistantCore: string;
  repeatSignal: boolean;
};

function pickAnchor(args: BuildHistoryDigestV1Args): { key: string; phrase: string } {
  const key = args.fixedNorth?.key || args.metaAnchorKey || args.memoryAnchorKey || 'SUN';

  // phrase は固定でOK（v1 なのでブレさせない）
  const phrase = args.fixedNorth?.phrase || '成長 / 進化 / 希望 / 歓喜';
  return { key, phrase };
}
export function buildHistoryDigestV1(args: BuildHistoryDigestV1Args): HistoryDigestV1 {
  return {
    anchor: pickAnchor(args),
    state: { q: args.qPrimary, depth: args.depthStage, phase: args.phase },
    topic: { situationTopic: args.situationTopic, situationSummary: args.situationSummary },
    continuity: {
      last_user_core: args.lastUserCore,
      last_assistant_core: args.lastAssistantCore,
      repeat_signal: args.repeatSignal,
    },
  };
}
export function injectHistoryDigestV1(params: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  digest: HistoryDigestV1;
}) {
  const isNoise = (s: string) => {
    const t = String(s ?? '').trim();
    if (!t) return true;

    if (t.includes('[HISTORY_DIGEST_V1]')) return true;
    if (t.includes('STATE_CUES (DO NOT OUTPUT)')) return true;
    if (t.includes('DO NOT OUTPUT')) return true;

    if (/^@\w+/.test(t)) return true;
    if (t.includes('"kind":"auto_fill"')) return true;

    return false;
  };

  const pickLastByRole = (role: 'user' | 'assistant') => {
    for (let i = params.messages.length - 1; i >= 0; i--) {
      const m = params.messages[i];
      if (!m) continue;
      if (m.role !== role) continue;
      const c = String(m.content ?? '').trim();
      if (!c) continue;
      if (isNoise(c)) continue;
      return c;
    }
    return '';
  };

  const d0: any = params.digest as any;

  const lastUserCore0 = String(d0?.continuity?.last_user_core ?? '').trim();
  const lastAssistantCore0 = String(d0?.continuity?.last_assistant_core ?? '').trim();

  const last_user_core = lastUserCore0 || pickLastByRole('user');
  const last_assistant_core = lastAssistantCore0 || pickLastByRole('assistant');
  const repeat_signal = Boolean(d0?.continuity?.repeat_signal ?? false);

  const nextDigest: HistoryDigestV1 = {
    ...(params.digest as any),
    continuity: {
      ...(params.digest as any)?.continuity,
      last_user_core: String(last_user_core ?? '').slice(0, 220),
      last_assistant_core: String(last_assistant_core ?? '').slice(0, 220),
      repeat_signal,
    },
  };

  const digestText = '[HISTORY_DIGEST_V1]\n' + JSON.stringify(nextDigest);

  const hasAlready = params.messages.some(
    (m) => m.role === 'system' && String(m.content ?? '').includes('[HISTORY_DIGEST_V1]\n'),
  );
  if (hasAlready) {
    return {
      messages: params.messages,
      digest: nextDigest,
      digestChars: digestText.length,
      injected: false,
    };
  }

  const out = [...params.messages];

  const firstSystemIdx = out.findIndex((m) => m.role === 'system');
  if (firstSystemIdx >= 0) {
    const prev = String(out[firstSystemIdx]?.content ?? '');
    const merged = [prev, digestText].filter((s) => String(s).trim().length > 0).join('\n\n');
    out[firstSystemIdx] = { role: 'system', content: merged };
    return { messages: out, digest: nextDigest, digestChars: digestText.length, injected: true };
  }

  out.unshift({ role: 'system', content: digestText });
  return { messages: out, digest: nextDigest, digestChars: digestText.length, injected: true };
}
// =============================================
// NEW: topic line + keywords (for STATE_CUES)
// =============================================

function clampOneLine(s: string, max = 140): string {
  const one = String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!one) return '';
  return one.length > max ? one.slice(0, max) : one;
}

function collectTextForKeywords(d: HistoryDigestV1): string {
  return [
    d?.topic?.situationSummary,
    d?.topic?.situationTopic,
    d?.continuity?.last_user_core,
    d?.continuity?.last_assistant_core,
  ]
    .map((x) => clampOneLine(String(x ?? ''), 240))
    .filter((x) => x)
    .join(' / ');
}

/**
 * できるだけ「固有っぽい語」を拾うための超軽量キーワード抽出（最大2語）
 * - 日本語/英数の連続トークン（2文字以上）を候補化
 * - ストップ語を除外
 * - 出現回数 → 長さ の順で上位を返す
 */
export function extractKeywordsV1(digest: HistoryDigestV1 | null | undefined, max = 2): string[] {
  if (!digest || max <= 0) return [];

  // 重要語が出やすい順に “場” を分けて評価する（topic/summary 由来の語を先頭に出す）
  const sSummary = clampOneLine(String(digest.topic?.situationSummary ?? ''), 240);
  const sTopic = clampOneLine(String(digest.topic?.situationTopic ?? ''), 240);
  const sLastUser = clampOneLine(String(digest.continuity?.last_user_core ?? ''), 240);
  const sLastAsst = clampOneLine(String(digest.continuity?.last_assistant_core ?? ''), 240);

  const textAll = [sSummary, sTopic, sLastUser, sLastAsst].filter(Boolean).join(' / ');
  if (!textAll) return [];

  // ここは “強めに” 止める：topic分類語に吸われる事故を潰す
  const stop = new Set<string>([
    // generic jp
    'これ', 'それ', 'あれ', 'ここ', 'そこ', 'もの', 'こと', '感じ', '今日', '最近', '今',
    '自分', 'あなた', '私', 'ですね', 'ます', 'する', 'した', 'して', 'いる', 'ある', 'なる',
    'ため', '的', '話', '質問',
    // topic分類/雑音
    'その他', 'ライフ', '全般', 'ライフ全般', 'その他・ライフ全般', 'その他ライフ全般',
    '確認', '念のため', '目安', '相手', '状況', '都合', '件',
    // UIっぽい語
    '入力', '入力なし', '（入力なし）', 'null', 'undefined',
  ]);

  // 日本語（漢字/ひらがな/カタカナ）+ 英数の連続
  const re = /[A-Za-z0-9]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu;

  type Hit = { count: number; score: number; };
  const hits = new Map<string, Hit>();

  const addToken = (raw0: string, srcBoost: number) => {
    const raw = String(raw0 ?? '').trim();
    if (!raw) return;
    if (raw.length <= 1) return;
    if (stop.has(raw)) return;

    // 記号だらけ/数字だけっぽいのは弱い
    const onlyNum = /^[0-9]+$/.test(raw);
    if (onlyNum) return;

    const cur = hits.get(raw) ?? { count: 0, score: 0 };

    // base: 出現回数
    cur.count += 1;

    // score: “どこ由来か”を最優先にする（summary/last_user を先頭に出す）
    // - summary / last_user_core は核に近いので強く
    // - topic は中くらい
    // - last_assistant_core は補助（弱く）
    cur.score += srcBoost;

    // 固有っぽい語を少しだけ優遇（長い=強い、ただし topic分類語は stop で落とす）
    cur.score += Math.min(3, Math.floor(raw.length / 2));

    // カタカナを含む（プロダクト名/固有名詞になりやすい）を少し優遇
    if (/[\p{Script=Katakana}]/u.test(raw)) cur.score += 2;

    hits.set(raw, cur);
  };

  // srcBoost の強さ：summary(6) > last_user(5) > topic(3) > last_assistant(1)
  for (const m of sSummary.matchAll(re)) addToken(String(m[0] ?? ''), 6);
  for (const m of sLastUser.matchAll(re)) addToken(String(m[0] ?? ''), 5);
  for (const m of sTopic.matchAll(re)) addToken(String(m[0] ?? ''), 3);
  for (const m of sLastAsst.matchAll(re)) addToken(String(m[0] ?? ''), 1);

  const ranked = Array.from(hits.entries())
    .sort((a, b) => {
      const A = a[1], B = b[1];
      // score desc（由来優先）
      if (B.score !== A.score) return B.score - A.score;
      // count desc
      if (B.count !== A.count) return B.count - A.count;
      // length desc
      if (b[0].length !== a[0].length) return b[0].length - a[0].length;
      // lex asc
      return a[0].localeCompare(b[0]);
    })
    .map(([k]) => k)
    // 最終安全：stop語が漏れてもここで落とす
    .filter((k) => k && !stop.has(k));

  return ranked.slice(0, max);
}
/**
 * “話題核が落ちない”ための1行（先頭にkeywordsを置く）
 * 例: 「水星 / 逆行 — いま: 逆行の意味を確認」
 */
export function buildTopicLineV1(digest: HistoryDigestV1 | null | undefined): string | null {
  if (!digest) return null;

  const kws = extractKeywordsV1(digest, 2);
  const head = kws.length > 0 ? kws.join(' / ') : null;

  const summary = clampOneLine(String(digest.topic?.situationSummary ?? ''), 120);
  const topic = clampOneLine(String(digest.topic?.situationTopic ?? ''), 60);

  // last_user_core が短く強い時は優先して載せる（“何の話？”対策）
  const lastUser = clampOneLine(String(digest.continuity?.last_user_core ?? ''), 80);

  const tailParts: string[] = [];
  if (lastUser) tailParts.push(`いま: ${lastUser}`);
  else if (summary) tailParts.push(summary);
  else if (topic) tailParts.push(topic);

  const tail = tailParts.join(' / ').trim();

  if (head && tail) return `${head} — ${tail}`;
  if (head) return head;
  if (tail) return tail;

  // 最終fallback：topic/stateから最低限
  const q = String(digest.state?.q ?? '');
  const depth = String(digest.state?.depth ?? '');
  const ph = String(digest.state?.phase ?? '');
  const fallback = clampOneLine([topic, summary].filter(Boolean).join(' / '), 120);
  return fallback || clampOneLine(`q=${q} depth=${depth} phase=${ph}`, 120);
}
