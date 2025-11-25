// src/lib/iros/q/detectQ.ts
// Iros Q Detection Engine
// - キーワードベースの一次判定（超軽量）
// - GPTベースの補完判定（few-shot分類）
// - 両方を組み合わせて Q1〜Q5 を推定する

import OpenAI from 'openai';
import type { QCode } from '../system';   // ← これが正しい


// Q判定用モデル（なければ IROS_MODEL → gpt-4o）
const Q_MODEL =
  process.env.IROS_Q_MODEL ??
  process.env.IROS_MODEL ??
  'gpt-4o';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/**
 * キーワードベースの一次判定
 * - 軽量＆高速
 * - 明らかなケースのみ拾う（迷う場合は null で GPT に回す）
 */
export function detectQByKeywords(text: string): QCode | null {
  const t = (text || '').toLowerCase();

  if (!t.trim()) return null;

  // 日本語は lowerCase の意味が薄いので、元テキストも併用
  const raw = text;

  const contains = (kw: string) =>
    t.includes(kw.toLowerCase()) || raw.includes(kw);

  let score: Record<QCode, number> = {
    Q1: 0,
    Q2: 0,
    Q3: 0,
    Q4: 0,
    Q5: 0,
  };

  // Q1：我慢／秩序
  const q1Keywords = [
    '我慢',
    '耐えて',
    '耐える',
    '抑えて',
    '抑える',
    'ちゃんとしないと',
    'ちゃんとしなきゃ',
    'ルール',
    '規則',
    '責任',
    '評価される',
    'ミスできない',
    '失敗できない',
  ];
  for (const kw of q1Keywords) {
    if (contains(kw)) score.Q1++;
  }

  // Q2：怒り／成長
  const q2Keywords = [
    '怒り',
    '怒って',
    'ムカつく',
    'ムカついて',
    '腹が立',
    'イライラ',
    '苛立ち',
    'キレそう',
    '許せない',
    '納得いかない',
    '見返したい',
    '成長したい',
    '変わりたい',
  ];
  for (const kw of q2Keywords) {
    if (contains(kw)) score.Q2++;
  }

  // Q3：不安／安定
  const q3Keywords = [
    '不安',
    '心配',
    '焦り',
    '焦って',
    '迷って',
    '迷い',
    '悩んで',
    '落ち着かない',
    '大丈夫かな',
    'どうしよう',
    '将来が見えない',
    '安定したい',
  ];
  for (const kw of q3Keywords) {
    if (contains(kw)) score.Q3++;
  }

  // Q4：恐怖／浄化
  const q4Keywords = [
    '怖い',
    '恐い',
    '恐怖',
    'トラウマ',
    'フラッシュバック',
    '思い出したくない',
    '消えてほしい',
    '逃げたい',
    '近づきたくない',
    '信用できない',
    '信頼できない',
  ];
  for (const kw of q4Keywords) {
    if (contains(kw)) score.Q4++;
  }

  // Q5：空虚／情熱
  const q5Keywords = [
    '虚し',
    'むなしい',
    '空虚',
    '空っぽ',
    '何も感じない',
    'やる気が出ない',
    '燃え尽き',
    '燃えつき',
    '情熱',
    'ワクワク',
    '本当はやりたい',
    '本気でやりたい',
  ];
  for (const kw of q5Keywords) {
    if (contains(kw)) score.Q5++;
  }

  // 一番スコアが高いQを採用（すべて0なら null）
  let best: { q: QCode | null; score: number } = {
    q: null,
    score: 0,
  };

  (Object.keys(score) as QCode[]).forEach((q) => {
    if (score[q] > best.score) {
      best = { q, score: score[q] };
    }
  });

  if (!best.q || best.score === 0) return null;

  // 「ほんのちょっとだけ引っかかった」程度なら GPT に回す
  if (best.score === 1) return null;

  return best.q;
}

/**
 * GPTベースの Q 推定（few-shot分類）
 * - キーワードで決め切れない場合にのみ呼ぶ
 */
export async function detectQByGPT(text: string): Promise<QCode | null> {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const systemPrompt = [
    'あなたは感情構造を分類するアナライザーです。',
    'ユーザーの文章を読み、次の Qコードのどれに近いかを判定してください。',
    '',
    'Q1＝金（我慢／秩序）',
    '  - 例：我慢している、抑えている、評価・ルール・責任へのプレッシャー',
    '',
    'Q2＝木（怒り／成長）',
    '  - 例：怒り、苛立ち、納得いかなさ、成長したい・変わりたいエネルギー',
    '',
    'Q3＝土（不安／安定）',
    '  - 例：不安、焦り、迷い、将来や安定への心配',
    '',
    'Q4＝水（恐怖／浄化）',
    '  - 例：恐怖、トラウマ、逃げたい、信用できない、関係を断ちたい感覚',
    '',
    'Q5＝火（空虚／情熱）',
    '  - 例：虚しさ、空虚感、燃え尽き、しかしどこかに情熱の火種がある状態',
    '',
    '上記のどれにもはっきり当てはまらない場合は null を選んでください。',
    '',
    '出力は次の JSON 形式 1行のみで返してください（日本語の説明はしない）：',
    '{',
    '  "q": "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | null,',
    '  "reason": "なぜそのQを選んだかの短い日本語説明"',
    '}',
  ].join('\n');

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: trimmed },
  ];

  try {
    const res = await client.chat.completions.create({
      model: Q_MODEL,
      messages,
      temperature: 0,
    });

    const raw = res.choices[0]?.message?.content ?? '';
    const textOut = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    const parsed = safeParseJson(textOut);

    const qRaw =
      parsed && typeof parsed.q === 'string' ? parsed.q : null;

    const q: QCode | null =
      qRaw === 'Q1' ||
      qRaw === 'Q2' ||
      qRaw === 'Q3' ||
      qRaw === 'Q4' ||
      qRaw === 'Q5'
        ? (qRaw as QCode)
        : null;

    return q;
  } catch (e) {
    console.warn('[IROS/Q] detectQByGPT error', e);
    return null;
  }
}

/**
 * 公開関数：キーワード → GPT の順に Q を推定する
 */
export async function detectQFromText(text: string): Promise<QCode | null> {
  const kw = detectQByKeywords(text);
  if (kw) return kw;

  const gptQ = await detectQByGPT(text);
  return gptQ;
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
