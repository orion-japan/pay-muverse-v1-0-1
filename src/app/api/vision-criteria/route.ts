import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, applicationDefault } from 'firebase-admin/app';

/* ==== Firebase Admin init (1本方式) ==== */
function resolveProjectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
  console.log('✅ Firebase Admin initialized (vision-criteria)', projectId ? `(projectId=${projectId})` : '(no projectId)');
} catch {
  /* already initialized */
}

/* ==== Auth helper ==== */
async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return decoded; // { uid, ... }
  } catch (e) {
    console.error('❌ token error (criteria):', e);
    return null;
  }
}

/* ==== vision 所有者チェック：vision が本人のものか確認 ==== */
async function assertVisionOwnedBy(uid: string, vision_id: string): Promise<boolean> {
  // uid -> users.user_code を解決
  const u = await supabase.from('users').select('user_code').eq('firebase_uid', uid).maybeSingle();
  const user_code = u.data?.user_code as string | undefined;

  const { data: vrow } = await supabase
    .from('visions')
    .select('vision_id, user_code')
    .eq('vision_id', vision_id)
    .maybeSingle();

  if (!vrow) return false;
  if (user_code) return vrow.user_code === user_code;
  // users 未連携の場合は存在のみ許容
  return true;
}

/* ==== GET /api/vision-criteria?vision_id=...&from=S ==== */
export async function GET(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const vision_id = searchParams.get('vision_id') || '';
  const from = (searchParams.get('from') || '') as 'S'|'F'|'R'|'C'|'I';
  if (!vision_id || !from) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

  if (!(await assertVisionOwnedBy(user.uid, vision_id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error } = await supabase
    .from('vision_criteria')
    .select('*')
    .eq('vision_id', vision_id)
    .eq('from', from)
    .maybeSingle();

  if (error) {
    console.error('❌ GET vision-criteria error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // なければ null を返す（フロントで「デフォルトを作成」表示）
  return NextResponse.json(data ?? null);
}

/* ==== POST /api/vision-criteria  (作成 or 再生成) ==== */
export async function POST(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { vision_id, from, required_days = 3 } = body || {};
  const checklist = Array.isArray(body?.checklist) ? body.checklist : [];
  if (!vision_id || !from) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

  if (!(await assertVisionOwnedBy(user.uid, vision_id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const existing = await supabase
    .from('vision_criteria')
    .select('id')
    .eq('vision_id', vision_id)
    .eq('from', from)
    .maybeSingle();

  const now = new Date().toISOString();
  const payload = {
    vision_id,
    from,
    required_days,
    checklist,                                   // JSONB
    progress: { streak: 0, metRequired: false }, // 初期値
    updated_at: now,
    ...(existing.data ? {} : { created_at: now }),
  };

  const up = existing.data
    ? await supabase.from('vision_criteria').update(payload).eq('id', existing.data.id).select('*').single()
    : await supabase.from('vision_criteria').insert([payload]).select('*').single();

  if (up.error) {
    console.error('❌ POST vision-criteria error:', up.error);
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  return NextResponse.json(up.data);
}
