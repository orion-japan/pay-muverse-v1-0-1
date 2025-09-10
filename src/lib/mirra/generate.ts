// src/lib/mirra/generate.ts
import { buildSystemPrompt } from './buildSystemPrompt';
import {
  MIRRA_MODEL, MIRRA_TEMPERATURE, MIRRA_MAX_TOKENS,
  MIRRA_PRICE_IN, MIRRA_PRICE_OUT
} from './config';

type GenOut = { text: string; cost: number; meta: Record<string, any> };

// 第2引数 seed を「任意」で受け取る
export async function generateMirraReply(
  userText: string,
  seed?: string | null
): Promise<GenOut> {
  const sys = buildSystemPrompt({ seed, style: 'coach' });
  const input = (userText ?? '').trim() || '（入力が短いときは、呼吸の整え方を短く案内してください）';

  if (process.env.OPENAI_API_KEY) {

    const OpenAI = require('openai').default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const res = await openai.chat.completions.create({
      model: MIRRA_MODEL,
      temperature: MIRRA_TEMPERATURE,
      max_tokens: MIRRA_MAX_TOKENS,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input },
      ],
    });

    const text =
      res.choices?.[0]?.message?.content?.trim() ||
      '1. 肩と眉をゆるめる：息を長く\n2. 呼吸の輪郭を1周観察\n3. 台本メモを一行\n4. 20秒だけ言い換え\n5. 1〜5で評価\n何点？';

    const inTok  = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    const cost   = inTok * MIRRA_PRICE_IN + outTok * MIRRA_PRICE_OUT;

    return {
      text,
      cost,
      meta: { provider: 'openai', model: MIRRA_MODEL, input_tokens: inTok, output_tokens: outTok },
    };
  }

  // フォールバック（APIキー無しでも動作）
  const brief = (s: string) => s.replace(/\s+/g, ' ').slice(0, 38);
  const t = brief(input);
  const text =
`1. まず肩と眉をゆるめる：息を長く
2. 呼吸の輪郭を1周観察：胸or腹
3. 台本メモ：「${t}」の続きは？
4. 小さな一歩：20秒だけ言い換え
5. セルフチェック：1〜5で今は？
何点？`;

  return { text, cost: 0, meta: { provider: 'fallback', model: 'rule' } };
}
