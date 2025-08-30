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

export type RetrievedItem = {
  id: string;
  title: string | null;
  content: string;
  qcodes?: string[];      // ← あると有利（スコアに使う）
  layers?: string[];      // ← あると有利（I/Tボーナス）
  tags?: string[] | null; // 任意
};

type CandidateRow = {
  id: string;
  title: string | null;
  content: string;
  qcodes?: string[];
  layers?: string[];
  tags?: string[] | null;
};

/** 小さな前処理（ひらがな・全角は必要なら別途） */
function tokenizeJa(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
}

/** Qコード共鳴スコア: ユーザーの Q 分布 × 文書の Q タグの内積っぽい加点 */
function scoreByQResonance(userQ: { code: string; score: number }[], docQ: string[] = []) {
  if (!userQ.length || !docQ.length) return 0;
  let s = 0;
  for (const uq of userQ) {
    if (docQ.includes(uq.code)) s += uq.score;              // 完全一致を素直に加点
    // “近縁Q”のゆるボーナスを入れたい場合はここで近接表を噛ませる
  }
  return s; // 最大: Σ userQ.score
}

/** 層ボーナス（I/T が噛み合うと少し上げる） */
function scoreByLayerBonus(userLayers: { layer: string; score: number }[], docLayers: string[] = []) {
  if (!userLayers.length || !docLayers.length) return 0;
  let s = 0;
  for (const ul of userLayers) {
    if (docLayers.includes(ul.layer)) s += 0.3 * ul.score;  // 小さめのボーナス
    // I系とT系の“親和表”を用意して近接加点してもOK
  }
  return s;
}

/** キーワードの素朴な共鳴（ユーザー発話の語と本文の出現で加点・上限あり） */
function scoreByKeywordResonance(userTokens: string[], content: string) {
  if (!userTokens.length || !content) return 0;
  const MAX = 0.7; // 取りすぎ防止
  const c = content.toLowerCase();
  let hit = 0;
  for (const t of userTokens) {
    if (t.length < 2) continue;
    if (c.includes(t)) hit++;
  }
  return Math.min(MAX, hit * 0.05); // 20語ヒットで上限到達
}

/** 総合スコア */
function resonanceScore(params: {
  userQ: { code: string; score: number }[];
  userLayers: { layer: string; score: number }[];
  userTokens: string[];
  doc: CandidateRow;
}) {
  const { userQ, userLayers, userTokens, doc } = params;
  const q = scoreByQResonance(userQ, doc.qcodes || []);
  const l = scoreByLayerBonus(userLayers, doc.layers || []);
  const k = scoreByKeywordResonance(userTokens, doc.content || "");
  // 重みは好みに合わせて調整
  return q * 1.0 + l * 1.0 + k * 1.0;
}

/**
 * Qコード共鳴ベースのナレッジ検索
 * - DBはタグ一致で候補取得（広めに）
 * - 並び替えはアプリ側の「共鳴スコア」で
 */
export async function retrieveKnowledge(
  analysis: Analysis,
  limit = 4,
  userLastUtterance?: string
): Promise<RetrievedItem[]> {
  const s = sb();
  const qset = analysis.qcodes.map(q => q.code);
  const lset = analysis.layers.map(l => l.layer);

  // 1) 候補を広めに取得（Q or 層 いずれか合致）
  const orParts = [
    qset.length ? `qcodes && '{${qset.join(",")}}'` : "",  // ← overlap（配列の積が非空）
    lset.length ? `layers && '{${lset.join(",")}}'` : "",
  ].filter(Boolean);

  // どちらも無ければ全体から数十件だけ拾う（保険）
  const base = s.from("sofia_knowledge")
    .select("id, title, content, qcodes, layers, tags")
    .limit(80);

  const query = orParts.length ? base.or(orParts.join(",")) : base;

  const { data, error } = await query;
  if (error) {
    console.warn("[retrieveKnowledge] skip:", error.message);
    return [];
  }

  const userTokens = tokenizeJa(userLastUtterance || analysis.keywords?.join(" ") || "");
  const userQ = analysis.qcodes || [];
  const userLayers = analysis.layers || [];

  // 2) 共鳴スコアで並べ替え
  const ranked = (data as CandidateRow[]).map(doc => {
    const score = resonanceScore({ userQ, userLayers, userTokens, doc });
    return { doc, score };
  }).sort((a, b) => b.score - a.score);

  // 3) 上位を返す（スコア0は弾く）
  return ranked
    .filter(r => r.score > 0)
    .slice(0, limit)
    .map(({ doc }) => ({
      id: String(doc.id),
      title: doc.title ?? null,
      content: doc.content ?? "",
      qcodes: doc.qcodes,
      layers: doc.layers,
      tags: doc.tags ?? null,
    }));
}
