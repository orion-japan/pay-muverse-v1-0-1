import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuth } from "firebase-admin/auth";
import { initializeApp, applicationDefault } from "firebase-admin/app";

/** env から projectId を解決（どちらの名前でもOK） */
function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    undefined
  );
}

// Firebase Admin 初期化（1本方式）
try {
  const projectId = resolveProjectId();
  initializeApp({
    credential: applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });
  console.log(
    "✅ Firebase Admin initialized (/api/visions)",
    projectId ? `(projectId=${projectId})` : "(no projectId)"
  );
} catch {
  console.log("ℹ️ Firebase already initialized (/api/visions)");
}

// ===== Helper: 認証チェック =====
async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("❌ No Authorization header");
    return null;
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    console.log("✅ Firebase token verified:", decoded.uid);
    return decoded;
  } catch (err: any) {
    console.error("❌ Firebase token error:", err?.errorInfo || err?.message || err);
    return null;
  }
}

/** Firebase UID → users.user_code を解決（無ければ最小挿入） */
async function resolveUserCode(firebaseUid: string): Promise<string> {
  const found = await supabase
    .from("users")
    .select("user_code")
    .eq("firebase_uid", firebaseUid)
    .maybeSingle();
  if (found.data?.user_code) return String(found.data.user_code);

  const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
  let user_code = genCode();
  for (let i = 0; i < 5; i++) {
    const dupe = await supabase
      .from("users")
      .select("user_code")
      .eq("user_code", user_code)
      .maybeSingle();
    if (!dupe.data) break;
    user_code = genCode();
  }

  let inserted = await supabase
    .from("users")
    .insert([{ user_code, firebase_uid: firebaseUid }])
    .select("user_code")
    .single();

  if (inserted.error?.code === "23502") {
    const id =
      (globalThis.crypto?.randomUUID?.() ??
        require("crypto").randomUUID()) as string;
    console.warn("⚠ users.id requires value. Retrying with generated UUID:", id);
    inserted = await supabase
      .from("users")
      .insert([{ id, user_code, firebase_uid: firebaseUid }])
      .select("user_code")
      .single();
  }

  if (inserted.error) {
    console.error("❌ resolveUserCode insert error:", inserted.error);
    throw inserted.error;
  }
  return String(inserted.data!.user_code);
}

// ===== Helper: Qコード自動生成 =====
function generateQCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `Q-${code}`;
}

// ===== GET: ビジョン一覧（sort_index→created_at の順）=====
export async function GET(req: NextRequest) {
  console.log("📥 GET /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);

  const { searchParams } = new URL(req.url);
  const phase = searchParams.get("phase");

  let q = supabase.from("visions").select("*").eq("user_code", user_code);
  if (phase) q = q.eq("phase", phase);

  const { data, error } = await q
    .order("sort_index", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });

  if (error) {
    console.error("❌ GET visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, data });
}

// ===== POST: ビジョン新規作成 =====
export async function POST(req: NextRequest) {
  console.log("📥 POST /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);
  const body = await req.json();

  const {
    title,
    detail,
    intention,
    supplement,
    status,
    summary,
    phase,
    stage,
    iboard_post_id,
    q_code,
    sort_index,
    order_index, // 互換受け入れ
  } = body;

  const finalQCode = q_code || { code: generateQCode(), generated: true };

  const { data, error } = await supabase
    .from("visions")
    .insert([
      {
        user_code,
        title,
        detail,
        intention,
        supplement,
        status,
        summary,
        phase,
        stage,
        iboard_post_id,
        q_code: finalQCode,
        sort_index: Number.isFinite(sort_index)
          ? Number(sort_index)
          : Number.isFinite(order_index)
          ? Number(order_index)
          : 0,
      },
    ])
    .select("*")
    .single();

  if (error) {
    console.error("❌ POST visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...data });
}

// ===== PUT: ビジョン更新（DnDの順番記憶：単体/バッチ両対応） =====
export async function PUT(req: NextRequest) {
  console.log("📥 PUT /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);
  const body = await req.json();

  // ---- バッチ：{ order: [{ vision_id, sort_index }] }
// ---- バッチ更新: { order: [{ vision_id, sort_index }] }
if (Array.isArray(body?.order)) {
  const now = new Date().toISOString();
  for (const r of body.order) {
    const vision_id = String(r.vision_id);
    const sort_index = Number(r.sort_index);

    const { error } = await supabase
      .from('visions')
      .update({ sort_index, updated_at: now })
      .eq('vision_id', vision_id)
      .eq('user_code', user_code); // ← 所有者の行だけ更新

    if (error) {
      console.error('❌ PUT visions batch error (vision_id=%s):', vision_id, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, count: body.order.length });
}


  // ---- 単体：{ vision_id, sort_index, stage? } 互換で order_index も受ける
  const vision_id = body?.vision_id;
  if (!vision_id) {
    return NextResponse.json({ error: "Missing vision_id" }, { status: 400 });
  }
  const sort_index =
    body?.sort_index ??
    body?.order_index ??
    (typeof body?.order === "number" ? body.order : undefined);

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (sort_index !== undefined) patch.sort_index = Number(sort_index);
  if (body?.stage) patch.stage = body.stage;
  if (body?.title) patch.title = body.title;
  if (body?.detail !== undefined) patch.detail = body.detail;
  if (body?.intention !== undefined) patch.intention = body.intention;
  if (body?.supplement !== undefined) patch.supplement = body.supplement;
  if (body?.status) patch.status = body.status;
  if (body?.summary !== undefined) patch.summary = body.summary;
  if (body?.iboard_post_id !== undefined) patch.iboard_post_id = body.iboard_post_id;
  if (body?.q_code !== undefined) patch.q_code = body.q_code;

  const { data, error } = await supabase
    .from("visions")
    .update(patch)
    .eq("vision_id", vision_id)
    .eq("user_code", user_code)
    .select("*")
    .single();

  if (error) {
    console.error("❌ PUT visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...data });
}

// ===== DELETE: ビジョン削除 =====
export async function DELETE(req: NextRequest) {
  console.log("📥 DELETE /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);
  const { searchParams } = new URL(req.url);
  const vision_id = searchParams.get("id");
  if (!vision_id) {
    return NextResponse.json({ error: "Missing vision_id" }, { status: 400 });
  }

  const { error } = await supabase
    .from("visions")
    .delete()
    .eq("vision_id", vision_id)
    .eq("user_code", user_code);

  if (error) {
    console.error("❌ DELETE visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
