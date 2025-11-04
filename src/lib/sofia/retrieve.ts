// src/lib/sofia/retrieve.ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Analysis } from './analyze';
import { SOFIA_CONFIG } from './config';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env missing');
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

/* 軽量シード付き乱数 (Xorshift32) */
function makeRng(seed: number) {
  let x = seed >>> 0 || 88675123;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

/* ===============================
   返却型（既存インターフェイス維持）
   =============================== */
export type RetrievedItem = {
  id: string;
  title: string | null;
  content: string;
  qcodes?: string[]; // app_knowledge には無いが、互換のため空配列で返す
  layers?: string[]; // 同上
  tags?: string[] | null; // app_knowledge.tags は text なので配列化して返す
};

type CandidateRow = RetrievedItem;

/* トークナイズ（2-gram / 3-gram） */
function tokenizeJa(s: string): string[] {
  const n = (s || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < n.length; i++) {
    const g2 = n.slice(i, i + 2);
    const g3 = n.slice(i, i + 3);
    if (g2.length === 2) grams.add(g2);
    if (g3.length === 3) grams.add(g3);
  }
  return Array.from(grams).slice(0, 60);
}

/* Qコード共鳴（app_knowledge では常に0になるが、互換のため残す） */
function scoreByQResonance(userQ: { code: string; score: number }[], docQ: string[] = []) {
  if (!userQ?.length || !docQ?.length) return 0;
  let s = 0;
  for (const uq of userQ) if (docQ.includes(uq.code)) s += uq.score;
  return s;
}

/* Layer共鳴（app_knowledge では常に0になるが、互換のため残す） */
function scoreByLayerBonus(
  userLayers: { layer: string; score: number }[],
  docLayers: string[] = [],
) {
  if (!userLayers?.length || !docLayers?.length) return 0;
  let s = 0;
  for (const ul of userLayers) if (docLayers.includes(ul.layer)) s += 0.3 * ul.score;
  return s;
}

/* キーワード共鳴 */
function scoreByKeywordResonance(userTokens: string[], content: string) {
  if (!userTokens?.length || !content) return 0;
  const MAX = 0.9; // app_knowledge ではキーワード重要度を少し強める
  const c = content.toLowerCase();
  let hit = 0;
  for (const t of userTokens) {
    if (t.length < 2) continue;
    if (c.includes(t)) hit++;
  }
  return Math.min(MAX, hit * 0.05);
}

/* 18段階グループ重み（互換性維持のため残置） */
const GROUP_WEIGHTS: Record<string, number> = {
  S: 1.0,
  F: 1.05,
  R: 1.12,
  C: 1.2,
  I: 1.35,
  T: 1.55,
};
function depthWeight(lv: string): number {
  const g = lv[0]?.toUpperCase() || 'S';
  const step = Number(lv[1]) || 1;
  const base = GROUP_WEIGHTS[g] ?? 1.0;
  return base + (step - 1) * 0.03; // 例: S1=1.00, ... T3=1.61
}
function itLayerBoost(docLayers: string[] = []) {
  let w = 1;
  for (const l of docLayers) w = Math.max(w, depthWeight(l));
  return w;
}

/* 正規化（互換性維持のため残置） */
function normalizeLayers(layers?: string[] | null): string[] {
  if (!layers) return [];
  return layers.map((l) => {
    const m = String(l).match(/^([SFRICT])([123])$/i);
    return m ? `${m[1].toUpperCase()}${m[2]}` : String(l);
  });
}

/* 総合スコア */
function resonanceScore(
  userQ: { code: string; score: number }[],
  userLayers: { layer: string; score: number }[],
  userTokens: string[],
  doc: CandidateRow,
) {
  const q = scoreByQResonance(userQ, doc.qcodes || []);
  const l = scoreByLayerBonus(userLayers, doc.layers || []);
  const k = scoreByKeywordResonance(userTokens, doc.content || '');
  const raw = q * 1.1 + l * 0.9 + k * 0.8; // ← キーワード寄りにウェイト
  return raw * itLayerBoost(doc.layers || []);
}

/* tags(text) → string[] に整形 */
function parseTagsText(tagsText?: string | null): string[] {
  if (!tagsText) return [];
  return String(tagsText)
    .split(/[,/、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16);
}

/* ====== ここから本体：app_knowledge を読む版 ====== */

/**
 * 共鳴ベース + 確率的ランク付け（取得元：app_knowledge）
 *
 * - 返却型・関数名は既存と同じ
 * - qcodes/layers は app 側に無いので空配列で返す（互換維持）
 */
export async function retrieveKnowledge(
  analysis: Analysis,
  limit = 4,
  userLastUtterance?: string,
  opts?: { epsilon?: number; noiseAmp?: number; seed?: number },
): Promise<RetrievedItem[]> {
  const reqDeep =
    (analysis?.layers || []).some((l) => /^[IRT][123]$/.test(l.layer)) ||
    /I層|T層|本質|さらに深く|核|源|由来|意味/.test(userLastUtterance || '');

  const baseEps = opts?.epsilon ?? SOFIA_CONFIG.retrieve.epsilon;
  const baseNoise = opts?.noiseAmp ?? SOFIA_CONFIG.retrieve.noiseAmp;
  const mult = reqDeep ? (SOFIA_CONFIG.retrieve.deepenMultiplier ?? 1) : 1;

  const epsilon = Math.min(0.95, baseEps * mult);
  const noiseAmp = Math.min(1, baseNoise * mult);
  const seed = opts?.seed ?? Date.now();
  const rng = makeRng(seed);

  const s = sb();
  const KB_TABLE = 'app_knowledge';

  // キーワード（発話＋analysis.keywords）
  const keyword = (userLastUtterance || (analysis?.keywords || []).join(' ') || '').trim();

  // 基本検索：title / content / tags(text) を横断 ilike
  let q = s.from(KB_TABLE).select('id, title, content, tags, updated_at').limit(80);

  if (keyword) {
    const esc = keyword.replace(/%/g, '\\%').replace(/_/g, '\\_');
    q = q.or(`title.ilike.%${esc}%,content.ilike.%${esc}%,tags.ilike.%${esc}%`);
  }

  const { data, error } = await q;
  if (error) {
    console.warn('[retrieveKnowledge/app_knowledge] error:', error.message);
    return [];
  }

  let rows = (data ?? []) as Array<{
    id: string;
    title: string | null;
    content: string | null;
    tags?: string | null;
    updated_at?: string | null;
  }>;

  // 0件なら新着フォールバック（無条件 N 件）
  if (!rows.length) {
    const fb = await s
      .from(KB_TABLE)
      .select('id, title, content, tags, updated_at')
      .order('updated_at', { ascending: false })
      .limit(Math.max(limit, 8));
    rows = (fb.data ?? []) as typeof rows;

    if (!rows.length) {
      console.log('[retrieveKnowledge] no rows (app_knowledge fallback also empty)');
      return [];
    }
  }

  // スコア計算（title/tags も内容に足して評価）
  const tokens = tokenizeJa(keyword);
  const userQ = analysis?.qcodes || []; // 空でもOK
  const userL = analysis?.layers || []; // 空でもOK

  const scored = rows
    .map((raw) => {
      const doc: CandidateRow = {
        id: String(raw.id),
        title: raw.title ?? null,
        content: `${raw.title ?? ''} ${raw.content ?? ''} ${raw.tags ?? ''}`, // スコア用
        qcodes: [], // 互換のため空
        layers: [], // 互換のため空
        tags: parseTagsText(raw.tags), // 表示用・返却用
      };
      const base = resonanceScore(userQ, userL, tokens, doc);
      const noisy = base + (rng() * 2 - 1) * noiseAmp;
      return {
        doc: {
          ...doc,
          // 返却は元の本文（title を混ぜない素の content）にしておく
          content: raw.content ?? '',
        },
        base,
        noisy,
      };
    })
    .sort((a, b) => b.noisy - a.noisy);

  const picked: RetrievedItem[] = [];
  for (const row of scored) {
    const doExplore = rng() < epsilon;
    const candidate = doExplore ? scored[Math.floor(rng() * scored.length)]?.doc : row.doc;

    if (candidate && !picked.find((p) => p.id === String(candidate.id))) {
      picked.push({
        id: candidate.id,
        title: candidate.title,
        content: candidate.content,
        qcodes: [], // 構造維持
        layers: [], // 構造維持
        tags: candidate.tags ?? [],
      });
    }
    if (picked.length >= limit) break;
  }

  if (!picked.length && rows.length) {
    // 念押しフォールバック（最新1件）
    const r = rows[0];
    picked.push({
      id: String(r.id),
      title: r.title ?? null,
      content: r.content ?? '',
      qcodes: [],
      layers: [],
      tags: parseTagsText(r.tags),
    });
  }

  console.log('[retrieveKnowledge/app]', {
    table: KB_TABLE,
    keyword,
    rows: rows.length,
    picked: picked.length,
    pickedIds: picked.map((p) => p.id),
  });

  return picked.slice(0, limit);
}
