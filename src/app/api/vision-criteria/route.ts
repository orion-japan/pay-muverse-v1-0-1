import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuth } from "firebase-admin/auth";
import { initializeApp, applicationDefault } from "firebase-admin/app";

/* ---- Firebase Admin init (1本方式) ---- */
function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
}
try { initializeApp({ credential: applicationDefault(), ...(projectId()?{projectId:projectId()}:{}), }); }
catch { /* already */ }

/* ---- Helpers ---- */
async function verify(req: NextRequest) {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  try { return await getAuth().verifyIdToken(h.split(" ")[1]); }
  catch { return null; }
}
async function resolveUserCode(uid: string): Promise<string> {
  const f = await supabase.from("users").select("user_code").eq("firebase_uid", uid).limit(1).maybeSingle();
  if (f.data?.user_code) return String(f.data.user_code);
  const gen = () => String(Math.floor(100000 + Math.random()*900000));
  let user_code = gen();
  for (let i=0;i<5;i++){
    const d = await supabase.from("users").select("user_code").eq("user_code", user_code).maybeSingle();
    if (!d.data) break; user_code = gen();
  }
  const ins = await supabase.from("users").insert([{ user_code, firebase_uid: uid }]).select("user_code").single();
  if (ins.error) throw ins.error;
  return String(ins.data.user_code);
}

/* ---- GET: ?vision_id=...&from=S ----
   items = 定義 + 今日のチェック有無 + 通算達成日数、summary.ready = 次へ進む準備完了
*/
export async function GET(req: NextRequest) {
  const user = await verify(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const uc = await resolveUserCode(user.uid);

  const { searchParams } = new URL(req.url);
  const vision_id = searchParams.get("vision_id");
  const from = searchParams.get("from"); // S/F/R/C/I
  if (!vision_id || !from) {
    return NextResponse.json({ error: "Missing vision_id/from" }, { status: 400 });
  }

  const defs = await supabase
    .from("vision_stage_criteria")
    .select("*")
    .eq("vision_id", vision_id)
    .eq("from_stage", from)
    .order("order_index", { ascending: true });

  if (defs.error) return NextResponse.json({ error: defs.error.message }, { status: 500 });

  const ids = (defs.data ?? []).map(d => d.criteria_id);
  const today = new Date().toISOString().slice(0,10);

  const checksToday = ids.length
    ? await supabase
        .from("vision_criteria_checks")
        .select("criteria_id")
        .eq("user_code", uc)
        .eq("date", today)
        .in("criteria_id", ids)
    : { data: [], error: null };

  if (checksToday && (checksToday as any).error) {
    return NextResponse.json({ error: (checksToday as any).error.message }, { status: 500 });
  }

  const counts = ids.length
    ? await supabase
        .from("vision_criteria_checks")
        .select("criteria_id, count:count(*)")
        .eq("user_code", uc)
        .eq("status", "done")
        .in("criteria_id", ids)
        .group("criteria_id")
    : { data: [], error: null };

  if (counts && (counts as any).error) {
    return NextResponse.json({ error: (counts as any).error.message }, { status: 500 });
  }

  const todaySet = new Set((checksToday.data ?? []).map((r:any)=>r.criteria_id));
  const countMap = new Map<string, number>();
  (counts.data ?? []).forEach((r:any)=> countMap.set(r.criteria_id, Number(r.count||0)));

  const items = (defs.data ?? []).map(d => ({
    ...d,
    todayDone: todaySet.has(d.criteria_id),
    doneCount: countMap.get(d.criteria_id) ?? 0,
  }));

  const requiredTotal = items.filter(i=>i.required).length;
  const requiredDoneOK = items.filter(i=>i.required && i.doneCount >= i.required_days).length;
  const ready = requiredTotal>0 && requiredTotal === requiredDoneOK;
  const to_stage = items[0]?.to_stage || null;

  return NextResponse.json({
    items,
    summary: { requiredTotal, requiredDoneOK, ready, to_stage }
  });
}

/* ---- POST: 定義の新規作成（配列でも可） ----
  body: { vision_id, from_stage, to_stage, title, required_days?, required?, order_index? } | { bulk:[...] }
*/
export async function POST(req: NextRequest) {
  const user = await verify(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();

  const rows = (Array.isArray(body.bulk) ? body.bulk : [body]).map((b:any)=>({
    vision_id: b.vision_id, from_stage: b.from_stage, to_stage: b.to_stage,
    title: b.title, required: b.required ?? true,
    required_days: b.required_days ?? 1, order_index: b.order_index ?? 0,
  }));

  if (!rows.every(r=>r.vision_id && r.from_stage && r.to_stage && r.title)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const ins = await supabase.from("vision_stage_criteria").insert(rows).select("*");
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
  return NextResponse.json(ins.data);
}

/* ---- PUT: 定義の更新 ----
  body: { criteria_id, ...patch }
*/
export async function PUT(req: NextRequest) {
  const user = await verify(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const { criteria_id } = body;
  if (!criteria_id) return NextResponse.json({ error: "Missing criteria_id" }, { status: 400 });

  const allow = ["title","required","required_days","order_index"] as const;
  const patch: Record<string,any> = {};
  for (const k of allow) if (Object.prototype.hasOwnProperty.call(body,k)) patch[k]=body[k];

  const upd = await supabase
    .from("vision_stage_criteria")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("criteria_id", criteria_id)
    .select("*").single();

  if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });
  return NextResponse.json(upd.data);
}

/* ---- DELETE: ?id=... ---- */
export async function DELETE(req: NextRequest) {
  const user = await verify(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const del = await supabase.from("vision_stage_criteria").delete().eq("criteria_id", id);
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
