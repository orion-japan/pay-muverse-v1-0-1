// app/api/talk/unread-count/route.ts
import { NextResponse } from 'next/server'

// CORS/プリフライト（同一オリジンなら厳密には不要だが、405回避のため実装）
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Origin': '*', // 内部だけなら外してOK
    },
  })
}

// 最初は固定値でOK（UI確認用）。あとで DB 集計に差し替え。
export async function GET() {
  // 例：固定で5件
  const unread = 5

  return NextResponse.json(
    { unread },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  )
}

/* --- 参考：DB 集計に差し替えるときの雛形 ---
import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const authz = req.headers.get('authorization') || ''
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null
    const decoded = token ? await adminAuth.verifyIdToken(token).catch(() => null) : null
    if (!decoded) return NextResponse.json({ unread: 0 }, { status: 200 })

    const userCode = decoded.uid // ← 実装に合わせてユーザー識別子を取得

    const { count, error } = await supabase
      .from('messages')
      .select('*', { head: true, count: 'exact' })
      .eq('to_user_code', userCode)
      .is('read_at', null)

    if (error) return NextResponse.json({ unread: 0 }, { status: 200 })
    return NextResponse.json({ unread: count ?? 0 }, { status: 200 })
  } catch (e) {
    return NextResponse.json({ unread: 0 }, { status: 200 })
  }
}
--- */
