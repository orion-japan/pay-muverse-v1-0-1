import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, applicationDefault } from 'firebase-admin/app';

/* ==== Firebase Admin init (1本方式) ==== */
function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined
  );
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
  console.log(
    '✅ Firebase Admin initialized (vision-criteria)',
    projectId ? `(projectId=${projectId})` : '(no projectId)',
  );
} catch {
  console.log('ℹ️ Firebase already initialized (vision-criteria)');
}

/* ==== Auth helper ==== */
async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    console.log('❌ Missing Authorization header');
    return null;
  }
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
  const u = await supabase.from('users').select('user_code').eq('firebase_uid', uid).single();
  if (u.error) {
    console.warn('⚠ users lookup failed:', u.error.message);
    return false;
  }
  const user_code = u.data?.user_code as string | undefined;

  const { data: vrow, error: vErr } = await supabase
    .from('visions')
    .select('vision_id, user_code')
    .eq('vision_id', vision_id)
    .maybeSingle();

  if (vErr) {
    console.error('❌ vision lookup error:', vErr);
    return false;
  }

  if (!vrow) return false;
  if (user_code) return vrow.user_code === user_code;

  // users 未連携の場合は存在のみ許容
  return true;
}

/* =========================================================================================
   GET /api/vision-criteria?vision_id=...&from=S
   ========================================================================================= */
export async function GET(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const vision_id = searchParams.get('vision_id') || '';
  const from = (searchParams.get('from') || '') as 'S' | 'F' | 'R' | 'C' | 'I';
  if (!vision_id || !from) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

  if (!(await assertVisionOwnedBy(user.uid, vision_id))) {
    console.warn('⚠ Forbidden: vision not owned by user');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // criteria（無ければ null）
  const { data: criteria, error: critErr } = await supabase
    .from('vision_criteria')
    .select('id, vision_id, from, required_days, checklist, progress')
    .eq('vision_id', vision_id)
    .eq('from', from)
    .maybeSingle();

  if (critErr) {
    console.error('❌ GET vision-criteria error:', critErr);
    return NextResponse.json({ error: critErr.message }, { status: 500 });
  }

  // 実践チェックの達成日数
  let done_days = 0;
  try {
    const { data: checks, error: chkErr } = await supabase
      .from('daily_checks')
      .select('check_date, progress')
      .eq('vision_id', vision_id);

    if (chkErr) throw chkErr;

    done_days = new Set(
      (checks || []).filter((r) => (r.progress ?? 0) > 0).map((r) => r.check_date),
    ).size;
  } catch (e) {
    console.warn('⚠ done_days aggregate failed:', e);
  }

  return NextResponse.json({
    ...(criteria ?? {}),
    required_days: criteria?.required_days ?? null,
    done_days,
  });
}

/* =========================================================================================
   POST /api/vision-criteria
   ========================================================================================= */
export async function POST(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { vision_id, from, required_days = 3 } = body || {};
  const checklist = Array.isArray(body?.checklist) ? body.checklist : [];
  if (!vision_id || !from) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

  if (!(await assertVisionOwnedBy(user.uid, vision_id))) {
    console.warn('⚠ Forbidden: user not owner of vision');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // payload
  const payload = {
    vision_id,
    from,
    required_days,
    checklist,
    progress: { streak: 0, metRequired: false },
  };

  // 既存の有無を確認して upsert
  const { data: existing } = await supabase
    .from('vision_criteria')
    .select('id')
    .eq('vision_id', vision_id)
    .eq('from', from)
    .maybeSingle();

  let up;
  if (existing?.id) {
    up = await supabase
      .from('vision_criteria')
      .update(payload)
      .eq('id', existing.id)
      .select('vision_id, from, required_days, checklist, progress')
      .single();
  } else {
    up = await supabase
      .from('vision_criteria')
      .insert([payload])
      .select('vision_id, from, required_days, checklist, progress')
      .single();
  }

  if (up.error) {
    console.error('❌ POST vision-criteria error:', up.error);
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  return NextResponse.json(up.data);
}
