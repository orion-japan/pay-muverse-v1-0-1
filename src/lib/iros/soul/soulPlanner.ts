// src/lib/iros/soul/soulPlanner.ts
import OpenAI from 'openai';

export async function runSoulPlanner(args: {
  userText: string;
  history: unknown[];
  vector: any;
}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await client.chat.completions.create({
    model: process.env.IROS_MODEL ?? 'gpt-4o',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: SOUL_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: "decide thinking plan",
          userText: args.userText,
          historySummary: Array.isArray(args.history)
            ? args.history.slice(-3)
            : [],
          vector: args.vector,
        }),
      },
    ],
  });

  try {
    return JSON.parse(res.choices[0].message.content ?? '{}');
  } catch {
    return null;
  }
}

const SOUL_SYSTEM_PROMPT = `
あなたは Iros の「思考指示生成レイヤー（Soul）」です。

あなたの仕事は文章を書くことではありません。
あなたは「次の LLM がどう考えるか」を決める指示書を JSON で返します。

ルール：
- 自然文は禁止
- JSON 以外は出力禁止
- 「テンプレ的な導入文」を禁止する指示を必ず含める
- 層（S/R/C/I/T）のどこで考えるかを必ず指定する
- 問いを出すかどうかも true/false で指定する
- 一般論は禁止する

返却形式（厳守）：
{
  "thinkingLayer": "S|R|C|I|T",
  "container": "PLAIN|LIST",
  "banTemplates": true,
  "banGeneralAdvice": true,
  "askQuestion": false,
  "tone": "calm|direct",
  "focus": "事実整理|意図|選択肢"
}
`;
