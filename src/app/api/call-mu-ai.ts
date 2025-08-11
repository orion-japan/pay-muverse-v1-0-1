// /pages/api/call-mu-ai.ts
import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('[CALL_MU_AI] API開始');

  if (req.method !== 'POST') {
    console.warn('[CALL_MU_AI] ❌ Method Not Allowed');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { token } = req.body as { token?: string };
  console.log('[CALL_MU_AI] ① 受信データ:', { hasToken: !!token });

  if (!token) {
    console.error('[CALL_MU_AI] ❌ Firebase ID token missing');
    return res.status(400).json({ error: 'Firebase ID token required' });
  }

  const muAiApiUrl = `${(process.env.MU_AI_BASE_URL_PROD || process.env.MU_AI_BASE_URL || 'https://mu-ui-v1-0-5.vercel.app').replace(/\/$/, '')}/api/get-user-info`;
  console.log('[CALL_MU_AI] ② MU送信先URL:', muAiApiUrl);

  try {
    console.log('[CALL_MU_AI] ③ MU側へ送信:', { tokenPreview: token.substring(0, 10) + '...' });

    const response = await fetch(muAiApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const data = await response.json();
    console.log('[CALL_MU_AI] ④ MU応答受信:', { status: response.status, data });

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[CALL_MU_AI] ❌ MU側通信エラー:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
