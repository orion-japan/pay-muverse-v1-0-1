// src/app/api/iros/summarize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { chatComplete } from '@/lib/llm/chatComplete';

export async function POST(req: NextRequest) {
  try {
    const { prevMini = '', userText = '', aiText = '' } = await req.json();

    const sys = [
      'あなたは編集者。前回要約があれば活かしつつ、今回のUser/AI内容を加えた「300〜500字の直近要約」を日本語で1段落で返す。',
      '固有名詞と決定事項・TODOは簡潔に含める。冗長な前置きは不要。'
    ].join('\n');

    const content = await chatComplete({
      // ✅ 追加（必須）
      purpose: 'digest',

      apiKey: process.env.OPENAI_API_KEY!,
      model: process.env.IROS_SUMMARY_MODEL || 'gpt-5-mini',
      temperature: 0.3,
      max_tokens: 380,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: `前回: ${prevMini || '(なし)'}\n今回-User:${userText}\n今回-Iros:${aiText}`
        }
      ]
    });

    return NextResponse.json({ ok: true, summary: content.trim() });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || 'error') },
      { status: 500 }
    );
  }
}
