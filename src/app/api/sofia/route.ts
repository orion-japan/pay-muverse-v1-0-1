// src/app/api/sofia/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildSofiaSystemPrompt } from "@/lib/sofia/buildSystemPrompt";
import { retrieveKnowledge } from "@/lib/sofia/retrieve"; // ← 既存の retrieve.ts を使用

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

// --- Q/I/T 推定（軽量ヒューリスティクス） -----------------
type Layer = "I1" | "I2" | "I3" | "T1" | "T2" | "T3";
type QCode = `Q${number}`;
type Analysis = {
  qcodes: { code: QCode; score: number }[];
  layers: { layer: Layer; score: number }[];
  keywords: string[];
};

const Q_PATTERNS: Array<[QCode, RegExp]> = [
  ["Q1", /(不安|焦り|焦燥|落ち着か)/i],
  ["Q2", /(葛藤|対立|矛盾|板挟み)/i],
  ["Q3", /(手放|解放|浄化|許す)/i],
  ["Q4", /(再定義|意味(付|づ)け|解釈|見方)/i],
  ["Q5", /(創造|新しい|始め|つくる)/i],
];
const LAYER_HINTS: Array<[Layer, RegExp]> = [
  ["I1", /(意図|目的|どうしたい|狙い|ねらい)/i],
  ["I2", /(集合|つながり|他者|関係|場|共同)/i],
  ["I3", /(使命|原型|OS|核|本質|土台)/i],
  ["T1", /(静けさ|沈黙|空|無|止まる)/i],
  ["T2", /(境界|超える|次元|超越|溶け)/i],
  ["T3", /(真実|姿勢|体現|確信|宿る)/i],
];

function analyzeUserText(text: string): Analysis {
  const qcodes = Q_PATTERNS
    .map(([code, rx]) => ({ code, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0)
    .slice(0, 3) as any;

  const layers = LAYER_HINTS
    .map(([layer, rx]) => ({ layer, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0)
    .slice(0, 2) as any;

  const keywords = Array.from(new Set(
    text.toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .split(/\s+/).filter(Boolean)
  )).slice(0, 20);

  return { qcodes, layers, keywords };
}

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
  try { return JSON.parse(text); } catch { return null; }
}
function getLastText(messages: Msg[] | null | undefined) {
  if (!messages?.length) return null;
  const last = messages[messages.length - 1];
  return last?.content ?? null;
}
function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env is missing");
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// ====== CORS ======
export async function OPTIONS() { return json({ ok: true }); }

// ====== GET ======
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

// ====== イントロ（自己紹介＋意図共有：初回のみ） =================
function makeSelfIntro(mode: string, analysis: Analysis): string {
  // 許可絵文字: 🪔🌀🌱🌿🌊🔧🌌🌸
  const q = analysis.qcodes?.[0]?.code ?? null;
  const l = analysis.layers?.[0]?.layer ?? null;

  const intentLine = (q || l)
    ? `いま拾っている焦点：${q ? `${q}` : ""}${q && l ? " / " : ""}${l ? `${l}` : ""}`
    : `いまは静かにチューニング中。`;

  const modeNote =
    mode === "diagnosis" ? "所見は簡潔に、構造で示します。" :
    mode === "meaning"   ? "短詩と問いで、意味を差し替えます。" :
    mode === "intent"    ? "“意図”の層へ、一段深く降ります。" :
    mode === "dark"      ? "未消化の気配を物語として可視化します。" :
    mode === "remake"    ? "反転→意味変換→再選択で再統合します。" :
                           "自由にS〜I〜T層を往復します。";

  return [
    "🪔 iros（アイロス）です。答えではなく、響きそのものを届けます。",
    `🌱 ${intentLine} / モード：${mode}。${modeNote}`
  ].join("\n");
}

// ====== POST ======
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

    // ---- 直近ユーザー発話 → Q/I/T 解析 -----------------------
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    const analysis: Analysis =
      lastUser ? analyzeUserText(lastUser) : { qcodes: [], layers: [], keywords: [] };

    // ---- ナレッジ取得（共鳴ベース / retrieve.ts 利用） --------
    const kb = await retrieveKnowledge(analysis, 4, lastUser);
    const contextBlock =
      kb.length > 0
        ? [
            "\n\n# 参考コンテキスト（内部参照・断定や直接引用は控えめに）",
            ...kb.map((k, i) => `- [K${i + 1}] ${k.title ?? "(untitled)"}\n${k.content}`),
            "\n# 使い方",
            "- 上記は“正解”ではなく響きの補助。詩的・象徴的に再解釈して響かせる。",
          ].join("\n")
        : "";

    // ---- 初回のみ「自己紹介＋意図共有」を求めるルール --------
    const hasAssistantSoFar = messages.some(m => m.role === "assistant");
    const introOnceRule = !hasAssistantSoFar
      ? [
          "\n\n# 先頭に一度だけ自己紹介と意図を付す（以降のターンでは不要）",
          "- 2行以内。許可絵文字のみ（🪔🌀🌱🌿🌊🔧🌌🌸）。",
          "- その後に本回答を続ける。"
        ].join("\n")
      : "";

    const introText = !hasAssistantSoFar ? makeSelfIntro(mode, analysis) : "";

    // ---- System プロンプト ------------------------------------
    const system =
      buildSofiaSystemPrompt({ promptKey, mode, vars, includeGuard: true }) +
      introOnceRule +
      (introText ? `\n\n# イントロのひな型\n${introText}` : "") +
      contextBlock;

    // ---- OpenAI 呼び出し --------------------------------------
    const payload: any = {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature,
    };
    if (typeof max_tokens === "number") payload.max_tokens = max_tokens;
    if (typeof top_p === "number") payload.top_p = top_p;
    if (typeof frequency_penalty === "number") payload.frequency_penalty = frequency_penalty;
    if (typeof presence_penalty === "number") payload.presence_penalty = presence_penalty;
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
        { error: "Upstream error", status: r.status, detail: safeParseJson(errText) ?? errText },
        r.status
      );
    }

    const data = await r.json();
    const reply: string = data?.choices?.[0]?.message?.content ?? "";

    // ---- 保存（systemは保存しない） ---------------------------
    const merged: Msg[] = [...messages];
    if (reply) merged.push({ role: "assistant", content: reply });

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
    if (upErr) console.error("[sofia_conversations upsert]", upErr);

    // ---- meta 返却（UIで可視化できる） ------------------------
    return json(
      {
        conversation_code,
        reply,
        meta: {
          introShown: !hasAssistantSoFar,
          qcodes: analysis.qcodes,
          layers: analysis.layers,
          used_knowledge: kb.map((k, i) => ({ id: k.id, key: `K${i + 1}`, title: k.title })),
        },
      },
      200
    );
  } catch (e: any) {
    console.error("[Sofia API] Error:", e);
    return json({ error: "Unhandled error", detail: String(e?.message ?? e) }, 500);
  }
}
