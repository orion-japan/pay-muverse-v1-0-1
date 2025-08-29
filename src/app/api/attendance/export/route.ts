import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function toCSV(rows: Array<any>) {
  if (!rows.length) return 'date,event_id,title\n'
  const cols = ['date','event_id','title']
  const lines = [cols.join(',')]
  for (const r of rows) {
    lines.push([
      r.date ?? '',
      r.event_id ?? '',
      (r.title ?? '').replace(/"/g, '""')
    ].map(v => `"${String(v)}"`).join(','))
  }
  return lines.join('\n')
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    const user_code = searchParams.get('user_code') || ''

    if (!from || !to || !user_code) {
      return new NextResponse('from,to,user_code required', { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .select('date,event_id,title')
      .gte('date', from)
      .lte('date', to)
      .eq('user_code', user_code)
      .order('date', { ascending: true })

    if (error) throw error

    const csv = toCSV(data ?? [])
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance_${from}_${to}.csv"`,
      },
    })
  } catch (e: any) {
    return new NextResponse(e?.message ?? 'export failed', { status: 500 })
  }
}
