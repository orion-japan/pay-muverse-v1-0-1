// src/lib/sofia/retrieve.ts
import { createClient } from "@supabase/supabase-js";
import type { Analysis } from "./analyze";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env missing");
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

/* ---------------------------
   軽量シード付き乱数 (Xorshift32)
---------------------------- */
function makeRng(seed: number) {
  let x = seed >>> 0 || 88675123;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff); // 0..1
  };
}

export type RetrievedItem = {
  id: string;
  title: string | null;
  content: string;
  qcodes?: string[];
  layers?: string[];
  tags?: string[] | null;
};

type CandidateRow = RetrievedItem;

/* ---------------------------
   共鳴スコア関数群
---------------------------- */
function tokenizeJa(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
}

function scoreByQResonance(userQ: { code: string; score: number }[], docQ: string[] = []) {
  if (!userQ.length || !docQ.length) return 0;
  let s = 0;
  for (const uq of userQ) if (docQ.includes(uq.code)) s += uq.score;
  return s;
}

function scoreByLayerBonus(userLayers: { layer: string; score: number }[], docLayers: string[] = []) {
  if (!userLayers.length || !docLayers.length) return 0;
  let s = 0;
  for (const ul of userLayers) if (docLayers.includes(ul.layer)) s += 0.3 * ul.score;
  return s;
}

function scoreByKeywordResonance(userTokens: string[], content: string) {
  if (!userTokens.length || !content) return 0;
  const MAX = 0.7;
  const c = content.toLowerCase();
  let hit = 0;
  for (const t of userTokens) {
    if (t.length < 2) continue;
    if (c.includes(t)) hit++;
  }
  return Math.min(MAX, hit * 0.05);
}

function resonanceScore(
  userQ: { code: string; score: number }[],
  userLayers: { layer: string; score: number }[],
  userTokens: string[],
  doc: CandidateRow
) {
  const q = scoreByQResonance(userQ, doc.qcodes || []);
  const l = scoreByLayerBonus(userLayers, doc.layers || []);
  const k = scoreByKeywordResonance(userTokens, doc.content || "");
  return q * 1.0 + l * 1.0 + k * 1.0;
}

/* ---------------------------
   共鳴ベース + 確率的ランク付け
---------------------------- */
/**
 * @param epsilon   ランダム探索率 (例: 0.3 = 30%)
 * @param noiseAmp  ノイズ振幅 (例: 0.15)
 * @param seed      会話ごとの乱数シード
 */
export async function retrieveKnowledge(
  analysis: Analysis,
  limit = 4,
  userLastUtterance?: string,
  opts?: { epsilon?: number; noiseAmp?: number; seed?: number }
): Promise<RetrievedItem[]> {
  const { epsilon = 0.3, noiseAmp = 0.15, seed = Date.now() } = opts ?? {};
  const rng = makeRng(seed);

  const s = sb();
  const qset = analysis.qcodes.map(q => q.code);
  const lset = analysis.layers.map(l => l.layer);

  // 候補: Qコードまたは層が一致するレコード
  const orParts = [
    qset.length ? `qcodes && '{${qset.join(",")}}'` : "",
    lset.length ? `layers && '{${lset.join(",")}}'` : "",
  ].filter(Boolean);

  const base = s.from("sofia_knowledge")
    .select("id, title, content, qcodes, layers, tags")
    .limit(80);

  const { data, error } = orParts.length ? await base.or(orParts.join(",")) : await base;
  if (error) {
    console.warn("[retrieveKnowledge] error:", error.message);
    return [];
  }
  const rows = (data ?? []) as CandidateRow[];

  // 共鳴スコア算出
  const tokens = tokenizeJa(userLastUtterance || analysis.keywords?.join(" ") || "");
  const userQ = analysis.qcodes || [];
  const userL = analysis.layers || [];

  const scored = rows.map(doc => {
    const base = resonanceScore(userQ, userL, tokens, doc);
    const noisy = base + (rng() * 2 - 1) * noiseAmp; // ±noiseAmp
    return { doc, base, noisy };
  });

  // スコア + ノイズでソート
  const sorted = scored.sort((a, b) => b.noisy - a.noisy);

  // ε-greedy: 一部はランダム、残りはスコア上位
  const picked: RetrievedItem[] = [];
  for (const row of sorted) {
    const doExplore = rng() < epsilon;
    if (doExplore && rows.length) {
      const randDoc = rows[Math.floor(rng() * rows.length)];
      if (!picked.find(p => p.id === String(randDoc.id))) {
        picked.push({
          id: String(randDoc.id),
          title: randDoc.title ?? null,
          content: randDoc.content ?? "",
          qcodes: randDoc.qcodes,
          layers: randDoc.layers,
          tags: randDoc.tags ?? null,
        });
      }
    } else {
      const d = row.doc;
      if (!picked.find(p => p.id === String(d.id))) {
        picked.push({
          id: String(d.id),
          title: d.title ?? null,
          content: d.content ?? "",
          qcodes: d.qcodes,
          layers: d.layers,
          tags: d.tags ?? null,
        });
      }
    }
    if (picked.length >= limit) break;
  }

  // 万一全てスコア0なら完全ランダム保険
  if (!picked.length && rows.length) {
    const r = rows[Math.floor(rng() * rows.length)];
    picked.push({
      id: String(r.id),
      title: r.title ?? null,
      content: r.content ?? "",
      qcodes: r.qcodes,
      layers: r.layers,
      tags: r.tags ?? null,
    });
  }

  return picked.slice(0, limit);
}
