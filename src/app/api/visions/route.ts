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
    "✅ Firebase Admin initialized",
    projectId ? `(projectId=${projectId})` : "(no projectId)"
  );
} catch {
  console.log("ℹ️ Firebase already initialized");
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

/**
 * ===== Helper: Firebase UID → users.user_code を解決
 *   - users(firebase_uid) に一致する行がなければ新規作成して user_code を返す
 *   - 既存の users テーブルに合わせてカラム名を調整してください
 */
async function resolveUserCode(firebaseUid: string): Promise<string> {
  // 既存行を探す
  const found = await supabase
    .from("users")
    .select("user_code")
    .eq("firebase_uid", firebaseUid)
    .limit(1)
    .maybeSingle();

  if (found.data?.user_code) {
    return String(found.data.user_code);
  }

  // 無ければ新規 user_code を払い出し（6桁。重複はリトライ）
  const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
  let user_code = genCode();

  for (let i = 0; i < 5; i++) {
    const dupe = await supabase
      .from("users")
      .select("user_code")
      .eq("user_code", user_code)
      .limit(1)
      .maybeSingle();
    if (!dupe.data) break;
    user_code = genCode();
  }

  // 最小限の行を作成
  const inserted = await supabase
    .from("users")
    .insert([{ user_code, firebase_uid: firebaseUid }])
    .select("user_code")
    .limit(1)
    .single();

  if (inserted.error) {
    console.error("❌ resolveUserCode insert error:", inserted.error);
    throw inserted.error;
  }
  return String(inserted.data.user_code);
}

// ===== Helper: Qコード自動生成 =====
function generateQCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `Q-${code}`;
}

// ===== GET: ビジョン一覧 =====
export async function GET(req: NextRequest) {
  console.log("📥 GET /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);

  const { searchParams } = new URL(req.url);
  const phase = searchParams.get("phase");
  console.log("🔎 phase filter:", phase);

  let query = supabase.from("visions").select("*").eq("user_code", user_code);
  if (phase) query = query.eq("phase", phase);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    console.error("❌ GET visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log("✅ GET visions success:", data?.length, "rows");
  return NextResponse.json(data);
}

// ===== POST: ビジョン新規作成 =====
export async function POST(req: NextRequest) {
  console.log("📥 POST /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);

  const body = await req.json();
  console.log("📦 POST body:", body);

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
      },
    ])
    .select("*")
    .limit(1);

  if (error) {
    console.error("❌ POST visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log("✅ POST visions success:", data);
  return NextResponse.json(data?.[0] ?? null);
}

// ===== PUT: ビジョン更新 =====
export async function PUT(req: NextRequest) {
  console.log("📥 PUT /api/visions");
  const user = await verifyFirebaseToken(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user_code = await resolveUserCode(user.uid);

  const body = await req.json();
  console.log("📦 PUT body:", body);

  const { vision_id } = body;
  if (!vision_id) {
    return NextResponse.json({ error: "Missing vision_id" }, { status: 400 });
  }

  // ✅ DBに存在するカラムだけを更新（フロント専用フィールド混入対策）
  const allowedKeys = [
    "title",
    "detail",
    "intention",
    "supplement",
    "status",
    "summary",
    "phase",
    "stage",
    "iboard_post_id",
    "q_code",
  ] as const;

  const patch: Record<string, any> = {};
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) {
      patch[k] = body[k];
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("visions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("vision_id", vision_id)
    .eq("user_code", user_code)
    .select("*")
    .limit(1);

  if (error) {
    console.error("❌ PUT visions error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log("✅ PUT visions success:", data);
  return NextResponse.json(data?.[0] ?? null);
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

  console.log("✅ DELETE visions success:", vision_id);
  return NextResponse.json({ success: true });
}
