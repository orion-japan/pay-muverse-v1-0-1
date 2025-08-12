import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'

export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(req: Request) {
  console.log('=== [CALL_MU_AI] API開始 ===')

  try {
    const body = await req.json().catch(() => null)
    const idToken = body?.token
    if (!idToken) {
      console.error('❌ idTokenがありません')
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // ① Firebaseトークン検証（UIDを特定）
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    console.log('✅ Firebaseトークン検証成功:', decoded.uid)

    // ② MU 側 API に代理リクエスト
    const muRes = await fetch('https://m.muverse.jp/api/get-user-info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        auth: {
          mode: 'firebase',
          idToken
        }
      })
    })

    if (!muRes.ok) {
      console.error(`❌ MU側APIエラー: ${muRes.status} ${muRes.statusText}`)
      return NextResponse.json(
        { error: 'MU API request failed', status: muRes.status },
        { status: muRes.status }
      )
    }

    const muData = await muRes.json()
    console.log('✅ MU側からのレスポンス:', muData)

    // ③ MU側から返却されたデータをそのまま返す
    return NextResponse.json(muData)
  } catch (err: any) {
    console.error('❌ 予期せぬエラー:', err)
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 })
  }
}
