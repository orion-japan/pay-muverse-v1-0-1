export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from "@/lib/authz";
import { reserveAndSpendCredit } from "@/lib/mu/credits";
import { v4 as uuid } from "uuid";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const openai = new OpenAI();

// 設定
const CONFIG = {
  mu: {
    model: "gpt-image-1", // gpt-4o-mini は非対応なので gpt-image-1 に統一
    size: "1024x1024",
    cost: Number(process.env.MU_IMAGE_CREDIT_COST || 3),
    reason: "mu_image_generate",
  },
  iros: {
    model: "gpt-image-1",
    size: "1024x1024",
    cost: Number(process.env.IROS_IMAGE_CREDIT_COST || 3),
    reason: "iros_image_generate",
  },
};

export async function POST(req: NextRequest) {
  try {
    const { agent, user_code, prompt, title = "", tags = [], visibility = "public" } =
      await req.json();

    if (!["mu", "iros"].includes(agent)) {
      throw new Error("invalid agent");
    }

    await verifyFirebaseAndAuthorize(req);

    const { model, size, cost, reason } = CONFIG[agent as "mu" | "iros"];

    // クレジット消費
    await reserveAndSpendCredit({
      user_code,
      amount: cost,
      reason,
      meta: { model, size }
    });
    

    // 画像生成（URL が返る）
// 画像生成（URL か b64_json が返る）
const gen = await openai.images.generate({
    model,
    prompt,
    size: size as "1024x1024",
    n: 1,
  });
  
  // === ここを置き換え ===
  const img0 = gen.data?.[0];
  let bin: Buffer | undefined;
  
  const b64 = (img0 as any)?.b64_json;
  if (b64) {
    // b64_json で返ってきたパターン
    bin = Buffer.from(b64, "base64");
  } else if (img0?.url) {
    // URL で返ってきたパターン
    const imgResp = await fetch(img0.url);
    const arrayBuffer = await imgResp.arrayBuffer();
    bin = Buffer.from(arrayBuffer);
  }
  
  if (!bin) {
    throw new Error("IMAGE_EMPTY");
  }
  // ======================
  
  // 保存パス作成～Supabaseへアップロード（以降は今のままでOK）
  const now = new Date();
  const path = `album/${user_code}/${now.getFullYear()}/${(now.getMonth() + 1 + "").padStart(2, "0")}/${uuid()}.png`;
  
  const { error: upErr } = await sb.storage
    .from("album")
    .upload(path, bin, { contentType: "image/png", upsert: false });
  if (upErr) throw upErr;
  
  const { data: pub } = sb.storage.from("album").getPublicUrl(path);
  const publicUrl = pub?.publicUrl;
  if (!publicUrl) throw new Error("URL_NOT_FOUND");
  
    // posts 登録
    const ins = await sb
      .from("posts")
      .insert({
        user_code,
        title,
        tags,
        content: prompt,
        media_urls: [publicUrl],
        visibility,
        is_posted: true,
        ai_generated: true,
        layout_type: "default",
        board_type: "default",
      })
      .select("post_id, media_urls")
      .single();

    return NextResponse.json({
      ok: true,
      post_id: ins.data?.post_id,
      media_urls: ins.data?.media_urls,
      agent,
    });
  } catch (e: any) {
    console.error("IMAGE API ERROR:", e);
    return NextResponse.json(
      { ok: false, error: e.message || "ERR" },
      { status: 400 }
    );
  }
}
