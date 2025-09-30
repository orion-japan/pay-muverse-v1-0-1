// src/app/api/qcode/self/post/route.ts
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'
export const fetchCache = 'default-no-store'

/**
 * 入力例:
 *  { user_code:"test_user", post_id:"post_abc123", content:"今日は気分が良かった！" }
 */
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}))

    const user_code = String(b.user_code || '').trim()
    const post_id = String(b.post_id || '').trim()
    const content = String(b.content || '').trim()

    if (!user_code || !post_id) {
      return NextResponse.json(
        { ok: false, error: 'user_code and post_id are required' },
        { status: 400 }
      )
    }

    // ---- Qコードを簡易生成（ここではランダム）----
    const qList = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']
    const q = qList[Math.floor(Math.random() * qList.length)]

    const q_code = {
      q,
      by: 'sofia',
      hint: 'self-post',
      meta: {
        source: 'self',
        kind: 'post',
        post_id,
      },
      version: 'qmap.v0.3.2',
      currentQ: q,         // ✅ 制約で必須
      depthStage: 'S1',    // ✅ 制約で必須
      confidence: 0.6,
      color_hex: '#EEE',
    }

    // ---- 保存用 row（最小限）----
    const row = {
      user_code,
      source_type: 'self',
      intent: 'self_post',
      q_code, // JSONB
    }

    console.debug('[DEBUG] row', JSON.stringify(row, null, 2))

    const { error } = await supabaseAdmin.from('q_code_logs').insert([row])
    if (error) {
      console.error('[DEBUG] supabase error', error)
      throw error
    }

    return NextResponse.json({ ok: true, post_id, q_code })
  } catch (e: any) {
    console.error('[DEBUG] catch error', e)
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'failed' },
      { status: 500 }
    )
  }
}
