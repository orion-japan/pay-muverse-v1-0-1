// src/lib/iros/conversation/normalBase.ts
// IROS — Normal Base Conversation
//
// 目的：
// - Qコード・深度・モードに依存せず
// - 「人が話したら、必ず返る」通常会話の土台を成立させる
// - GPT化（説明・助言・一般論）を避ける
//
// 注意：
// - SILENCE / FORWARD の判断はここではしない
// - renderEngine は使わない
// - 生成後の解析・分類は別レイヤで行う

import { chatComplete } from '@/lib/llm/chatComplete';

const SYSTEM_PROMPT = `
あなたは IROS の「Normal Base」応答層です。

これは診断でも分析でも助言でもありません。
人の言葉が場に現れたとき、
それに対して「存在として返す」ための最小応答です。

以下を厳守してください。

【役割】
- ユーザーの入力を問題や問いとして扱わない
- 解決・説明・指導・整理をしない
- Qコード・深度・モードを一切使わない

【語りの制約】
- 断定的で静かな短文のみ
- 2〜4行まで
- 中心は1つだけ
- 一般論・平均解は禁止

【禁止事項】
- アドバイス（〜してみてください 等）
- 選択肢の列挙
- 理由や背景の説明
- 教訓・まとめ・結論づけ
- 解釈文（それは◯◯ということです 等）
- 行動や時間を促す表現（次は／今後／これから 等）

【文体】
- 丁寧すぎない
- 説明口調にしない
- IROSらしい静けさを保つ
- 絵文字は「🪔」のみ、最大1回

これは GPT ではありません。
平均的で無難な説明文を生成しないでください。
`.trim();

function normalizeOutput(text: string): string {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 行数制限（最大4行）
  const sliced = lines.slice(0, 4);

  // 全体文字数制限（保険）
  const joined = sliced.join('\n');
  return joined.length > 240 ? joined.slice(0, 240) : joined;
}

export async function runNormalBase(args: {
  userText: string;
}): Promise<{
  text: string;
  meta: {
    source: 'normal_base';
  };
}> {
  const userText = String(args.userText ?? '').trim();

  // ここでは「空入力」は扱わない（SpeechPolicyの責務）
  // 念のための最小ガード
  if (!userText) {
    return {
      text: '……',
      meta: { source: 'normal_base' },
    };
  }

  // ✅ OpenAI 直叩きは禁止：単一出口 chatComplete を使用
  const raw = await chatComplete({
    purpose: 'writer', // NormalBase は「生成」なので writer 扱いでOK
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.IROS_NORMAL_BASE_MODEL || process.env.IROS_MODEL || 'gpt-4o',
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
    // NormalBase は「必ず返す」層。空は許容しない（既定 false でOK）
  });

  const text = normalizeOutput(raw);

  // 最終保険：それでも空なら echo（異常系）
  const finalText =
    text.trim().length > 0 ? text : `受け取りました。\n言葉は、ここにあります。`;

  return {
    text: finalText,
    meta: {
      source: 'normal_base',
    },
  };
}
