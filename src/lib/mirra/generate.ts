// src/lib/mirra/generate.ts
import { buildSystemPrompt } from './buildSystemPrompt';
import {
  MIRRA_MODEL, MIRRA_TEMPERATURE,
  MIRRA_PRICE_IN, MIRRA_PRICE_OUT
} from './config';

// --- 繰り返し回避のためのヒント ---
function avoidRepeatHint(lastAssistant?: string) {
  if (!lastAssistant) return '';
  const cut = lastAssistant.replace(/\s+/g, ' ').slice(0, 160);
  return [
    '直前と同じ表現や語順は避けること。',
    '番号や構成が似る場合でも、内容・言い回し・具体例は変えること。',
    `直前応答（要約）:「${cut}」`,
  ].join('\n');
}

type GenOut = { text: string; cost: number; meta: Record<string, any> };

/**
 * mirra の返答生成
 * @param userText ユーザー入力
 * @param seed     mTalk要約等（任意）
 * @param lastAssistantReply 直前のアシスタント出力（任意）
 * @param mode 'analyze' | 'consult' （既定: 'consult'）
 */
export async function generateMirraReply(
  userText: string,
  seed?: string | null,
  lastAssistantReply?: string | null,
  mode: 'analyze' | 'consult' = 'consult',
): Promise<GenOut> {
  // mirra の基礎ペルソナ（buildSystemPrompt 内で初回/会話の文体を統制）
  const sys = buildSystemPrompt({ seed, mode });
  const antiRepeat = avoidRepeatHint(lastAssistantReply || undefined);

  const input =
    (userText ?? '').trim() ||
    '（入力が短いときは、呼吸の整え方を短く案内してください）';

  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require('openai').default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const res = await openai.chat.completions.create({
      model: MIRRA_MODEL,
      temperature: Math.min(1.0, Math.max(0.2, MIRRA_TEMPERATURE)), // 少し抑えめ
      top_p: 0.95,
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
      // 200〜300字想定。和文はトークン効率が良いので 200 で十分
      max_tokens: 200,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'system',
          content: [
            '出力は200〜300文字程度。',
            '番号や大見出しは付けない。必要なら箇条書きは最大3点まで。',
            '毎回、具体例や小さな実験を1つ入れる。',
            antiRepeat,
          ].filter(Boolean).join('\n'),
        },
        { role: 'user', content: input },
      ],
    });

    const text = res.choices?.[0]?.message?.content?.trim() || variantFallback(input);

    const inTok  = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    const cost   = inTok * MIRRA_PRICE_IN + outTok * MIRRA_PRICE_OUT;

    return {
      text,
      cost,
      meta: {
        provider: 'openai',
        model: MIRRA_MODEL,
        input_tokens: inTok,
        output_tokens: outTok,
        mode,
      },
    };
  }

  // API キーがない環境向けフォールバック
  return { text: variantFallback(input), cost: 0, meta: { provider: 'fallback', model: 'rule', mode } };
}

// --- フォールバック（毎回少し変える） ---
function hash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pick<T>(arr: T[], seed: string) {
  const idx = hash(seed) % arr.length;
  return arr[idx];
}
function variantFallback(input: string) {
  const t = input.replace(/\s+/g, ' ').slice(0, 40);
  const anchors  = ['肩を下ろして3呼吸', 'みぞおちに手を当て2呼吸', '足裏の圧を30秒観察'];
  const insights = ['事実/解釈を1行ずつ分ける', '「できたこと」を一つ挙げる', '気になる言い回しを短く写す'];
  const steps    = ['20秒だけ手を動かす', '通勤の一停車ぶん観察', '寝る前に1行だけ記録'];

  // 200字以内に収まる簡易パラグラフ
  return [
    `まず${pick(anchors, t)}。続いて、${pick(insights, t + 'i')}。`,
    `「${t}」については、${pick(steps, t + 's')}。体感を1〜2語で残そう。`
  ].join(' ');
}
