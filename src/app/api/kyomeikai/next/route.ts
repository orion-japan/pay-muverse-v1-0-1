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

    // ---- ここがポイント：最も近い未来を必ず選ぶ ----
    const now = Date.now()
    const toTs = (m: any) => new Date(m?.start_time ?? 0).getTime()
    const isFuture = (m: any) => toTs(m) > now
    const sortByStartAsc = (a: any, b: any) => toTs(a) - toTs(b)

    // 「共鳴会」を優先しつつ、未来の中で一番近いものを選択
    const kyomeiFuture = meetings.filter(m => (m.topic || '').includes('共鳴会')).filter(isFuture).sort(sortByStartAsc)
    const anyFuture = meetings.filter(isFuture).sort(sortByStartAsc)
    const next = kyomeiFuture[0] || anyFuture[0]

    if (!next) {
      const resp = NextResponse.json(null)
      resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
      return resp
    }

    // Zoomのレスポンス項目例:
    // id:number, start_time:ISO(UTC/Z), duration:number, password?:string, join_url:string
    const payload = {
      title: next.topic,
      // ← Z付きISOをそのまま返す（フロントでJST表示に変換される）
      start_at: next.start_time,
      duration_min: Number(next.duration ?? 60),
      reservation_url: '',

      // フロントが使う情報
      meeting_number: String(next.id ?? ''),         // 例: "81735650518"
      meeting_password: String(next.password ?? ''), // ない場合は空

      // 予備フィールド
      page_url: '',
    }

    const resp = NextResponse.json(payload)
    resp.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30')
    return resp
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 500 })
  }
}
