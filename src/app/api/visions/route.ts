// src/app/api/visions/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAuth } from "firebase-admin/auth";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { logEvent } from "@/server/telemetry"; // ★ 追加

/** env から projectId を解決 */
function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    undefined
  );
}

// Firebase Admin 初期化
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
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

/** Firebase UID → users.user_code を解決 */
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

  const inserted = await supabase
    .from("users")
    .insert([{ user_code, firebase_uid: firebaseUid }])
    .select("user_code")
    .single();

  if (inserted.error) throw inserted.error;
  return String(inserted.data!.user_code);
}

function generateQCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 5; i++)
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `Q-${code}`;
}

/* ========== 共通でテレメトリに残す小道具 ========== */
function contextFromReq(req: NextRequest) {
  return {
    path: new URL(req.url).pathname,
    ua: req.headers.get("user-agent") ?? null,
    sid: req.headers.get("x-session-id") ?? null,
  };
}

/* ========== GET ========== */
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const { path, ua, sid } = contextFromReq(req);

  const user = await verifyFirebaseToken(req);
  if (!user) {
    await logEvent({ kind: "api", path, status: 401, latency_ms: Date.now() - t0, note: "Unauthorized", ua, session_id: sid });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user_code = await resolveUserCode(user.uid);
    const { searchParams } = new URL(req.url);
    const phase = searchParams.get("phase");

    let q = supabase.from("visions").select("*").eq("user_code", user_code);
    if (phase) q = q.eq("phase", phase);

    const { data, error } = await q
      .order("sort_index", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    await logEvent({ kind: "api", path, status: 200, latency_ms: Date.now() - t0, ua, session_id: sid });
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    await logEvent({ kind: "api", path, status: 500, latency_ms: Date.now() - t0, note: e?.message ?? String(e), ua, session_id: sid });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* ========== POST ========== */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { path, ua, sid } = contextFromReq(req);

  const user = await verifyFirebaseToken(req);
  if (!user) {
    await logEvent({ kind: "api", path, status: 401, latency_ms: Date.now() - t0, note: "Unauthorized", ua, session_id: sid });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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
      iboard_thumb,
      q_code,
      sort_index,
      order_index,
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
          iboard_thumb,
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

    if (error) throw error;

    await logEvent({ kind: "api", path, status: 200, latency_ms: Date.now() - t0, ua, session_id: sid });
    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    await logEvent({ kind: "api", path, status: 500, latency_ms: Date.now() - t0, note: e?.message ?? String(e), ua, session_id: sid });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* ========== PUT ========== */
export async function PUT(req: NextRequest) {
  const t0 = Date.now();
  const { path, ua, sid } = contextFromReq(req);

  const user = await verifyFirebaseToken(req);
  if (!user) {
    await logEvent({ kind: "api", path, status: 401, latency_ms: Date.now() - t0, note: "Unauthorized", ua, session_id: sid });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user_code = await resolveUserCode(user.uid);
    const body = await req.json();

    if (Array.isArray(body?.order)) {
      const now = new Date().toISOString();
      for (const r of body.order) {
        const { error } = await supabase
          .from("visions")
          .update({ sort_index: Number(r.sort_index), updated_at: now })
          .eq("vision_id", String(r.vision_id))
          .eq("user_code", user_code);
        if (error) throw error;
      }
      await logEvent({ kind: "api", path, status: 200, latency_ms: Date.now() - t0, ua, session_id: sid });
      return NextResponse.json({ ok: true, count: body.order.length });
    }

    const vision_id = body?.vision_id;
    if (!vision_id) throw new Error("Missing vision_id");

    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body?.title) patch.title = body.title;
    if (body?.detail !== undefined) patch.detail = body.detail;
    if (body?.iboard_thumb !== undefined) patch.iboard_thumb = body.iboard_thumb;
    // …他のフィールドも同様

    const { data, error } = await supabase
      .from("visions")
      .update(patch)
      .eq("vision_id", vision_id)
      .eq("user_code", user_code)
      .select("*")
      .single();

    if (error) throw error;

    await logEvent({ kind: "api", path, status: 200, latency_ms: Date.now() - t0, ua, session_id: sid });
    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    await logEvent({ kind: "api", path, status: 500, latency_ms: Date.now() - t0, note: e?.message ?? String(e), ua, session_id: sid });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* ========== DELETE ========== */
export async function DELETE(req: NextRequest) {
  const t0 = Date.now();
  const { path, ua, sid } = contextFromReq(req);

  const user = await verifyFirebaseToken(req);
  if (!user) {
    await logEvent({ kind: "api", path, status: 401, latency_ms: Date.now() - t0, note: "Unauthorized", ua, session_id: sid });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user_code = await resolveUserCode(user.uid);
    const { searchParams } = new URL(req.url);
    const vision_id = searchParams.get("id");
    if (!vision_id) throw new Error("Missing vision_id");

    const { error } = await supabase
      .from("visions")
      .delete()
      .eq("vision_id", vision_id)
      .eq("user_code", user_code);

    if (error) throw error;

    await logEvent({ kind: "api", path, status: 200, latency_ms: Date.now() - t0, ua, session_id: sid });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    await logEvent({ kind: "api", path, status: 500, latency_ms: Date.now() - t0, note: e?.message ?? String(e), ua, session_id: sid });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
