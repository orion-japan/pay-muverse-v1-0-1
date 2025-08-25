import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import dayjs from 'dayjs'

function znum(n: any) { n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0 }

// ---- GET: 単日 or 履歴(days指定) ----
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const user_code = searchParams.get('user_code') || ''
    const vision_id = searchParams.get('vision_id') || ''
    const date = searchParams.get('date') || dayjs().format('YYYY-MM-DD')

    // 履歴モード（days=指定 or history=1）
    const historyFlag = searchParams.get('history')
    const daysParam = searchParams.get('days')
    const days = daysParam ? Math.max(1, Math.min(60, Number(daysParam))) : null

    if (!user_code || !vision_id) {
      return NextResponse.json({ error: 'missing params' }, { status: 400 })
    }

    if (historyFlag === '1' || days) {
      const span = days ?? 14
      const to = dayjs().format('YYYY-MM-DD')
      const from = dayjs().subtract(span - 1, 'day').format('YYYY-MM-DD')

      const { data, error } = await supabase
        .from('daily_checks')
        .select('check_date, progress, vision_imaged, resonance_shared')
        .eq('user_code', user_code)
        .eq('vision_id', vision_id)
        .gte('check_date', from)
        .lte('check_date', to)
        .order('check_date', { ascending: true })

      if (error) throw error
      return NextResponse.json({ data })
    }

    // 単日モード
    const { data, error } = await supabase
      .from('daily_checks')
      .select('*')
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .eq('check_date', date)
      .maybeSingle()

    if (error) throw error
    return NextResponse.json({ data: data ?? null })
  } catch (e: any) {
    console.error('❌ GET /api/daily-checks error:', e)
    return NextResponse.json({ error: e.message ?? 'server error' }, { status: 500 })
  }
}

// ---- POST: upsert 単日 ----
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      user_code, vision_id,
      date, vision_imaged, resonance_shared,
      status_text, diary_text, q_code,
      progress
    } = body

    if (!user_code || !vision_id) {
      return NextResponse.json({ error: 'missing params' }, { status: 400 })
    }

    const check_date = date ?? dayjs().format('YYYY-MM-DD')

    const { data, error } = await supabase
      .from('daily_checks')
      .upsert({
        user_code,
        vision_id,
        check_date,
        vision_imaged: !!vision_imaged,
        resonance_shared: !!resonance_shared,
        status_text: status_text ?? null,
        diary_text: diary_text ?? null,
        q_code: q_code ?? null,
        progress: znum(progress),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_code,vision_id,check_date' })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (e: any) {
    console.error('❌ POST /api/daily-checks error:', e)
    return NextResponse.json({ error: e.message ?? 'server error' }, { status: 500 })
  }
}
