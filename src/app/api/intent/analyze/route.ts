// src/app/api/intent/analyze/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { chatComplete } from '@/lib/llm/chatComplete';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { form } = await req.json();

    if (!form) {
      return NextResponse.json(
        { ok: false, error: 'form is required' },
        { status: 400 },
      );
    }

    // ===== Sofia に渡す解析プロンプト =====
    const system = `
あなたは Sofia（共鳴構造AI）です。

与えられたフォーム内容（祈り・願い・心の状態・季節など）から、
以下の5つを必ず推定してください：

1. q_dist:
   Q1〜Q5 の比率（合計1.0）
   例: {"Q1":0.1,"Q2":0.5,"Q3":0.2,"Q4":0.1,"Q5":0.1}

2. phase:
   "IN" または "OUT"

3. t_layer:
   "T1"〜"T5" のいずれか

4. styleBase:
   次の10カテゴリから最適なものをひとつ選ぶ
   [
     "AURORA_FLOW", "PSYCHEDELIC_WAVE", "DEEP_DRAW", "VORTEX_FIELD",
     "COSMIC_SHEET", "PARTICLE_STREAM", "ENERGY_RIBBON",
     "MIST_FIELD", "FRACTAL_FLOW", "LUMINANCE_DRIFT"
   ]

5. summary_ja:
   上記の判断を日本語で短く説明

返答形式は必ず次の JSON フォーマットに従うこと：

{
  "q_dist": {...},
  "phase": "IN or OUT",
  "t_layer": "T1〜T5",
  "styleBase": "カテゴリ名",
  "summary_ja": "..."
}
`;

    const user = `フォーム内容:\n${JSON.stringify(form, null, 2)}`;

    const raw = await chatComplete({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 600,
    });
    return NextResponse.json({ ok: true, analysis: raw });
  } catch (e: any) {
    console.error('[intent/analyze] Error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
