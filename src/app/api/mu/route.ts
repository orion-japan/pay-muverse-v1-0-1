// src/app/api/mu/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { buildMuSystemPrompt } from "@/lib/mu/buildSystemPrompt";
import { MU_CREDITS, MU_AGENT } from "@/lib/mu/config";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// 環境変数の互換（MU_TEXT_MODEL / MU_MODEL どちらでも）
const MU_MODEL =
  process.env.MU_TEXT_MODEL?.trim() ||
  process.env.MU_MODEL?.trim() ||
  "gpt-4o-mini";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

function json(data: any, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function OPTIONS() {
  return json({});
}

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok: false, error: "OPENAI_API_KEY missing" }, 500);

    // body 取得（壊れたJSONにも耐性）
    const raw = await req.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemOverride = typeof body.systemOverride === "string" ? body.systemOverride : undefined;

    // System prompt
    const system = buildMuSystemPrompt(
      systemOverride ? { promptOverride: systemOverride } : undefined
    );

    // 入力が空なら簡易プロンプトを足す（防御）
    const safeMessages =
      messages.length > 0
        ? messages
        : [{ role: "user", content: "こんにちは。短く自己紹介してください。" }];

    // OpenAI 呼び出し
    const resp = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model: MU_MODEL,
        messages: [{ role: "system", content: system }, ...safeMessages],
        temperature: Number(process.env.MU_TEMPERATURE ?? 0.6),
        top_p: Number(process.env.MU_TOP_P ?? 1),
        frequency_penalty: Number(process.env.MU_FREQ_PENALTY ?? 0),
        presence_penalty: Number(process.env.MU_PRES_PENALTY ?? 0),
      }),
    });

    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 2000);
      const status = resp.status;
      return json({ ok: false, error: "openai_error", status, detail }, 502);
    }

    const data = await resp.json();
    const choice = data?.choices?.[0];
    const content: string =
      choice?.message?.content ??
      (typeof choice?.message === "string" ? choice.message : "") ??
      "";

    // クレジット見積（テキスト1往復）
    const usedCredits = MU_CREDITS.TEXT_PER_TURN;

    return json({
      ok: true,
      agent: MU_AGENT.ID,
      model: MU_MODEL,
      content,
      meta: {
        used_credits: usedCredits,
        credit_schema: "mu.text.turn",
        prompt_version: "mu.v1.0.0",
      },
      raw: process.env.NODE_ENV === "development" ? data : undefined,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: "mu_route_error", detail: String(err?.message ?? err) },
      500
    );
  }
}
