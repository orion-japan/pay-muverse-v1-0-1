// src/app/api/cron/tiktok-radar-daily/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sofiaTikTokSupabase, type TikTokMarketResearch } from "@/lib/sofia/tiktok-radar/supabase";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authorization = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const urlSecret = new URL(req.url).searchParams.get("secret")?.trim() || "";
  const userAgent = req.headers.get("user-agent") || "";

  if (cronSecret && (authorization === `Bearer ${cronSecret}` || urlSecret === cronSecret)) {
    return true;
  }

  return userAgent.includes("vercel-cron/1.0");
}

function scoreNumber(value: number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function totalScore(item: TikTokMarketResearch) {
  return (
    scoreNumber(item.why_known_score) +
    scoreNumber(item.resonance_score) +
    scoreNumber(item.save_intent_score)
  );
}

function muLeadScore(item: TikTokMarketResearch) {
  const text = [
    item.category,
    item.keyword,
    item.hook_text,
    item.caption_text,
    item.top_comment,
    item.reaction_words,
    item.resonance_words,
    item.sofia_note,
  ]
    .filter(Boolean)
    .join(" ");

  return Math.min(
    20,
    totalScore(item) +
      (text.includes("なんで") || text.includes("見抜") || text.includes("本当は") ? 3 : 0) +
      (text.includes("保存") || text.includes("見返す") ? 2 : 0)
  );
}

function splitWords(value: string | null | undefined) {
  return (value ?? "")
    .split(/[\/\n,、。\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

function rankWords(items: TikTokMarketResearch[], key: "reaction_words" | "resonance_words") {
  const counts = new Map<string, number>();

  for (const item of items) {
    for (const word of splitWords(item[key])) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 8);
}

function countByStatus(items: TikTokMarketResearch[]) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const status = item.status || "draft";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

async function handle(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const { data, error } = await sofiaTikTokSupabase
    .from("tiktok_market_research")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    return json({ ok: false, error: "tiktok_radar_fetch_failed", detail: error.message }, 500);
  }

  const items = (data ?? []) as TikTokMarketResearch[];
  const statusCounts = countByStatus(items);
  const topMuLead = [...items]
    .sort((a, b) => muLeadScore(b) - muLeadScore(a))
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      category: item.category,
      keyword: item.keyword,
      status: item.status || "draft",
      total_score: totalScore(item),
      mu_lead_score: muLeadScore(item),
      hook_text: item.hook_text,
      video_url: item.video_url,
    }));

  return json({
    ok: true,
    purpose: "Sofia TikTok radar keepalive and daily summary",
    total_items: items.length,
    status_counts: statusCounts,
    top_resonance_words: rankWords(items, "resonance_words"),
    top_reaction_words: rankWords(items, "reaction_words"),
    top_mu_lead: topMuLead,
    recommended_next_action:
      topMuLead.length > 0
        ? "上位のMu導線候補から、見抜き型・保存型・Mu導線型の順で投稿案を確認してください。"
        : "URL一括登録で市場素材を追加してください。",
    checked_at: new Date().toISOString(),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
