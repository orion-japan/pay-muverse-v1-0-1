export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// Supabase (サービスロールで読み取り。RLS無効でも確実に通す)
function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
}

// 文字列 → トークン分解（全角空白・スラッシュ・読点なども区切る）
function tokenize(q: string) {
  return q
    .replace(/Ｑ/g, 'Q')
    .split(/[,\s　/／、・|]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Qコード検出（Q1〜Q5）
function detectQcode(q: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null {
  const m = q.replace(/Ｑ/g, 'Q').match(/\bQ([1-5])\b/i);
  return m ? (`Q${m[1]}` as any) : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ items: [] });

  const s = sb();

  const qcode = detectQcode(q);
  const toks = tokenize(q);

  // 基本セレクト
  let query = s
    .from('v_app_knowledge') // ← ビューを使う（tags_normalized がある）
    .select('id,title,content,tags_normalized,updated_at')
    .limit(10);

  // Qコードが来たら最優先で title 一致を見る
  if (qcode) {
    const { data, error } = await query.eq('title', qcode);
    if (!error && data && data.length) {
      return NextResponse.json({
        items: data.map((r) => ({ title: r.title, content: r.content })),
      });
    }
  }

  // トークンで OR 検索（title/content/tags_normalized）
  if (toks.length) {
    const orParts: string[] = [];
    for (const t of toks) {
      const pat = `%${t}%`;
      orParts.push(`title.ilike.${pat}`);
      orParts.push(`content.ilike.${pat}`);
      orParts.push(`tags_normalized.ilike.${pat}`);
    }
    query = query.or(orParts.join(',')).order('updated_at', { ascending: false });
  } else {
    // 万一トークン化できなければ、素直に全文一致
    query = query.or(
      [`title.ilike.%${q}%`, `content.ilike.%${q}%`, `tags_normalized.ilike.%${q}%`].join(','),
    );
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ items: [], error: String(error.message || error) }, { status: 500 });
  }

  return NextResponse.json({
    items: (data ?? []).map((r) => ({ title: r.title, content: r.content })),
  });
}
