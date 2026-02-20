import OpenAI from 'openai';
import { QCode, QResult } from './types';

const COLOR: Record<QCode, string> = {
  Q1: '#B0BEC5',
  Q2: '#9CCC65',
  Q3: '#FFD54F',
  Q4: '#64B5F6',
  Q5: '#FF8A65',
};

const LEX: Record<QCode, string[]> = {
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
    '期限',
    'ルール',
  ],
  Q2: ['怒', '苛立', '攻め', '急ぐ', '前へ', '突破', '焦り', 'せか', 'イライラ', '挑戦', '阻害'],
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
  ],
  Q4: ['恐れ', '怖', '萎縮', '引く', '冷える', '静か', '孤独', '消えたい', '圧', '威圧', '緊張'],
  Q5: ['情熱', 'ワクワク', '空虚', '燃える', 'やりたい', '開く', '楽しい', '嬉しい', '光', '高揚'],
};

function heuristic(text: string): { code: QCode; score: number; hint: string } {
  const t = (text || '').toLowerCase();
  let best: QCode = 'Q3';
  let score = 0;
  (Object.keys(LEX) as QCode[]).forEach((q) => {
    const s = LEX[q].reduce((acc, k) => (t.includes(k.toLowerCase()) ? acc + 1 : acc), 0);
    if (s > score) {
      best = q;
      score = s;
    }
  });
  const hintMap: Record<QCode, string> = {
    Q1: '秩序/境界',
    Q2: '怒り・突破',
    Q3: '不安・安定',
    Q4: '恐れ・萎縮',
    Q5: '情熱・空虚',
  };
  return { code: best, score, hint: hintMap[best] };
}

export async function inferQCode(text: string): Promise<QResult> {
  const HAS_API = !!process.env.OPENAI_API_KEY;
  const h = heuristic(text);
  if (h.score >= 2 || !HAS_API) {
    return {
      code: h.code,
      confidence: Math.min(0.6 + 0.1 * h.score, 0.9),
      hint: h.hint,
      color_hex: COLOR[h.code],
    };
  }
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const prompt = `
次のテキストから最も近いQコードを1つだけ選び、JSONで返して下さい。
- Q1: 我慢・秩序
- Q2: 怒り・突破
- Q3: 不安・安定
- Q4: 恐れ・萎縮
- Q5: 情熱・空虚
出力例: {"code":"Q3","confidence":0.65,"hint":"不安・安定","color_hex":"#FFD54F"}
`.trim();
    const r = await client.chat.completions.create({
      model: 'gpt-5-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Reply JSON only.' },
        { role: 'user', content: `${prompt}\n\nテキスト:\n${text}` },
      ],
      response_format: { type: 'json_object' } as any,
    });
    const parsed = JSON.parse(r.choices?.[0]?.message?.content ?? '{}');
    const code: QCode = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].includes(parsed.code) ? parsed.code : h.code;
    return {
      code,
      confidence: Math.max(0.5, Math.min(0.99, parsed.confidence ?? 0.6)),
      hint: parsed.hint ?? h.hint,
      color_hex: parsed.color_hex ?? COLOR[code],
    };
  } catch {
    return { code: h.code, confidence: 0.55, hint: h.hint, color_hex: COLOR[h.code] };
  }
}
