// src/app/api/kyomeikai/next/route.ts
import { NextResponse } from 'next/server'

const ACC = process.env.ZOOM_ACCOUNT_ID!
const CID = process.env.ZOOM_CLIENT_ID!
const SEC = process.env.ZOOM_CLIENT_SECRET!

async function getAccessToken() {
  const r = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ACC}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CID}:${SEC}`).toString('base64'),
      },
    }
  )
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`zoom token error: ${r.status} ${t}`)
  }
  const j = await r.json()
  return j.access_token as string
}

export async function GET() {
  try {
    const token = await getAccessToken()

    // 直近の未来ミーティングを取得（アカウント所有者の「自分」）
    const r = await fetch(
      'https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=10',
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`zoom list error: ${r.status} ${t}`)
    }
    const j = await r.json()
    let meetings: any[] = j.meetings || []

    // タイトルに「共鳴会」を含むものを優先（無ければ先頭）
    const filtered = meetings.filter(m => (m.topic || '').includes('共鳴会'))
    const next = filtered[0] || meetings[0]

    // 未来の予定が無い場合は null
    if (!next) {
      const resp = NextResponse.json(null)
      resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
      return resp
    }

    // Jitsiで参加する前提の返却（page_url を /kyomeikai/jitsi に）
    const payload = {
      title: next.topic,
      start_at: new Date(next.start_time).toISOString(), // 表示側で整形
      duration_min: next.duration,
      reservation_url: '',
      page_url: '/kyomeikai/jitsi', // ← 参加時はこのページを開く（iframeでOK）
    }

    const resp = NextResponse.json(payload)
    resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
    return resp
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 500 })
  }
}
