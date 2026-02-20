export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';
import { reserveAndSpendCredit } from '@/lib/mu/credits';
import { randomUUID } from 'crypto';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const openai = new OpenAI();

// 設定
const CONFIG = {
  mu: {
    model: 'gpt-image-1', // gpt-5-mini は非対応なので gpt-image-1 に統一
    size: '1024x1024',
    cost: Number(process.env.MU_IMAGE_CREDIT_COST || 3),
    reason: 'mu_image_generate',
  },
  iros: {
    model: 'gpt-image-1',
    size: '1024x1024',
    cost: Number(process.env.IROS_IMAGE_CREDIT_COST || 3),
    reason: 'iros_image_generate',
  },
} as const;

type AgentKey = keyof typeof CONFIG;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      agent,
      user_code,
      prompt,
      title = '',
      tags = [],
      visibility = 'private', // ← 既定を private に
    }: {
      agent: AgentKey;
      user_code: string;
      prompt: string;
      title?: string;
      tags?: string[];
      visibility?: 'public' | 'private';
    } = body;

    // 入力チェック
    if (!agent || !(agent in CONFIG)) {
      return NextResponse.json({ ok: false, error: 'invalid agent' }, { status: 400 });
    }
    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'user_code required' }, { status: 400 });
    }
    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });
    }

    // 認証＋権限
    await verifyFirebaseAndAuthorize(req);

    const { model, size, cost, reason } = CONFIG[agent];

    // クレジット消費
    await reserveAndSpendCredit({
      user_code,
      amount: cost,
      reason,
      meta: { model, size },
    });

    // 画像生成（b64/url どちらでも受ける）
    const gen = await openai.images.generate({
      model,
      prompt,
      size: size as '1024x1024',
      n: 1,
    });

    const img0 = gen.data?.[0];
    let bin: Buffer | undefined;

    const b64 = (img0 as any)?.b64_json;
    if (b64) {
      bin = Buffer.from(b64, 'base64');
    } else if (img0?.url) {
      const imgResp = await fetch(img0.url);
      const arrayBuffer = await imgResp.arrayBuffer();
      bin = Buffer.from(arrayBuffer);
    }

    if (!bin) {
      throw new Error('IMAGE_EMPTY');
    }

    // 保存パス（bucket: album）— media_urls には path を保存する前提
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const filename = `${randomUUID()}.png`;
    const path = `album/${user_code}/${y}/${m}/${filename}`; // ストレージ上のフルパス

    const { error: upErr } = await sb.storage
      .from('album')
      .upload(path, bin, { contentType: 'image/png', upsert: false });
    if (upErr) throw upErr;

    // 公開URL（返却用。DBには保存しない）
    const { data: pub } = sb.storage.from('album').getPublicUrl(path);
    const publicUrl = pub?.publicUrl ?? null;

    // posts 登録
    const ins = await sb
      .from('posts')
      .insert({
        user_code,
        title,
        tags,
        content: prompt,
        media_urls: [path],           // ← DB には path を保存
        visibility,                   // ← 既定 private
        is_posted: true,
        ai_generated: true,
        layout_type: 'default',
        board_type: 'album',          // ← album 固定
      })
      .select('post_id, media_urls')
      .single();

    return NextResponse.json({
      ok: true,
      agent,
      post_id: ins.data?.post_id,
      media_urls: ins.data?.media_urls, // パスの配列
      public_url: publicUrl,            // 参考情報（使いたい場合のみ）
    });
  } catch (e: any) {
    console.error('IMAGE API ERROR:', e);
    return NextResponse.json({ ok: false, error: e?.message || 'ERR' }, { status: 400 });
  }
}
