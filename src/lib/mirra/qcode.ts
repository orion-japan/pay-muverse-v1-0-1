// src/lib/mirra/qcode.ts
import OpenAI from 'openai';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type QResult = { q: QCode; confidence: number; hint?: string; color_hex?: string };

const HAS_API = !!process.env.OPENAI_API_KEY;
const client = HAS_API ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }) : null;

/** キーワード簡易ヒューリスティック */
const keywordHeuristics: Record<QCode, string[]> = {
  // Q1: 金＝我慢/秩序
  Q1: [
    '我慢',
    '抑える',
    '秩序',
    '整える',
    '詰まる',
    '締め',
    '評価',
    '正しさ',
    '手順',
    'ルール',
    '期限',
    '守る',
  ],
  // Q2: 木＝怒り/成長
  Q2: [
    '怒',
    '苛立',
    '攻め',
    '急ぐ',
    '前へ',
    '突破',
    '焦り',
    'せか',
    'イライラ',
    '妨げ',
    '阻害',
    '挑戦',
    '叱ら',
  ],
  // Q3: 土＝不安/安定
  Q3: [
    '不安',
    '心配',
    '迷い',
    '停滞',
    '重い',
    '安定',
    '疲れ',
    '眠れ',
    '落ち着か',
    'ため息',
    '居場所',
    'ぐらつき',
  ],
  // Q4: 水＝恐怖/浄化
  Q4: [
    '恐れ',
    '怖',
    '萎縮',
    '引く',
    '冷える',
    '静か',
    '孤独',
    '消えたい',
    '圧',
    '威圧',
    '緊張',
    '怯え',
  ],
  // Q5: 火＝情熱/空虚
  Q5: [
    '情熱',
    'ワクワク',
    '空虚',
    '燃える',
    'やりたい',
    '開く',
    '楽しい',
    '嬉しい',
    '光',
    '高揚',
    'やる気',
  ],
};

/** シンプル色（UIタグ用） */
const simpleQColor: Record<QCode, string> = {
  Q1: '#B0BEC5', // gray
  Q2: '#9CCC65', // green
  Q3: '#FFD54F', // amber
  Q4: '#64B5F6', // blue
  Q5: '#FF8A65', // orange
};

function heuristic(text: string): { q: QCode; score: number } {
  const t = (text || '').toLowerCase();
  let best: QCode = 'Q3';
  let score = 0;
  (Object.keys(keywordHeuristics) as QCode[]).forEach((q) => {
    const s = keywordHeuristics[q].reduce(
      (acc, k) => (t.includes(k.toLowerCase()) ? acc + 1 : acc),
      0,
    );
    if (s > score) {
      best = q;
      score = s;
    }
  });
  return { q: best, score };
}

/**
 * 入力テキストから Qコードを推定（まずヒューリスティック、弱い時のみAPIにフォールバック）
 */
export async function inferQCode(userText: string): Promise<QResult> {
  const h = heuristic(userText);

  // ある程度ヒットがあるなら即採用（軽量・高速）
  if (h.score >= 2) {
    return {
      q: h.q,
      confidence: Math.min(0.6 + 0.1 * h.score, 0.9),
      color_hex: simpleQColor[h.q],
    };
  }

  // APIキーが無ければヒューリスティック結果で返す
  if (!HAS_API || !client) {
    return { q: h.q, confidence: 0.55, color_hex: simpleQColor[h.q] };
  }

  // LLMでの簡易分類（JSON出力）
  try {
    const prompt = `
次のテキストから最も近い「Qコード」を1つだけ選び、"Q1"〜"Q5"で返してください。
- Q1: 我慢・秩序・抑制・評価への反応
- Q2: 怒り・苛立ち・突破したい衝動
- Q3: 不安・迷い・安定の希求・停滞感
- Q4: 恐れ・萎縮・引き気味・冷え・孤独感
- Q5: 情熱・高揚・空虚を埋めたい・開きたい
出力はJSONのみ：
{"q":"Qn","confidence":0.x,"hint":"短い説明"}
`.trim();

    const r = await client.chat.completions.create({
      model: 'gpt-5-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a concise classifier. Reply JSON only.' },
        { role: 'user', content: prompt + `\n\nテキスト:\n${userText}` },
      ],
      response_format: { type: 'json_object' } as any,
    });

    const raw = r.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { q?: string; confidence?: number; hint?: string };

    const q = (['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].includes(parsed.q || '') ? parsed.q : h.q) as QCode;

    return {
      q,
      confidence: Math.max(0.5, Math.min(0.99, parsed.confidence ?? 0.6)),
      hint: parsed.hint,
      color_hex: simpleQColor[q],
    };
  } catch {
    // 失敗時はヒューリスティック
    return { q: h.q, confidence: 0.55, color_hex: simpleQColor[h.q] };
  }
}
