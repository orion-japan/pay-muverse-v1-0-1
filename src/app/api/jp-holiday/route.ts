import { NextResponse } from 'next/server'
import { GET as getMonth } from '../jp-holidays/route' // 月一覧を再利用

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date') || ''
    if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })

    const y = Number(date.slice(0,4))
    const m = Number(date.slice(5,7))
    const r = await getMonth(new Request(`${req.url.split('?')[0].replace('/jp-holiday','/jp-holidays')}?year=${y}&month=${m}`)) as any
    const data = await r.json()
    const hit = (data?.items ?? []).find((h: any) => h.date === date)
    return NextResponse.json(hit ? { holiday: true, name: hit.name } : { holiday: false })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'holiday failed' }, { status: 500 })
  }
}
