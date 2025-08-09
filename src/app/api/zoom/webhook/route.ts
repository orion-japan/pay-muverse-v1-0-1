import { NextResponse } from 'next/server'
import crypto from 'crypto'

const SECRET = process.env.ZOOM_WEBHOOK_SECRET || ''

// 署名検証（x-zm-signature = v0:timestamp:hash）
function verifySignature(signature: string, timestamp: string, body: string) {
  const [version, ts, hash] = signature.split(':')
  if (version !== 'v0' || !ts || !hash) return false
  // 再計算
  const msg = `v0:${timestamp}:${body}`
  const h = crypto.createHmac('sha256', SECRET).update(msg).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  const sig = req.headers.get('x-zm-signature') || ''
  const ts  = req.headers.get('x-zm-request-timestamp') || ''

  // URLバリデーション（最初の疎通チェック）
  try {
    const j = JSON.parse(rawBody)
    if (j?.event === 'endpoint.url_validation') {
      const { plainToken } = j.payload
      const encryptedToken = crypto.createHmac('sha256', SECRET).update(plainToken).digest('hex')
      return NextResponse.json({ plainToken, encryptedToken })
    }
  } catch {}

  // 署名検証（本番運用で必須）
  if (!SECRET || !verifySignature(sig, ts, rawBody)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  // ここでイベント種別ごとに処理
  const evt = JSON.parse(rawBody)
  const type = evt?.event as string

  // TODO: ログ保存や通知、キャッシュ更新など
  console.log('[zoom webhook]', type)

  return NextResponse.json({ ok: true })
}
