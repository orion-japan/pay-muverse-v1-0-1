import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function collectIds(url: URL): string[] {
  // ids=a&ids=b も ids=a,b もOKにする
  const all = url.searchParams.getAll('ids')
  const flat = all.flatMap(v => v.split(','))
  return [...new Set(flat.map(s => s.trim()).filter(Boolean))]
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ids = collectIds(url)

  // 期待する返却形に合わせ、空なら空配列
  if (!ids.length) return NextResponse.json([])

  // Service Role があれば使う（RLS影響を受けない）/ 無ければ anon でフォールバック
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  )

  // thread_id が ids のコメントを全部取って、Node側で集計
  const { data, error } = await supabase
    .from('posts')
    .select('thread_id, created_at')
    .in('thread_id', ids)

  if (error) {
    // 失敗時は200で空配列返すより、エラーの方がデバッグしやすい
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // 初期ゼロ化
  const map = new Map<string, { reply_count: number; last_commented_at: string | null }>()
  ids.forEach(id => map.set(id, { reply_count: 0, last_commented_at: null }))

  for (const row of data || []) {
    const tid = String((row as any).thread_id)
    const ca = String((row as any).created_at)
    const m = map.get(tid)
    if (!m) continue
    m.reply_count += 1
    if (!m.last_commented_at || ca > m.last_commented_at) m.last_commented_at = ca
  }

  // クライアントが扱いやすい配列で返却（Self/Threadページの実装と互換）
  const result = [...map.entries()].map(([post_id, v]) => ({
    post_id,
    reply_count: v.reply_count,
    last_commented_at: v.last_commented_at,
  }))

  return NextResponse.json(result)
}
