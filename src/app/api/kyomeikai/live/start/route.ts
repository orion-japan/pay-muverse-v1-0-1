import { NextResponse } from 'next/server'

const KEY = 'MUVERSE_LIVE_STATE'
const ADMIN_TOKEN = process.env.LIVE_ADMIN_TOKEN // 簡易認証

function setState(s: any) {
  (globalThis as any)[KEY] = s
}

export async function POST(req: Request) {
  if (ADMIN_TOKEN && req.headers.get('x-live-admin-token') !== ADMIN_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const durationMin = Number(body.duration_min ?? 180) // デフォ3時間
  const room = String(body.room ?? `kyomeikai-live-${new Date().toISOString().slice(0,10)}`)

  const started_at = new Date()
  const ends_at = new Date(started_at.getTime() + durationMin * 60 * 1000)

  setState({
    is_live: true,
    room,
    started_at: started_at.toISOString(),
    ends_at: ends_at.toISOString(),
  })
  return NextResponse.json({ ok: true })
}
