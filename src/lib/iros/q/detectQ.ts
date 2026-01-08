// src/lib/iros/q/detectQ.ts
// iros — Q Detection Engine
// - 概念シグナル（方向性/関連）ベースの一次判定（超軽量）
// - LLMベースの補完判定（few-shot分類）
// - （追加）Tシグナル（Transcend）を「フラグ」として併走（Qとは別軸）
// - Q は Q1〜Q5 を返す / T は boolean で返す（必要なら別APIで利用）
//
// 方針：OpenAI直叩きは禁止。chatComplete（単一出口）を使う。

import type { QCode } from '../system';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

// Q判定用モデル（なければ IROS_MODEL → gpt-4o）
const Q_MODEL = process.env.IROS_Q_MODEL ?? process.env.IROS_MODEL ?? 'gpt-4o';

export type QTDetectResult = {
  q: QCode | null;
  t: boolean; // T層シグナル（Qとは別軸）
  reason?: string | null;
};

/**
 * 方向性（関連）を拾うため：概念シグナル中心の正規表現ベース
 * - 誤爆を避けるため「弱い単発」は決めない（null → LLMへ）
 */
export function detectQByKeywords(text: string): QCode | null {
  const raw = (text || '').trim();
  if (!raw) return null;

  // 方向性（関連）を拾うため：概念シグナル中心
  const score: Record<QCode, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
    Q5: 0,
  };

  const add = (q: QCode, n: number) => {
    score[q] += n;
  };

  // 「ヒット数」を安全に数える（gフラグを強制してブレを消す）
  const countMatches = (patterns: RegExp[]) => {
    let c = 0;
    for (const p of patterns) {
      const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
      const re = new RegExp(p.source, flags);
      const m = raw.match(re);
      c += m ? m.length : 0;
    }
    return c;
  };

  // ----------------------------
  // Q1：我慢／秩序（義務・評価・抑制の“圧”）
  // ----------------------------
  add(
    'Q1',
    countMatches([
      /(しなきゃ|しないと|ねば|べき|義務|責任|ルール|規則|正しく|きちんと|ちゃんと)/,
      /(評価|査定|怒られ|叱られ|ミスできない|失敗できない|迷惑かけられない)/,
      /(抑え|我慢|耐え|堪え|飲み込ん)/,
    ]) * 2,
  );

  // ----------------------------
  // Q2：怒り／成長（侵害・理不尽・境界反応＋変化の推進力）
  // ----------------------------
  add(
    'Q2',
    countMatches([
      /(ムカ|腹が立|イライラ|苛立|キレそう|怒)/,
      /(許せない|納得いかない|理不尽|筋が通らない|舐められ|軽く見られ)/,
      /(見返したい|取り戻したい|変えたい|変わりたい|改善|成長|強くなりたい)/,
    ]) * 2,
  );

  // ----------------------------
  // Q3：不安／安定（不確実・迷い・決められなさ＝“揺れ”）
  // ※「怖い」はQ4寄りなので、Q3では“不安文脈”に限定して拾う
  // ----------------------------
  add(
    'Q3',
    countMatches([
      /(不安|心配|焦|落ち着かない|そわそわ)/,
      /(どうしよう|大丈夫かな|迷|悩)/,
      /(決められない|わからない|先が見えない|将来|安定)/,
      /(不安で.*怖|心配で.*怖)/,
    ]) * 2,
  );

  // ----------------------------
  // Q4：恐怖／浄化（危険回避・身体反応・トラウマ＝“回避”）
  // ----------------------------
  add(
    'Q4',
    countMatches([
      /(怖い|恐い|恐怖|不気味|震え|鳥肌)/,
      /(逃げたい|避けたい|近づけない|無理|拒否反応|身構え)/,
      /(トラウマ|フラッシュバック|思い出したくない|信用できない|信頼できない)/,
      // 身体反応シグナル（方向性）
      /(足がすくむ|息が(できない|苦しい)|動けない|心臓が(痛い|苦しい)|過呼吸|吐き気)/,
    ]) * 2,
  );

  // ----------------------------
  // Q5：空虚／情熱（虚無・燃え尽き・意味喪失＋火種）
  // ----------------------------
  add(
    'Q5',
    countMatches([
      /(虚し|むなしい|空虚|空っぽ|意味がない|無意味|無価値)/,
      /(燃え尽き|燃えつき|やる気が出ない|何も感じない|感情が(ない|死んでる))/,
      /(喜び|歓喜|うれし|喜ぶ|情熱|意図|使命).*(湧かない|湧いてこない|出ない|感じない|ない)/,
      /(燃え(てい)?ない|燃えては?いない|燃えない|熱が(ない|戻らない)|火が(つかない|戻らない))/,
      /(虚無|無感情|感情が動かない|心が動かない)/,
      // 火種（情熱側）
      /(情熱|ワクワク|本当はやりたい|本気でやりたい|やり直したい|熱が戻る)/,
    ]) * 2,
  );

  // ----------------------------
  // 弱い単発は「決めない」：LLMに回す
  // ----------------------------
  const entries = (Object.keys(score) as QCode[]).map((q) => ({
    q,
    s: score[q],
  }));
  entries.sort((a, b) => b.s - a.s);

  const best = entries[0];
  const second = entries[1];

  if (!best || best.s <= 0) return null;

  // 閾値：弱いときは null（LLMへ）
  if (best.s < 4) return null;

  // 競ってるときも null（LLMへ）
  if (second && best.s - second.s <= 1) return null;

  return best.q;
}

/**
 * Tシグナル（Transcend）を軽量検出（Qとは別軸）
 * - “意図”や“真理”などの単語だけでTにしない（誤爆が多い）
 * - 「現実を超える視点／大局／普遍／静けさ／統合／本質」など “方向性” を複合で拾う
 */
export function detectTBySignals(text: string): boolean {
  const raw = (text || '').trim();
  if (!raw) return false;

  const score = (() => {
    const patterns: RegExp[] = [
      // 視点の上昇 / 俯瞰
      /(俯瞰|大局|全体像|視座|高い視点|メタ視点|構造で見る|俯瞰して)/,
      // 本質 / 真理 / 普遍
      /(本質|真理|普遍|原理|根源|宇宙|存在|意図の源|北極星|太陽SUN)/,
      // 統合 / 再統合 / 超越
      /(統合|再統合|超越|手放す|溶ける|境界が薄い|一致|一致する)/,
      // 静けさ / 余白 / 祈りっぽい語感（※宗教断定はしない）
      /(静けさ|余白|祈り|沈黙|ただ在る|響き|フィールド|共鳴)/,
      // 時間軸の跳躍
      /(時間を超|過去を超|未来から|時間軸|次元|トランス|T層)/,
    ];

    let c = 0;
    for (const p of patterns) {
      const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
      const re = new RegExp(p.source, flags);
      const m = raw.match(re);
      c += m ? m.length : 0;
    }
    return c;
  })();

  // 弱い単発はTにしない（誤爆回避）
  return score >= 2;
}

/**
 * LLMベースの Q 推定（few-shot分類）
 * - キーワードで決め切れない場合にのみ呼ぶ
 */
export async function detectQByGPT(text: string): Promise<QCode | null> {
  const r = await detectQTByGPT(text);
  return r.q;
}

/**
 * LLMベースの Q + T 推定（few-shot分類）
 * - Qが曖昧な時に「方向性で」補完
 * - Tは boolean（Qとは独立）
 */
export async function detectQTByGPT(text: string): Promise<QTDetectResult> {
  const trimmed = (text || '').trim();
  if (!trimmed) return { q: null, t: false, reason: null };

  const systemPrompt = [
    'あなたは「意識の方向性」を読むアナライザーです。',
    'ユーザーの文章を読み、次の Qコード（Q1〜Q5）と、Tシグナル（transcend: true/false）を判定してください。',
    '',
    'Q1＝金（我慢／秩序）',
    '  - 義務・責任・評価・ルール・抑制の圧',
    '',
    'Q2＝木（怒り／成長）',
    '  - 侵害/理不尽への反応、境界反応、変えたい・改善・成長の推進力',
    '',
    'Q3＝土（不安／安定）',
    '  - 不確実さ、迷い、決められない、安定の必要',
    '',
    'Q4＝水（恐怖／浄化）',
    '  - 危険回避、トラウマ、拒否反応、身体反応（足がすくむ/息が苦しい等）',
    '',
    'Q5＝火（空虚／情熱）',
    '  - 虚無・意味喪失・燃え尽き、ただし火種（やりたい/ワクワク）が残る',
    '',
    'T（transcend）= true となるのは、Qとは別に、次のような「視座の上昇/統合/本質」方向が明確なときです：',
    '  - 大局/俯瞰/構造/普遍/本質/統合/静けさ/時間軸の跳躍 など',
    '  - 単語だけでなく「方向性」が見える場合に true にしてください。',
    '',
    'どれにもはっきり当てはまらない場合は q を null にしてください。',
    '',
    '出力は次の JSON 形式 1行のみ（日本語の説明は他に書かない）：',
    '{',
    '  "q": "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | null,',
    '  "t": true | false,',
    '  "reason": "短い日本語（30字以内）"',
    '}',
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: trimmed },
  ];

  try {
    const rawText = await chatComplete({
      purpose: 'judge',
      model: Q_MODEL,
      temperature: 0,
      messages,
      responseFormat: { type: 'json_object' },
    });

    const textOut = String(rawText ?? '').trim();
    const parsed = safeParseJson(textOut);

    const qRaw = parsed && typeof parsed.q === 'string' ? parsed.q : null;
    const tRaw = parsed && typeof parsed.t === 'boolean' ? parsed.t : null;
    const reason = parsed && typeof parsed.reason === 'string' ? parsed.reason : null;

    const q: QCode | null =
      qRaw === 'Q1' || qRaw === 'Q2' || qRaw === 'Q3' || qRaw === 'Q4' || qRaw === 'Q5'
        ? (qRaw as QCode)
        : null;

    // Tは「軽量シグナル」も併用（LLMの誤爆/過小評価を補正）
    const tBySignals = detectTBySignals(trimmed);
    const t = Boolean((tRaw ?? false) || tBySignals);

    return { q, t, reason };
  } catch (e) {
    console.warn('[IROS/Q] detectQTByGPT error', e);
    // LLM失敗時もTは軽量で拾える
    return { q: null, t: detectTBySignals(trimmed), reason: null };
  }
}

/**
 * 公開関数：概念シグナル（軽量）→ LLM の順に Q を推定する
 */
export async function detectQFromText(text: string): Promise<QCode | null> {
  const kw = detectQByKeywords(text);
  if (kw) return kw;

  const gptQ = await detectQByGPT(text);
  return gptQ;
}

/**
 * 公開関数：概念シグナル（軽量）→ LLM の順に Q と T を推定する
 * - Qは null のままでもOK（後段の continuity / stabilize に任せる）
 * - Tは「方向性」フラグとして利用可能
 */
export async function detectQTFromText(text: string): Promise<QTDetectResult> {
  const qByKw = detectQByKeywords(text);
  const tBySig = detectTBySignals(text);

  // Qが決まった場合でも、Tは別軸で返す（false固定にしない）
  if (qByKw) {
    return { q: qByKw, t: tBySig, reason: 'kw:concept-signals' };
  }

  const gpt = await detectQTByGPT(text);
  // LLM結果に軽量Tを重ねる（detectQTByGPT側でもやるが保険）
  return { ...gpt, t: Boolean(gpt.t || tBySig) };
}

/**
 * LLMの出力から JSON を安全に取り出すヘルパー。
 */
function safeParseJson(text: string): any | null {
  if (!text) return null;

  const trimmed = text.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}
