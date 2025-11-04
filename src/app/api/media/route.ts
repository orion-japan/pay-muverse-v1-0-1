// src/app/api/media/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // Service role（server only）
);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let raw = searchParams.get('path') || '';

    // 1) 二重 /api/media?path=... の除去
    //    例: /api/media?path=/api/media?path=private-posts/669933/xxx.png
    const nested = raw.match(/(?:^|\/)api\/media\?path=(.+)$/);
    if (nested) raw = decodeURIComponent(nested[1]);

    // 2) デコードを2回試す（%2F がそのまま来るケースに備える）
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    try {
      raw = decodeURIComponent(raw);
    } catch {}

    // 3) 前後の空白や先頭スラッシュを整理
    raw = raw.trim().replace(/^\/+/, '');

    if (!raw) {
      return NextResponse.json({ error: 'path が必要です' }, { status: 400 });
    }

    // 4) 代表的な「二重セグメント」を正規化（album/album/... → album/... 等）
    raw = raw
      .replace(/^(private-posts\/)+/, 'private-posts/')
      .replace(/^(public-posts\/)+/, 'public-posts/')
      .replace(/^(album\/)+/, 'album/');

    // 5) バケットとキーを判定（album も対応）
    //    - "private-posts/669933/xxx.png" → bucket=private-posts, key=669933/xxx.png
    //    - "public-posts/669933/xxx.png"  → bucket=public-posts,  key=669933/xxx.png
    //    - "album/669933/xxx.png"         → bucket=album,        key=669933/xxx.png
    //    - "669933/xxx.png"               → bucket=private-posts(既定), key=そのまま
    let bucket: 'private-posts' | 'public-posts' | 'album' = 'private-posts';
    let key = raw;

    if (raw.startsWith('private-posts/')) {
      bucket = 'private-posts';
      key = raw.replace(/^private-posts\//, '');
    } else if (raw.startsWith('public-posts/')) {
      bucket = 'public-posts';
      key = raw.replace(/^public-posts\//, '');
    } else if (raw.startsWith('album/')) {
      bucket = 'album';
      key = raw.replace(/^album\//, '');
    }

    // 6) バリデーション（最低限）
    if (!/^[\w\-\/.]+$/.test(key)) {
      return NextResponse.json({ error: '不正なパスです' }, { status: 400 });
    }

    // 7) ダウンロード（存在しない場合は 404）
    const { data, error } = await supabase.storage.from(bucket).download(key);
    if (error || !data) {
      return NextResponse.json({ error: '画像の取得に失敗しました' }, { status: 404 });
    }

    // Blob → Buffer（Node runtime）
    const buf = Buffer.from(await data.arrayBuffer());
    const contentType = guessContentType(key);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300', // 短めキャッシュ
      },
    });
  } catch (e) {
    console.error('[api/media] error:', e);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}

function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
