import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // サーバー専用キー
)

// Mu AI 呼び出し（あなたの実装に合わせて調整）
async function callMuAI(prompt: string): Promise<string> {
  const r = await fetch(process.env.MU_AI_ENDPOINT!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MU_AI_KEY}`
    },
    body: JSON.stringify({ model: 'mu-ai-v1', prompt })
  })
  if (!r.ok) throw new Error(`Mu AI error: ${r.status}`)
  const j = await r.json()
  return j.text ?? j.output ?? ''
}

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const user = searchParams.get('user')
    if (!user) return NextResponse.json({ error: 'missing user' }, { status: 400 })

    // 1) 特徴量取得（v_user_q_features を前提）
    const { data: feat, error: featErr } = await supa
      .from('v_user_q_features')
      .select('*')
      .eq('user_code', user)
      .single()

    if (featErr || !feat) {
      return NextResponse.json({ error: featErr?.message ?? 'no features' }, { status: 404 })
    }

    // 2) signals と reason を算出
    const signals = {
      delta_q1: Number(feat.pct7_q1) - Number(feat.pct30_q1),
      delta_q2: Number(feat.pct7_q2) - Number(feat.pct30_q2),
      delta_q3: Number(feat.pct7_q3) - Number(feat.pct30_q3),
      delta_q4: Number(feat.pct7_q4) - Number(feat.pct30_q4),
      delta_q5: Number(feat.pct7_q5) - Number(feat.pct30_q5),
      activity_7d: Number(feat.total7 ?? 0)
    }
    const maxDelta = Math.max(
      Math.abs(signals.delta_q1),
      Math.abs(signals.delta_q2),
      Math.abs(signals.delta_q3),
      Math.abs(signals.delta_q4),
      Math.abs(signals.delta_q5),
    )
    const reason =
      (maxDelta >= 5 && signals.activity_7d >= 5) ? 'shift'
      : (signals.activity_7d < 5) ? 'low_activity'
      : 'info'

    // 3) Mu AI へ投げる
    const payload = {
      user_code: user,
      latest_rep_q: feat.last_rep_q,
      pct7:  { Q1: feat.pct7_q1,  Q2: feat.pct7_q2,  Q3: feat.pct7_q3,  Q4: feat.pct7_q4,  Q5: feat.pct7_q5 },
      pct30: { Q1: feat.pct30_q1, Q2: feat.pct30_q2, Q3: feat.pct30_q3, Q4: feat.pct30_q4, Q5: feat.pct30_q5 },
      signals, reason
    }

    const system = `あなたはユーザーの日次Qコードから200字以内で具体的アドバイスを返すコーチです。
- 断定や否定は避け、箇条書き最大2点。
- 「今日こうすると良い」の行動レベルまで落とす。
- データの根拠を一言添える（例：直近7日でQ2+6pt）。`
    const advice = await callMuAI(`${system}\n\n${JSON.stringify(payload)}`)

    // 4) 1日1件でUPSERT（reasonも保存）
    const jst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    const advice_date = jst.split(' ')[0]?.replaceAll('/','-') // YYYY-MM-DD

    const { error: upsertErr } = await supa
      .from('ai_coach_advice')
      .upsert({
        user_code: user,
        advice_date,
        payload_json: payload as any,
        advice_text: advice,
        model: 'mu-ai-v1',
        reason
      }, { onConflict: 'user_code,advice_date' })

    if (upsertErr) {
      return NextResponse.json({ error: upsertErr.message }, { status: 500 })
    }

    return NextResponse.json({ user, advice_date, reason, advice })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'internal error' }, { status: 500 })
  }
}
