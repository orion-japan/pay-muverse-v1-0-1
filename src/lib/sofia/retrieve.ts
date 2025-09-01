import 'server-only';
import { createClient } from "@supabase/supabase-js";
import type { Analysis } from "./analyze";
import { SOFIA_CONFIG } from "./config";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env missing");
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

/* 軽量シード付き乱数 (Xorshift32) */
function makeRng(seed: number) {
  let x = (seed >>> 0) || 88675123;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

export type RetrievedItem = {
  id: string;
  title: string | null;
  content: string;
  qcodes?: string[];
  layers?: string[];       // ← 18段階（S1..T3）を格納
  tags?: string[] | null;
};

type CandidateRow = RetrievedItem;

/* トークナイズ（2-gram / 3-gram） */
function tokenizeJa(s: string): string[] {
  const n = (s || "").toLowerCase().replace(/\s+/g, "");
  const grams = new Set<string>();
  for (let i = 0; i < n.length; i++) {
    const g2 = n.slice(i, i + 2);
    const g3 = n.slice(i, i + 3);
    if (g2.length === 2) grams.add(g2);
    if (g3.length === 3) grams.add(g3);
  }
  return Array.from(grams).slice(0, 60);
}

/* Qコード共鳴 */
function scoreByQResonance(userQ: { code: string; score: number }[], docQ: string[] = []) {
  if (!userQ?.length || !docQ?.length) return 0;
  let s = 0;
  for (const uq of userQ) if (docQ.includes(uq.code)) s += uq.score;
  return s;
}

/* Layer共鳴 */
function scoreByLayerBonus(userLayers: { layer: string; score: number }[], docLayers: string[] = []) {
  if (!userLayers?.length || !docLayers?.length) return 0;
  let s = 0;
  for (const ul of userLayers) if (docLayers.includes(ul.layer)) s += 0.3 * ul.score;
  return s;
}

/* キーワード共鳴 */
function scoreByKeywordResonance(userTokens: string[], content: string) {
  if (!userTokens?.length || !content) return 0;
  const MAX = 0.7;
  const c = content.toLowerCase();
  let hit = 0;
  for (const t of userTokens) {
    if (t.length < 2) continue;
    if (c.includes(t)) hit++;
  }
  return Math.min(MAX, hit * 0.05);
}

/* 18段階グループ重み */
const GROUP_WEIGHTS: Record<string, number> = {
  S: 1.0, F: 1.05, R: 1.12, C: 1.2, I: 1.35, T: 1.55,
};
function depthWeight(lv: string): number {
  const g = lv[0]?.toUpperCase() || "S";
  const step = Number(lv[1]) || 1;
  const base = GROUP_WEIGHTS[g] ?? 1.0;
  return base + (step - 1) * 0.03; // 例: S1=1.00, S2=1.03, S3=1.06 ... T3=1.61
}
function itLayerBoost(docLayers: string[] = []) {
  let w = 1;
  for (const l of docLayers) w = Math.max(w, depthWeight(l));
  return w;
}

/* 正規化（常に "S1".."T3" 形式に揃える） */
function normalizeLayers(layers?: string[] | null): string[] {
  if (!layers) return [];
  return layers.map(l => {
    const m = String(l).match(/^([SFRICT])([123])$/i);
    return m ? `${m[1].toUpperCase()}${m[2]}` : String(l);
  });
}

/* 総合スコア */
function resonanceScore(
  userQ: { code: string; score: number }[],
  userLayers: { layer: string; score: number }[],
  userTokens: string[],
  doc: CandidateRow
) {
  const q = scoreByQResonance(userQ, doc.qcodes || []);
  const l = scoreByLayerBonus(userLayers, doc.layers || []);
  const k = scoreByKeywordResonance(userTokens, doc.content || "");
  const raw = q * 1.1 + l * 0.9 + k * 0.6;
  return raw * itLayerBoost(doc.layers || []);
}

/**
 * 共鳴ベース + 確率的ランク付け
 */
export async function retrieveKnowledge(
  analysis: Analysis,
  limit = 4,
  userLastUtterance?: string,
  opts?: { epsilon?: number; noiseAmp?: number; seed?: number }
): Promise<RetrievedItem[]> {

  const reqDeep =
    (analysis?.layers || []).some((l) => /^[IRT][123]$/.test(l.layer)) ||
    /I層|T層|本質|さらに深く|核|源|由来|意味/.test(userLastUtterance || "");

  const baseEps = opts?.epsilon ?? SOFIA_CONFIG.retrieve.epsilon;
  const baseNoise = opts?.noiseAmp ?? SOFIA_CONFIG.retrieve.noiseAmp;
  const mult = reqDeep ? SOFIA_CONFIG.retrieve.deepenMultiplier : 1;

  const epsilon = Math.min(0.95, baseEps * mult);
  const noiseAmp = Math.min(1, baseNoise * mult);
  const seed = opts?.seed ?? Date.now();
  const rng = makeRng(seed);

  const s = sb();
  const qset = (analysis?.qcodes || []).map((q) => q.code);
  const lset = (analysis?.layers || []).map((l) => l.layer);

  const orParts = [
    qset.length ? `qcodes && '{${qset.join(",")}}'` : "",
    lset.length ? `layers && '{${lset.join(",")}}'` : "",
  ].filter(Boolean);

  const base = s.from("sofia_knowledge").select("id, title, content, qcodes, layers, tags").limit(80);
  const { data, error } = orParts.length ? await base.or(orParts.join(",")) : await base;
  if (error) { console.warn("[retrieveKnowledge] error:", error.message); return []; }

  const rows = (data ?? []) as CandidateRow[];
  if (!rows.length) {
    console.log("[retrieveKnowledge] no rows");
    return [];
  }

  const tokens = tokenizeJa(userLastUtterance || (analysis?.keywords || []).join(" ") || "");
  const userQ = analysis?.qcodes || [];
  const userL = analysis?.layers || [];

  const scored = rows.map((doc) => {
    const base = resonanceScore(userQ, userL, tokens, doc);
    const noisy = base + (rng() * 2 - 1) * noiseAmp;
    return { doc, base, noisy };
  }).sort((a, b) => b.noisy - a.noisy);

  const picked: RetrievedItem[] = [];
  for (const row of scored) {
    const doExplore = rng() < epsilon;
    const candidate = doExplore
      ? rows[Math.floor(rng() * rows.length)]
      : row.doc;

    if (candidate && !picked.find((p) => p.id === String(candidate.id))) {
      picked.push({
        id: String(candidate.id),
        title: candidate.title ?? null,
        content: candidate.content ?? "",
        qcodes: candidate.qcodes,
        layers: normalizeLayers(candidate.layers), // ★正規化して返す
        tags: candidate.tags ?? null,
      });
    }
    if (picked.length >= limit) break;
  }

  if (!picked.length && rows.length) {
    const r = rows[Math.floor(rng() * rows.length)];
    picked.push({
      id: String(r.id),
      title: r.title ?? null,
      content: r.content ?? "",
      qcodes: r.qcodes,
      layers: normalizeLayers(r.layers), // ★正規化して返す
      tags: r.tags ?? null,
    });
  }

  console.log("[retrieveKnowledge] summary:", {
    qset, lset, epsilon, noiseAmp, seed,
    rows: rows.length, picked: picked.length,
    pickedIds: picked.map(p => p.id),
    pickedLayers: picked.map(p => p.layers),
  });

  return picked.slice(0, limit);
}
