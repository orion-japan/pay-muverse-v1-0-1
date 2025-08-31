// src/app/api/sofia/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildSofiaSystemPrompt } from "@/lib/sofia/buildSystemPrompt";
import { retrieveKnowledge } from "@/lib/sofia/retrieve";

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

// ====== CONST ======
const CHAT_URL = "https://api.openai.com/v1/chat/completions";
type Msg = { role: "system" | "user" | "assistant"; content: string };
const newConvCode = () => `Q${Date.now()}`;

// ====== UTILS ======
function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === "number" ? init : (init?.["status"] ?? 200);
  const headers = new Headers(typeof init === "number" ? undefined : init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  return new NextResponse(JSON.stringify(data), { status, headers });
}
const bad = (msg: string, code = 400) => json({ error: msg }, code);

function safeParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getLastText(messages: Msg[] | null | undefined) {
  if (!messages?.length) return null;
  const last = messages[messages.length - 1];
  return last?.content ?? null;
}

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env is missing");
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

// ====== CORS ======
export async function OPTIONS() {
  return json({ ok: true });
}

// ====== GET ======
// 1) /api/sofia                           -> health
// 2) /api/sofia?user_code=U0000            -> 会話一覧
// 3) /api/sofia?user_code=U0000&conversation_code=Q... -> 会話メッセージ
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get("user_code") || "";
  const conversation_code = searchParams.get("conversation_code") || "";

  if (!user_code) {
    return json({
      ok: true,
      service: "Sofia API",
      time: new Date().toISOString(),
      model_hint: "gpt-4o",
    });
  }

  const supabase = sb();

  if (!conversation_code) {
    // 会話一覧
    const { data, error } = await supabase
      .from("sofia_conversations")
      .select("conversation_code, title, updated_at, messages")
      .eq("user_code", user_code)
      .order("updated_at", { ascending: false });

    if (error) return bad(`DB error: ${error.message}`, 500);

    const items =
      (data ?? []).map((row) => ({
        conversation_code: row.conversation_code as string,
        title: (row.title as string | null) ?? null,
        updated_at: (row.updated_at as string | null) ?? null,
        last_text: getLastText((row.messages as Msg[]) ?? []),
      })) || [];

    return json({ items });
  }

  // 会話メッセージ取得
  const { data, error } = await supabase
    .from("sofia_conversations")
    .select("messages")
    .eq("user_code", user_code)
    .eq("conversation_code", conversation_code)
    .maybeSingle();

  if (error) return bad(`DB error: ${error.message}`, 500);

  const messages: Msg[] = (data?.messages as Msg[]) ?? [];
  return json({ messages });
}

// ====== POST ======
// body: { user_code, conversation_code?, mode, promptKey, vars, messages[], model?, temperature?... }
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return bad("Env OPENAI_API_KEY is missing", 500);

    const body = (await req.json().catch(() => ({}))) || {};
    const {
      user_code = "",
      conversation_code: inCode = "",
      mode = "normal",
      promptKey = "base",
      vars = {},
      messages = [],
      model = "gpt-4o",
      temperature = 0.8,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
      response_format,
    }: {
      user_code?: string;
      conversation_code?: string;
      mode?: "normal" | "diagnosis" | "meaning" | "intent" | "dark" | "remake";
      promptKey?: any;
      vars?: Record<string, any>;
      messages?: Msg[];
      model?: string;
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      response_format?: any;
    } = body;

    if (!user_code) return bad("`user_code` is required");
    if (!Array.isArray(messages))
      return bad("`messages` must be an array of {role, content}");

    const conversation_code = inCode || newConvCode();

    // System プロンプト
    const system = buildSofiaSystemPrompt({
      promptKey,
      mode,
      vars,
      includeGuard: true,
    });

    // ---- 共鳴ナレッジを確率的に取得 ----
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    const seed = Math.abs([...`${user_code}:${conversation_code}`]
      .reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0));

    // 仮: vars.analysis がある前提
    const analysis = vars.analysis || { qcodes: [], layers: [], keywords: [] };
    const epsilon = 0.3;
    const noiseAmp = 0.15;

    const kb = await retrieveKnowledge(analysis, 4, lastUser, { epsilon, noiseAmp, seed });

    // OpenAI へ
    const payload: any = {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature,
    };
    if (typeof max_tokens === "number") payload.max_tokens = max_tokens;
    if (typeof top_p === "number") payload.top_p = top_p;
    if (typeof frequency_penalty === "number")
      payload.frequency_penalty = frequency_penalty;
    if (typeof presence_penalty === "number")
      payload.presence_penalty = presence_penalty;
    if (response_format) payload.response_format = response_format;

    const r = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return json(
        {
          error: "Upstream error",
          status: r.status,
          detail: safeParseJson(errText) ?? errText,
        },
        r.status
      );
    }

    const data = await r.json();
    const reply: string = data?.choices?.[0]?.message?.content ?? "";

    // 保存用メッセージ（system は DB に保存しない）
    const merged: Msg[] = [...messages];
    if (reply) merged.push({ role: "assistant", content: reply });

    // Upsert
    const supabase = sb();
    const { error: upErr } = await supabase.from("sofia_conversations").upsert(
      {
        user_code,
        conversation_code,
        title: null,
        messages: merged,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_code,conversation_code" }
    );
    if (upErr) {
      console.error("[sofia_conversations upsert]", upErr);
    }

    // ---- metaを返却して透明化 ----
    return json({
      conversation_code,
      reply,
      meta: {
        qcodes: analysis.qcodes,
        layers: analysis.layers,
        used_knowledge: kb.map((k, i) => ({ id: k.id, key: `K${i + 1}`, title: k.title })),
        stochastic: { epsilon, noiseAmp, seed },
      },
    }, 200);
  } catch (e: any) {
    console.error("[Sofia API] Error:", e);
    return json({ error: "Unhandled error", detail: String(e?.message ?? e) }, 500);
  }
}
