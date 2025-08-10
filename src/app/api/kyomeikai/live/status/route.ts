import { NextResponse } from 'next/server'

type LiveState = {
  is_live: boolean
  room?: string
  started_at?: string
  ends_at?: string
}
const KEY = 'MUVERSE_LIVE_STATE'

// グローバルに簡易保存（Vercel等だとインスタンス跨ぎで揮発。まずは開発用）
function getState(): LiveState {
  const g = globalThis as any
  return g[KEY] ?? { is_live: false }
}
function setState(s: LiveState) {
  const g = globalThis as any
  g[KEY] = s
}

export async function GET() {
  // 期限が切れていたら自動でOFF
  const s = getState()
  if (s.is_live && s.ends_at && Date.now() > Date.parse(s.ends_at)) {
    setState({ is_live: false })
    return NextResponse.json({ is_live: false })
  }
  return NextResponse.json(s)
}
