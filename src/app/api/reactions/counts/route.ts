// /src/app/api/reactions/counts/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: Request) {
  try {
    const { postIds }:{ postIds:string[] } = await req.json()
    if (!Array.isArray(postIds) || !postIds.length) {
      return NextResponse.json({ countsByPost:{} })
    }

    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    // 1) まずビューがあればそれを使う
    const { data:fromView, error:viewErr } = await supabase
      .from('v_post_reaction_counts')
      .select('post_id,r_type,count')
      .in('post_id', postIds)

    let rows = fromView
    if (viewErr || !rows) {
      // 2) ビューが無い/エラー時はテーブルを直接集計
      const { data, error } = await supabase
        .from('post_reactions')
        .select('post_id,r_type')
        .in('post_id', postIds)
      if (error) throw error
      const map: Record<string, Record<string, number>> = {}
      for (const r of data || []) {
        const pid = (r as any).post_id as string
        const t = (r as any).r_type as string
        map[pid] ??= {}
        map[pid][t] = (map[pid][t] ?? 0) + 1
      }
      const countsByPost: Record<string, {r_type:string;count:number}[]> = {}
      for (const pid of postIds) {
        countsByPost[pid] = Object.entries(map[pid] || {}).map(([rt, c]) => ({ r_type: rt, count: c as number }))
      }
      return NextResponse.json({ countsByPost })
    }

    const countsByPost: Record<string, {r_type:string;count:number}[]> = {}
    for (const r of rows) {
      const pid = (r as any).post_id as string
      countsByPost[pid] ??= []
      countsByPost[pid].push({ r_type: (r as any).r_type, count: (r as any).count })
    }
    return NextResponse.json({ countsByPost })
  } catch (e) {
    console.error('/api/reactions/counts error', e)
    // 失敗時は空で返す（UIを止めない）
    return NextResponse.json({ countsByPost:{} }, { status: 200 })
  }
}
