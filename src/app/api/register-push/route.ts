// src/app/api/register-push/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, applicationDefault } from 'firebase-admin/app';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // Service Role（RLS回避）
  { auth: { persistSession: false } }
);

// Firebase Admin init (冪等)
function resolveProjectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
} catch {}

type Body = {
  user_code?: string; // 任意（uuid or text）
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

export async function POST(req: NextRequest) {
  try {
    // ヘッダーから uid / user_code を拾う（互換のため）
    const authHeader = req.headers.get('authorization');
    let uid: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      const idToken = authHeader.slice('Bearer '.length);
      try {
        const decoded = await getAuth().verifyIdToken(idToken);
        uid = decoded.uid;
      } catch (e) {
        // 無効トークンは無視して続行（匿名運用も許容）
        console.warn('[register-push] invalid idToken ignored');
      }
    }
    const headerUserCode = req.headers.get('x-mu-user-code') || undefined;

    const { user_code: bodyUserCode, endpoint, keys } = (await req.json()) as Body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { ok: false, error: 'missing fields', got: { endpoint, keys } },
        { status: 400 }
      );
    }

    const user_code = String(bodyUserCode || headerUserCode || '');

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_code: user_code || null,        // DB側の型に任せる（uuidでもtextでもOK）
          uid: uid || null,                    // 新規: uid も保存
          endpoint: String(endpoint),
          p256dh: String(keys.p256dh),
          auth: String(keys.auth),
          ua: req.headers.get('user-agent') || null,
          platform: /iPhone|iPad|iPod/i.test(req.headers.get('user-agent') || '')
            ? 'ios' : /Android/i.test(req.headers.get('user-agent') || '')
            ? 'android' : 'desktop',
          last_seen: new Date().toISOString(),
        } as any,
        { onConflict: 'endpoint' } // endpoint を UNIQUE にしておく
      );

    if (error) {
      console.error('❌ Supabase upsert error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, uid: uid ?? null });
  } catch (err: any) {
    console.error('❌ register-push API error:', err);
    return NextResponse.json({ ok: false, error: err?.message || 'server error' }, { status: 500 });
  }
}
