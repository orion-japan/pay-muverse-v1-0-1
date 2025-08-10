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
      // body は不要
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

    // 直近の未来ミーティングを取得（「自分」）
    const r = await fetch(
      'https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=20',
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`zoom list error: ${r.status} ${t}`)
    }
    const j = await r.json()
    const meetings: any[] = j?.meetings ?? []

    // タイトルに「共鳴会」を含むものを優先、なければ先頭
    const cand = meetings.filter(m => (m.topic || '').includes('共鳴会'))
    const next = cand[0] || meetings[0]

    if (!next) {
      const resp = NextResponse.json(null)
      resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
      return resp
    }

    // Zoomのレスポンス項目例:
    // id:number, start_time:ISO, duration:number, password?:string, join_url:string
    const payload = {
      title: next.topic,
      start_at: new Date(next.start_time).toISOString(),
      duration_min: Number(next.duration ?? 60),
      reservation_url: '',

      // ← これをフロントが使います
      meeting_number: String(next.id ?? ''),           // 例: "81735650518"
      meeting_password: String(next.password ?? ''),   // ない場合は空

      // 将来Jitsiや別ページに切替える場合のために残しておく
      page_url: '', // 今回は使わない
    }

    const resp = NextResponse.json(payload)
    resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
    return resp
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 500 })
  }
}
