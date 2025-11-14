// src/app/api/intent/generate/route.ts
// Intent → Resonant Image (T層抽象生成API)

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import type {
  IntentionForm,
  FineTuneInput,
} from '@/lib/intentPrompt/schema';
import {
  buildIntentionData,
  requestSofiaImagePrompt,
} from '@/lib/intentPrompt/sofiaAdapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 生成エンドポイント
 * @method POST
 * @body { form: IntentionForm, fineTune?: FineTuneInput }
 *
 * フロー：
 * 1. form + fineTune を IntentionData に変換（buildIntentionData）
 * 2. IntentionData を Sofia 内部エージェントに渡し、画像プロンプトを取得
 * 3. gpt-image-1 に prompt を渡して画像生成
 * 4. imageUrl と Sofia の prompt 情報を返却
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      form?: IntentionForm;
      fineTune?: FineTuneInput;
    };

    if (!body?.form) {
      return NextResponse.json(
        { ok: false, error: 'form が指定されていません。' },
        { status: 400 },
      );
    }

    const form = body.form;
    const fineTune = body.fineTune;

    if (!form.tLayer) {
      return NextResponse.json(
        { ok: false, error: 'T層が指定されていません。' },
        { status: 400 },
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: 'Missing env: OPENAI_API_KEY' },
        { status: 500 },
      );
    }

    // ===== 1. IntentionForm → IntentionData =====
    const intentionData = buildIntentionData(form, fineTune);

    // ===== 2. Sofia 内部エージェントから画像プロンプト取得 =====
    const sofiaResult = await requestSofiaImagePrompt(intentionData);
    const { prompt, negative_prompt, meta } = sofiaResult;

    const client = new OpenAI({ apiKey });

    // ===== 3. 画像生成（gpt-image-1） =====
    const imageRes = await client.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024',
      n: 1,
    });

    // data が undefined の可能性を考慮して安全に取り出す
    const first = (imageRes.data ?? [])[0];

    // 1) URL があれば URL
    // 2) なければ b64_json から data URL を組み立てる
    const imageUrl =
      first?.url ??
      (first?.b64_json
        ? `data:image/png;base64,${first.b64_json}`
        : null);

    if (!imageUrl) {
      // 何が返ってきているか確認のためログを出す
      // （本番で邪魔ならあとで消してOK）
      // eslint-disable-next-line no-console
      console.error(
        '[intent/generate] No image URL or b64_json:',
        JSON.stringify(imageRes, null, 2),
      );

      return NextResponse.json(
        { ok: false, error: '画像URLの取得に失敗しました。' },
        { status: 500 },
      );
    }

    // ===== 4. 結果返却 =====
    return NextResponse.json({
      ok: true,
      imageUrl,
      prompt,
      negative_prompt,
      meta,
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[intent/generate] Error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
