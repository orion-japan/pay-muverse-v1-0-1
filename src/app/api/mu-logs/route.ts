// src/app/api/mu-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY; // どちらの名でも拾う
const DEBUG = process.env.DEBUG_OPS_MULOGS === '1';

// --- ログ（キーはマスクして出力）
function mask(v?: string | null) {
  if (!v) return 'undefined';
  return `${v.slice(0, 4)}…(len:${v.length})`;
}
function log(...args: any[]) {
  if (DEBUG) console.log('[mu-logs]', ...args);
}

function sbAdmin() {
  if (!SUPABASE_URL) throw new Error('env:NEXT_PUBLIC_SUPABASE_URL missing');
  if (!SERVICE_ROLE) throw new Error('env:SUPABASE_SERVICE_ROLE missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

/**
 * GET /api/mu-logs
 *  - ?user_code=U-xxxxx ・・・会話一覧（最新順）
 *  - ?conv_id=MU-xxxxx ・・・会話詳細（ターン一覧）
 *  - ?page_size=50（1～200）
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const user_code = sp.get('user_code')?.trim() || null;
  const conv_id = sp.get('conv_id')?.trim() || null;
  const pageSize = Math.max(1, Math.min(200, Number(sp.get('page_size') || 50)));

  // 起動時の環境確認（マスク済み）
  log('env', {
    NODE_ENV: process.env.NODE_ENV,
    SUPABASE_URL: SUPABASE_URL ? 'set' : 'undefined',
    SERVICE_ROLE: mask(SERVICE_ROLE || null),
  });
  log('request', { path: url.pathname, user_code, conv_id, pageSize });

  try {
    const sb = sbAdmin();

    if (conv_id) {
      // ── 会話詳細
      log('query: conversation by conv_id');
      const { data: convo, error: cErr } = await sb
        .from('mu_conversations')
        .select('id,user_code,title,origin_app,last_turn_at,created_at,updated_at')
        .eq('id', conv_id)
        .maybeSingle();

      if (cErr) {
        console.error('[mu-logs] convo select error:', cErr);
        return NextResponse.json({ error: cErr.message }, { status: 500 });
      }
      if (!convo) {
        log('conversation not found', conv_id);
        return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
      }

      // 件数だけ先に（RLS切り分け用）
      const { count: turnsCount, error: cntErr } = await sb
        .from('mu_turns')
        .select('id', { count: 'exact', head: true })
        .eq('conv_id', conv_id);
      if (cntErr) console.error('[mu-logs] turns count error:', cntErr);
      log('turns count:', turnsCount);

      const { data: turns, error: tErr } = await sb
        .from('mu_turns')
        .select('id,conv_id,role,content,meta,used_credits,source_app,sub_id,attachments,created_at')
        .eq('conv_id', conv_id)
        .order('created_at', { ascending: true })
        .limit(2000);
      if (tErr) {
        console.error('[mu-logs] turns select error:', tErr);
        return NextResponse.json({ error: tErr.message }, { status: 500 });
      }

      log('turns returned:', turns?.length ?? 0);
      return NextResponse.json({
        conversation: convo,
        turns: turns ?? [],
        turns_count: turnsCount ?? 0,
      });
    }

    if (user_code) {
      // ── ユーザーの会話一覧（厳密一致）
      log('query: conversations by user_code');
      const { data: conversations, error: listErr } = await sb
        .from('mu_conversations')
        .select('id,user_code,title,origin_app,last_turn_at,created_at,updated_at')
        .eq('user_code', user_code)
        .order('last_turn_at', { ascending: false })
        .limit(pageSize);

      if (listErr) {
        console.error('[mu-logs] list select error:', listErr);
        return NextResponse.json({ error: listErr.message }, { status: 500 });
      }

      log('conversations returned:', conversations?.length ?? 0);
      return NextResponse.json({ conversations: conversations ?? [] });
    }

    return NextResponse.json({ error: 'Specify either user_code or conv_id.' }, { status: 400 });
  } catch (e: any) {
    console.error('[mu-logs] fatal:', e);
    const msg = e?.message || 'failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
