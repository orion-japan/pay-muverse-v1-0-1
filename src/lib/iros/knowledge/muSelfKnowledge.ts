// src/lib/iros/knowledge/muSelfKnowledge.ts
//
// MuSelf Knowledge Retriever
// - app_knowledge / v_app_knowledge に入れた MuSelf ナレッジを IROS-Mu 本線へ渡すための軽量取得層。
// - 本文は生成しない。
// - 一般ユーザー向けには MuTheory/master_only を表に出さない前提で、まず MuSelf を優先する。

import { createClient } from '@supabase/supabase-js';

type MuSelfKnowledgeItem = {
  id: string;
  area: string | null;
  intent: string | null;
  title: string;
  content: string;
  tags_normalized?: string | null;
};

export type ResolveMuSelfKnowledgeInput = {
  userText: unknown;
  focusResolution?: any;
  depthStage?: unknown;
  qCode?: unknown;
  limit?: number;
};

export type ResolveMuSelfKnowledgeResult = {
  enabled: boolean;
  query: string;
  items: MuSelfKnowledgeItem[];
  reason: string;
};

function normText(v: unknown, max = 240): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function uniqueTerms(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const v = normText(raw, 80);
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }

  return out;
}

function buildMuSelfSearchTerms(input: ResolveMuSelfKnowledgeInput): string[] {
  const userText = normText(input.userText, 180);
  const focus = input.focusResolution && typeof input.focusResolution === 'object'
    ? input.focusResolution
    : null;

  const terms: string[] = [];

  // まずユーザー発話を入れる
  if (userText) terms.push(userText);

  // FocusResolution が恋愛・連絡不安を検出したら、MuSelf ナレッジの主要語を補助検索に入れる
  const domain = String(focus?.domain ?? '');
  const enabled = focus?.enabled === true;

  if (enabled && domain === 'relationship_contact_anxiety') {
    terms.push('恋愛不安');
    terms.push('承認欲求');
    terms.push('もうひとつの自分');
    terms.push('自己受容');
  }

  // ユーザー発話の明示語
  if (/追いかけ|諦めきれ|待てない|連絡|返事|不安|苦しい/.test(userText)) {
    terms.push('恋愛不安');
    terms.push('もうひとつの自分');
  }

  if (/親|過干渉|母|父|家族/.test(userText)) {
    terms.push('親');
    terms.push('過干渉');
  }

  if (/ニコイチ|依存|境界線|一体/.test(userText)) {
    terms.push('ニコイチ');
  }

  if (/自己受容|自分を受け入れ|もうひとつの自分|統合/.test(userText)) {
    terms.push('自己受容');
    terms.push('もうひとつの自分');
  }

  return uniqueTerms(terms);
}

function makeOrFilter(terms: string[]): string {
  const safeTerms = terms
    .map((t) => t.replace(/[%_,]/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8);

  const parts: string[] = [];

  for (const t of safeTerms) {
    const pat = `%${t}%`;
    parts.push(`title.ilike.${pat}`);
    parts.push(`content.ilike.${pat}`);
    parts.push(`tags_normalized.ilike.${pat}`);
  }

  return parts.join(',');
}

export async function resolveMuSelfKnowledge(
  input: ResolveMuSelfKnowledgeInput,
): Promise<ResolveMuSelfKnowledgeResult> {
  const terms = buildMuSelfSearchTerms(input);
  const query = terms.join(' / ');

  if (terms.length === 0) {
    return {
      enabled: false,
      query,
      items: [],
      reason: 'no_terms',
    };
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return {
      enabled: false,
      query,
      items: [],
      reason: 'missing_supabase_env',
    };
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false },
  });

  const limit = Math.max(1, Math.min(Number(input.limit ?? 3), 5));

  const { data, error } = await sb
    .from('v_app_knowledge')
    .select('id,area,intent,title,content,tags_normalized,updated_at')
    .eq('area', 'MuSelf')
    .or(makeOrFilter(terms))
    .order('updated_at', { ascending: false })
    .limit(12);

  if (error) {
    return {
      enabled: false,
      query,
      items: [],
      reason: `db_error:${error.message}`,
    };
  }

  const rawItems = Array.isArray(data) ? data : [];

  const items = rawItems
    .filter((r: any) => String(r?.area ?? '') === 'MuSelf')
    .filter((r: any) => String(r?.intent ?? '') !== 'master_only')
    .map((r: any) => ({
      id: String(r.id ?? ''),
      area: r.area ?? null,
      intent: r.intent ?? null,
      title: String(r.title ?? '').trim(),
      content: normText(r.content, 700),
      tags_normalized: r.tags_normalized ?? null,
    }))
    .filter((r) => r.id && r.title && r.content)
    .slice(0, limit);

  return {
    enabled: items.length > 0,
    query,
    items,
    reason: items.length > 0 ? 'matched_mu_self_knowledge' : 'no_mu_self_match',
  };
}
