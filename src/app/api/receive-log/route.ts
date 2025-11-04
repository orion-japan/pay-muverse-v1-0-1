// app/api/receive-log/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// 環境変数
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function withCORS(body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// POST: MU 側からのログ受信
export async function POST(req: Request) {
  try {
    const { source, timestamp, message } = await req.json();

    // DB保存
    const { error } = await supabase.from('mu_logs').insert({
      source: source || 'unknown',
      timestamp: timestamp || new Date().toISOString(),
      message: message || '',
    });

    if (error) {
      console.error('❌ ログ保存失敗:', error);
      return withCORS({ ok: false, error: error.message }, 500);
    }

    console.log(`✅ ログ保存 [${source}] ${message}`);
    return withCORS({ ok: true });
  } catch (err: any) {
    console.error('❌ ログ受信エラー:', err.message);
    return withCORS({ ok: false, error: err.message }, 500);
  }
}

// GET: ログ一覧取得
export async function GET() {
  const { data, error } = await supabase
    .from('mu_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(50);

  if (error) {
    return withCORS({ ok: false, error: error.message }, 500);
  }
  return withCORS({ ok: true, logs: data });
}

// OPTIONS: CORS用
export async function OPTIONS() {
  return withCORS({ ok: true });
}
