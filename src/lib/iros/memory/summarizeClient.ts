// src/lib/iros/memory/summarizeClient.ts
// iros — summarize client + topic helpers (safe, no-throw)
//
// NOTE:
// - buildTopicLineFromDigest / extractTopicKeywordsFromDigest は「必ず落ちない」最優先。
// - digest は object/string/unknown を想定（string は JSON っぽければ parse も試す）。
// - keywords は最大2語（デフォルト）。重要語が先頭に来やすいように、TOPIC_LINEも整形する。

export async function summarize(prevMini: string, userText: string, aiText: string): Promise<string> {
  const r = await fetch('/api/iros/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prevMini, userText, aiText }),
  });
  if (!r.ok) throw new Error('summarize_failed');
  const j = (await r.json()) as any;
  return String(j?.summary ?? '');
}

/** -------- Topic helpers (Phase1) -------- */

const MAX_TOPIC_LINE = 160;

function safeStringify(x: unknown): string {
  try {
    if (typeof x === 'string') return x;
    return JSON.stringify(x);
  } catch {
    // circular etc.
    try {
      return String(x);
    } catch {
      return '';
    }
  }
}

function safeJsonParseMaybe(s: string): unknown {
  const t = String(s ?? '').trim();
  if (!t) return s;
  // 超雑に JSON っぽいときだけ試す（落ちない）
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return s;
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

function pickStr(v: any): string {
  const s = String(v ?? '').trim();
  return s;
}

function clampLine(s: string, max = MAX_TOPIC_LINE): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function digTopicAndSummary(obj: any): { topic: string; summary: string } {
  // いくつかの候補キーを “安全に” たどる（undefined耐性）
  const topic =
    pickStr(obj?.topic?.situationTopic) ||
    pickStr(obj?.situationTopic) ||
    pickStr(obj?.ctxPack?.situationTopic) ||
    pickStr(obj?.unified?.situation?.topic) ||
    pickStr(obj?.situation?.topic) ||
    pickStr(obj?.topicDigest) ||
    pickStr(obj?.conversationLine) ||
    '';

  const summary =
    pickStr(obj?.topic?.situationSummary) ||
    pickStr(obj?.situationSummary) ||
    pickStr(obj?.ctxPack?.situationSummary) ||
    pickStr(obj?.unified?.situation?.summary) ||
    pickStr(obj?.situation?.summary) ||
    pickStr(obj?.summary) ||
    '';

  return { topic, summary };
}

function normalizeTopicLine(topic: string, summary: string): string {
  const t = String(topic ?? '').trim();
  const s = String(summary ?? '').trim();

  if (t && s) {
    // 重要語が落ちやすいので “topic を先頭固定”
    // 例：水星逆行の話（直近の焦点: 逆行の意味）
    const s2 =
      s.length > 0
        ? s.replace(/^\s*(?:その他|ライフ全般|全般|その他・ライフ全般)\s*[:：-]?\s*/g, '').trim()
        : '';
    const merged = s2 ? `${t}（直近の焦点: ${s2}）` : `${t}`;
    return clampLine(merged);
  }
  if (t) return clampLine(t);
  if (s) return clampLine(s);

  return '';
}

const STOPWORDS = new Set<string>([
  'その他',
  'ライフ',
  '全般',
  '話',
  'こと',
  '感じ',
  '意味',
  '確認',
  '質問',
  '例',
  'ありがとう',
  '今',
  'ここ',
  '状態',
  '流れ',
  '直近',
  '焦点',
  '相手',
  '都合',
  '目安',
  '一文',
  '送る',
  '返事',
  '件',
  '念のため',
]);

function scoreToken(tok: string): number {
  const t = String(tok ?? '').trim();
  if (!t) return -999;
  if (STOPWORDS.has(t)) return -999;

  let score = 0;

  // 長さ（短すぎるのは弱い）
  const L = t.length;
  if (L >= 2) score += 2;
  if (L >= 3) score += 2;
  if (L >= 4) score += 2;
  if (L >= 6) score += 1; // 長すぎは微増

  // 文字種
  if (/[一-龠々]/.test(t)) score += 4; // 漢字（固有っぽい）
  if (/[ァ-ヴー]/.test(t)) score += 3; // カタカナ
  if (/[A-Za-z]/.test(t)) score += 2; // 英字
  if (/[0-9]/.test(t)) score += 1; // 数字

  // 記号だけは落とす
  if (/^[^A-Za-z0-9一-龠々ァ-ヴー]+$/.test(t)) return -999;

  return score;
}

function extractTokens(text: string): string[] {
  const s = String(text ?? '');
  // 日本語（漢字連結/カタカナ/英字/数字）を拾う
  const re = /[一-龠々]{2,10}|[ァ-ヴー]{2,16}|[A-Za-z]{2,24}|[0-9]{2,12}/g;
  const m = s.match(re) ?? [];
  // 句読点っぽいのを落とす＆整形
  return m
    .map((x) => String(x).trim())
    .filter((x) => x.length >= 2)
    .filter((x) => !STOPWORDS.has(x));
}

/**
 * digest から「人間可読の1行」を返す（最大160 chars）。
 * - 重要語が先頭に来るよう topic->summary の順で組む。
 * - 最後のfallbackは JSON/head を切って使う。
 */
export function buildTopicLineFromDigest(digest: unknown): string | null {
  try {
    const raw = digest;
    const parsed = typeof raw === 'string' ? safeJsonParseMaybe(raw) : raw;

    // object として拾えるなら拾う
    const obj = (parsed && typeof parsed === 'object') ? (parsed as any) : null;

    if (obj) {
      const { topic, summary } = digTopicAndSummary(obj);
      const line = normalizeTopicLine(topic, summary);
      if (line) return line;

      // それでも無理なら “それっぽいキー” を雑に拾う
      const fallback =
        pickStr(obj?.topicDigest) ||
        pickStr(obj?.conversationLine) ||
        pickStr(obj?.ctxPack?.topicDigest) ||
        pickStr(obj?.ctxPack?.conversationLine) ||
        '';
      if (fallback) return clampLine(fallback);
    }

    // string のままでも、最低限短く
    const s = safeStringify(parsed);
    if (!s) return null;

    // JSON の頭はノイズになりやすいので、なるべく “中身の単語” が入るように軽く整形
    // ただし Phase1 は小さく：先頭だけカットして短くする
    const head = clampLine(s.replace(/\s+/g, ' ').trim(), MAX_TOPIC_LINE);
    return head || null;
  } catch {
    // 絶対落ちない
    const s = clampLine(safeStringify(digest), MAX_TOPIC_LINE);
    return s || null;
  }
}

/**
 * digest から keywords を最大 max 語返す。
 * - TOPIC_LINE から優先抽出 → 次に RAW(JSON stringified) から補助抽出
 * - “水星/逆行” のような核語が拾える確率を上げるため、漢字連結を優先
 */
export function extractTopicKeywordsFromDigest(digest: unknown, max = 2): string[] {
  try {
    const maxN = Math.max(0, Math.min(5, Number.isFinite(max) ? (max as number) : 2)) || 2;

    const topicLine = buildTopicLineFromDigest(digest) ?? '';
    const rawStr = safeStringify(typeof digest === 'string' ? safeJsonParseMaybe(digest) : digest);

    const tokens1 = extractTokens(topicLine);
    const tokens2 = extractTokens(rawStr);

    // スコアリング：topicLine を優先（同じ語でも topicLine を上位に）
    const scoreMap = new Map<string, number>();

    const add = (tok: string, bonus: number) => {
      const t = String(tok ?? '').trim();
      if (!t) return;
      const base = scoreToken(t);
      if (base < 0) return;
      const prev = scoreMap.get(t) ?? -999;
      scoreMap.set(t, Math.max(prev, base + bonus));
    };

    for (const t of tokens1) add(t, 5);
    for (const t of tokens2) add(t, 1);

    const ranked = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0]);

    // 最終整形：重複/stopwords 排除、長すぎ短すぎカット
    const out: string[] = [];
    for (const k of ranked) {
      const kk = String(k ?? '').trim();
      if (!kk) continue;
      if (STOPWORDS.has(kk)) continue;
      if (kk.length < 2) continue;
      if (kk.length > 18) continue;
      if (out.includes(kk)) continue;
      out.push(kk);
      if (out.length >= maxN) break;
    }

    return out.slice(0, maxN);
  } catch {
    return [];
  }
}
