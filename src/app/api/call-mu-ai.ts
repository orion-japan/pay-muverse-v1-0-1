// src/app/api/call-mu-ai.ts
import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('=== [CALL_MU_AI] API開始 ===')

  // メソッド制限
  if (req.method !== 'POST') {
    console.warn('[CALL_MU_AI] ❌ Method Not Allowed')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  // クライアントからのデータ
  const { token } = req.body as { token?: string }
  console.log('[CALL_MU_AI] ① 受信データ:', {
    hasToken: !!token,
    tokenPreview: token ? token.substring(0, 10) + '...' : '(なし)',
  })

  if (!token) {
    console.error('[CALL_MU_AI] ❌ Firebase ID token missing')
    return res.status(400).json({ error: 'Firebase ID token required' })
  }

  // MU 側APIエンドポイント
  const muAiApiUrl = `${(process.env.MU_AI_BASE_URL_PROD || process.env.MU_AI_BASE_URL || 'https://m.muverse.jp')
    .replace(/\/$/, '')}/api/get-user-info`
  console.log('[CALL_MU_AI] ② MU送信先URL:', muAiApiUrl)

  // 送信ペイロード（Firebaseモード）
  const payload = {
    version: '2025-08-11',
    request_id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    auth: {
      mode: 'firebase',
      idToken: token,
    },
  }

  console.log('[CALL_MU_AI] ③ MU側送信ペイロード(一部マスク):', {
    ...payload,
    auth: { ...payload.auth, idToken: token.substring(0, 10) + '...' },
  })

  try {
    // MU側へ送信
    const response = await fetch(muAiApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    // レスポンスの読み取り
    const textBody = await response.text()
    let parsed: any = {}
    try {
      parsed = JSON.parse(textBody)
    } catch {
      parsed = { raw: textBody }
    }

    console.log('[CALL_MU_AI] ④ MU応答受信:', {
      status: response.status,
      data: parsed,
    })

    return res.status(response.status).json(parsed)
  } catch (error: any) {
    console.error('[CALL_MU_AI] ❌ MU側通信エラー:', {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    })
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}
