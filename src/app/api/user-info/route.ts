// pay/src/app/api/user-info/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminAuth } from '@/lib/firebase-admin'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function withCORS(json: any, status = 200) {
  return NextResponse.json(json, {
    status,
    headers: {
      'Access-Control-Allow-Origin': process.env.MU_ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

export async function OPTIONS() {
  return withCORS({}, 200)
}

export async function POST(req: Request) {
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const log = (...a: any[]) => console.log('[user-info]', `[${traceId}]`, ...a)
  const logErr = (...a: any[]) => console.error('[user-info][ERR]', `[${traceId}]`, ...a)

  try {
    const body = await req.json().catch(() => ({} as any))
    const rawUserCode = body?.user_code
    const idToken = body?.idToken
    log('POST start', { hasUserCode: !!rawUserCode, hasIdToken: !!idToken })

    let user_code: string | null = typeof rawUserCode === 'string' && rawUserCode ? rawUserCode : null

    if (!user_code && typeof idToken === 'string' && idToken) {
      try {
        log('verifyIdToken...', { tokenLen: idToken.length })
        const decoded = await adminAuth.verifyIdToken(idToken, true)
        const firebase_uid = decoded.uid
        log('idToken OK', { uid: firebase_uid })

        const { data: urow, error: uerr } = await supabase
          .from('users')
          .select('user_code')
          .eq('firebase_uid', firebase_uid)
          .maybeSingle()

        if (uerr) { logErr('users lookup error', uerr); return withCORS({ traceId, error: uerr.message }, 500) }
        if (!urow?.user_code) { log('USER_NOT_FOUND by uid'); return withCORS({ traceId, error: 'USER_NOT_FOUND' }, 404) }

        user_code = urow.user_code
        log('resolved user_code', { user_code })
      } catch (e: any) {
        logErr('verifyIdToken failed', e?.message || e)
        return withCORS({ traceId, error: 'INVALID_TOKEN' }, 401)
      }
    }

    if (!user_code) {
      logErr('missing user_code and idToken')
      return withCORS({ traceId, error: 'user_code or idToken required' }, 400)
    }

    // ★ ここを列指定→「*」に変更（存在しない列で落ちないようにする）
    log('fetch users row...', { user_code })
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('user_code', user_code)
      .maybeSingle()

    if (error) { logErr('users select error', error); return withCORS({ traceId, error: error.message }, 500) }
    if (!data) { log('USER_NOT_FOUND by user_code'); return withCORS({ traceId, error: 'USER_NOT_FOUND' }, 404) }

    // ▼ 正規化（存在しない列は undefined になるので安全）
    const toLower = (v: any) => String(v ?? '').toLowerCase()
    const truthy = (v: any) => v === true || v === 1 || v === '1' || v === 'true'

    const role        = toLower(data.role ?? data.user_role)
    const click_type  = toLower(data.click_type ?? data.clickType)
    const plan_status = toLower(data.plan_status ?? data.plan ?? data.planStatus)

    const is_admin  = truthy(data.is_admin)  || role === 'admin'  || click_type === 'admin'  || plan_status === 'admin'
    const is_master = truthy(data.is_master) || role === 'master' || click_type === 'master' || plan_status === 'master'

    const sofia_credit =
      typeof data.sofia_credit === 'number' ? data.sofia_credit : Number(data.sofia_credit ?? 0)

    log('resolved meta', { role, click_type, plan_status, is_admin, is_master, sofia_credit })

    return withCORS({
      traceId,
      ok: true,
      user_code,
      click_username: data.click_username ?? null,
      click_type,
      role,
      plan_status,
      is_admin,
      is_master,
      sofia_credit,
    }, 200)
  } catch (e: any) {
    logErr('unhandled error', e?.message || e)
    return withCORS({ traceId, error: e?.message ?? 'unknown' }, 500)
  }
}
