// /app/api/album/insert/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Supabase (server-side, service_role) */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(url, serviceKey);

/** === 調整ポイント（あなたの環境に合わせる） === */
const DB_TABLE = 'posts'; // 保存先テーブル
const DEFAULT_VISIBILITY = 'private'; // Album検索が private の場合

/** テーブルの存在カラムを取得 */
async function getColumns(table: string): Promise<Set<string>> {
  const { data, error } = await supa
    .from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_name', table);
  if (error) throw error;
  return new Set((data || []).map((r: any) => r.column_name as string));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 必須最小限
    for (const key of ['user_code', 'title', 'bucket', 'path', 'mime'] as const) {
      if (!body?.[key]) {
        return NextResponse.json({ error: `missing: ${key}` }, { status: 400 });
      }
    }

    const cols = await getColumns(DB_TABLE);

    // あれば詰める（存在しない列はスキップ）
    const row: Record<string, any> = {};
    if (cols.has('user_code')) row['user_code'] = String(body.user_code);
    if (cols.has('title')) row['title'] = body.title;
    if (cols.has('visibility')) row['visibility'] = DEFAULT_VISIBILITY;
    if (cols.has('is_album')) row['is_album'] = true;
    if (cols.has('is_self')) row['is_self'] = true;
    if (cols.has('storage_bucket')) row['storage_bucket'] = body.bucket;
    if (cols.has('storage_path')) row['storage_path'] = body.path;
    if (cols.has('mime_type')) row['mime_type'] = body.mime;

    // album:// 参照を入れられるカラムがあれば利用
    const albumUrl = `album://${body.path}`;
    if (cols.has('media_urls')) row['media_urls'] = [albumUrl];
    else if (cols.has('media')) row['media'] = [albumUrl];
    else if (cols.has('thumbnail_url')) row['thumbnail_url'] = albumUrl;

    if (cols.has('tags')) row['tags'] = ['album', 'self'];
    if (cols.has('created_by_user_code')) row['created_by_user_code'] = String(body.user_code);

    // 何も入らない場合は情報だけ返す（クライアントは警告ログで続行）
    if (Object.keys(row).length === 0) {
      return NextResponse.json({ ok: false, note: `No compatible columns on '${DB_TABLE}'` });
    }

    const { data, error } = await supa.from(DB_TABLE).insert(row).select('id').single();
    if (error) return NextResponse.json({ error }, { status: 400 });

    return NextResponse.json({ ok: true, id: data?.id });
  } catch (e: any) {
    // APIとしては 200/ok:false を返してもよいが、原因調査しやすく 500 を返す
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
