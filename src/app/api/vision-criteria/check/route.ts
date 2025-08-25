import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/* ------- Firebase Admin 1本方式 ------- */
function resolveProjectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
  console.log('✅ Firebase Admin (vision-criteria) initialized', projectId ? `(projectId=${projectId})` : '');
} catch {
  console.log('ℹ️ Firebase Admin already initialized (vision-criteria)');
}

/* ------- 認証 ------- */
async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return decoded; // { uid, ... }
  } catch (e) {
    console.error('❌ verifyIdToken error:', e);
    return null;
  }
}

/* ------- Firebase UID → users.user_code を解決 or 作成 ------- */
async function resolveUserCode(firebaseUid: string): Promise<string> {
  // 既存検索
  const found = await supabase
    .from('users')
    .select('user_code')
    .eq('firebase_uid', firebaseUid)
    .limit(1)
    .maybeSingle();

  if (found.data?.user_code) return String(found.data.user_code);

  // user_code 発行（6桁）
  const gen = () => String(Math.floor(100000 + Math.random() * 900000));
  let user_code = gen();
  for (let i = 0; i < 5; i++) {
    const dupe = await supabase.from('users').select('user_code').eq('user_code', user_code).limit(1).maybeSingle();
    if (!dupe.data) break;
    user_code = gen();
  }

  const ins = await supabase.from('users').insert([{ user_code, firebase_uid: firebaseUid }]).select('user_code').single();
  if (ins.error) throw ins.error;
  return String(ins.data.user_code);
}

/* ------- 型 ------- */
type Stage = 'S' | 'F' | 'R' | 'C' | 'I';
type BridgeRow = {
  id: string;
  vision_id: string;
  from_stage: Stage;
  to_stage: Stage | null;
  title: string;
  required_days: number | null;
  done_days: number | null;
  created_at?: string;
  updated_at?: string;
};

/* 次ステージ推定 */
const NEXT: Record<Stage, Stage> = { S: 'F', F: 'R', R: 'C', C: 'I', I: 'I' };

/* ステージごとのデフォルト ToDo 雛形 */
function defaultTemplates(from: Stage): Omit<BridgeRow, 'id' | 'vision_id'>[] {
  switch (from) {
    case 'S': // 種 → 広げる
      return [
        { from_stage: 'S', to_stage: 'F', title: '意図を1日1回言語化する', required_days: 3, done_days: 0 },
        { from_stage: 'S', to_stage: 'F', title: '観察メモを毎日1件残す', required_days: 3, done_days: 0 },
      ];
    case 'F': // 広げる → 洞察
      return [
        { from_stage: 'F', to_stage: 'R', title: '集めた材料を整理する', required_days: 2, done_days: 0 },
        { from_stage: 'F', to_stage: 'R', title: '気づきをメモにまとめる', required_days: 2, done_days: 0 },
      ];
    case 'R': // 洞察 → 実践
      return [
        { from_stage: 'R', to_stage: 'C', title: '小さな実験を設計する', required_days: 2, done_days: 0 },
        { from_stage: 'R', to_stage: 'C', title: '初回の試行を実施', required_days: 1, done_days: 0 },
      ];
    case 'C': // 実践 → 結果
      return [
        { from_stage: 'C', to_stage: 'I', title: '実践ログを1日分記録', required_days: 3, done_days: 0 },
        { from_stage: 'C', to_stage: 'I', title: '成果と学びをまとめる', required_days: 1, done_days: 0 },
      ];
    case 'I': // 結果 → 結果（留める）
    default:
      return [{ from_stage: 'I', to_stage: 'I', title: '振り返りを書き留める', required_days: 1, done_days: 0 }];
  }
}

/* vision_id が当ユーザーのものかチェック */
async function assertVisionOwner(user_code: string, vision_id: string) {
  const v = await supabase.from('visions').select('vision_id,user_code').eq('vision_id', vision_id).single();
  if (v.error) throw v.error;
  if (!v.data || String(v.data.user_code) !== String(user_code)) {
    throw new Error('Forbidden: vision owner mismatch');
  }
}

/* =================== GET =================== */
/* /api/vision-criteria?vision_id=xxx&from=S */
export async function GET(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user_code = await resolveUserCode(user.uid);

  const { searchParams } = new URL(req.url);
  const vision_id = searchParams.get('vision_id');
  const from = searchParams.get('from') as Stage | null;

  if (!vision_id || !from) {
    return NextResponse.json({ error: 'Missing vision_id/from' }, { status: 400 });
  }

  try {
    await assertVisionOwner(user_code, vision_id);

    const { data, error } = await supabase
      .from('vision_criteria')
      .select('*')
      .eq('vision_id', vision_id)
      .eq('from_stage', from)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (e: any) {
    console.error('GET /vision-criteria error:', e);
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}

/* =================== POST =================== */
/*
  シード作成（推奨）
  body: { seed: true, vision_id: string, from: Stage }

  直接追加
  body: { vision_id, from: Stage, title, required_days }
*/
export async function POST(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user_code = await resolveUserCode(user.uid);

  const body = await req.json().catch(() => ({}));
  const vision_id = body?.vision_id as string | undefined;
  const from = body?.from as Stage | undefined;

  if (!vision_id || !from) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  try {
    await assertVisionOwner(user_code, vision_id);

    if (body.seed) {
      const rows = defaultTemplates(from).map(t => ({
        ...t,
        vision_id,
        // to_stage はテンプレに入っていますが、ない場合は次段に寄せておく
        to_stage: t.to_stage ?? NEXT[from],
      }));

      const { data, error } = await supabase.from('vision_criteria').insert(rows).select('*');
      if (error) throw error;
      return NextResponse.json(data ?? []);
    }

    // 手動追加
    const title = body?.title as string | undefined;
    const required_days = Number(body?.required_days ?? 1);
    if (!title) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

    const { data, error } = await supabase
      .from('vision_criteria')
      .insert([
        {
          vision_id,
          from_stage: from,
          to_stage: NEXT[from],
          title,
          required_days: Math.max(1, required_days),
          done_days: 0,
        },
      ])
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (e: any) {
    console.error('POST /vision-criteria error:', e);
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}

/* =================== PUT =================== */
/*
  ✓ 1日進める: { id, op: 'inc' }
  任意更新   : { id, ...fields }
*/
export async function PUT(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user_code = await resolveUserCode(user.uid);

  const body = await req.json().catch(() => ({}));
  const id = body?.id as string | undefined;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    // 所有チェックのため親 Vision をたどる
    const row = await supabase.from('vision_criteria').select('id,vision_id,required_days,done_days').eq('id', id).single();
    if (row.error) throw row.error;
    await assertVisionOwner(user_code, row.data.vision_id);

    let fields: Partial<BridgeRow> = {};

    if (body.op === 'inc') {
      const reqDays = Math.max(1, row.data.required_days ?? 1);
      const cur = Math.min(reqDays, row.data.done_days ?? 0);
      fields.done_days = Math.min(reqDays, cur + 1);
    } else {
      // 任意更新
      fields = { ...body };
      delete (fields as any).id;
      delete (fields as any).op;
    }

    const upd = await supabase.from('vision_criteria').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (upd.error) throw upd.error;

    return NextResponse.json(upd.data);
  } catch (e: any) {
    console.error('PUT /vision-criteria error:', e);
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}

/* =================== DELETE =================== */
/* /api/vision-criteria?id=xxx */
export async function DELETE(req: NextRequest) {
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user_code = await resolveUserCode(user.uid);

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    // 所有チェック
    const row = await supabase.from('vision_criteria').select('id,vision_id').eq('id', id).single();
    if (row.error) throw row.error;
    await assertVisionOwner(user_code, row.data.vision_id);

    const del = await supabase.from('vision_criteria').delete().eq('id', id);
    if (del.error) throw del.error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('DELETE /vision-criteria error:', e);
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
