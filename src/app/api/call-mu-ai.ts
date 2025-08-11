// /pages/api/call-mu-ai.ts

import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { userCode, ts, sig } = req.body

    // 必須チェック（どちらか一方があればOK）
    if (!userCode && !(ts && sig)) {
      return res.status(400).json({ error: 'Either userCode or ts+sig is required' })
    }

    // mu_ai 側 API URL（環境変数から取得）
    const muAiApiUrl = `${process.env.MU_AI_BASE_URL}/api/get-user-info`

    // リクエストボディ作成
    const requestBody: Record<string, any> = {}
    if (userCode) requestBody.userCode = userCode
    if (ts && sig) {
      requestBody.ts = ts
      requestBody.sig = sig
    }

    // mu_ai 側へ送信
    const response = await fetch(muAiApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shared-secret': process.env.SHARED_API_SECRET || ''
      },
      body: JSON.stringify(requestBody)
    })

    // エラーレスポンス処理
    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: text })
    }

    // 成功レスポンス
    const data = await response.json()
    return res.status(200).json(data)

  } catch (error: any) {
    console.error('Error calling mu_ai API:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}
