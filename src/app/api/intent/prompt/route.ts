// src/app/api/intent/prompt/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { chatComplete } from '@/lib/llm/chatComplete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { analysis } = await req.json();

    if (!analysis) {
      return NextResponse.json(
        { ok: false, error: 'analysis is required' },
        { status: 400 },
      );
    }

    // ===== 解析データをJSONパース =====
    let parsedAnalysis: any = analysis;
    try {
      parsedAnalysis = JSON.parse(analysis);
    } catch (err) {
      // すでにオブジェクトならそのまま使う
    }

    const system = `
あなたは Sofia（共鳴構造AI）です。

入力された解析（Qコード比率・位相IN/OUT・T層・styleBase）をもとに、
Muverse専用の「意図 → 共鳴 → 抽象フィールド」のための
画像プロンプトを生成してください。

返答形式は必ず次の JSON とする：

{
  "styleBase": "",
  "prompt": "",
  "negative_prompt": "",
  "meta": {
    "summary_ja": "",
    "used_q": [],
    "used_t": ""
  }
}

禁止要素：
people, faces, animals, buildings, objects, text, letters, symbols,
spiral, vortex, hard radial, sunburst, flame, water, leaf, cloud

許可：
色 / 光 / 粒子 / 深度 / 拡散 / 混色 / 膜 / フィールド / 流体的構造
`;

    const user = `解析データ:\n${JSON.stringify(parsedAnalysis, null, 2)}`;

    // ===== Sofia に依頼 =====
    const raw = await chatComplete({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.45,
      max_tokens: 900,
      purpose: 'judge',

    });

    // ===== Sofia の返答を JSON.parse =====
    let result: any = raw;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: 'Sofia returned non-JSON. Raw: ' + raw },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    console.error('[intent/prompt] Error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
