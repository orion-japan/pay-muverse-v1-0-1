// app/api/resolve-user/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseAdmin } from '@/lib/supabaseAdmin' // RLS回避のService Role
import { makeSignedParams } from '@/lib/signed'
import { randomUUID } from 'crypto'

/** =========================
 *  MU 専用設定
 *  - MU_UI_URL / MU_SHARED_ACCESS_SECRET を使用
 *  - SOFIA 系は参照しない
 * ========================= */
const MU_UI_URL = (process.env.MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '')
const MU_SHARED_ACCESS_SECRET = process.env.MU_SHARED_ACCESS_SECRET || ''

/** user_code 生成（必要なら独自規則に変更可） */
function genUserCode() {
  return 'uc-' + randomUUID().slice(0, 8)
}

/** idToken を Authorization / body / query の順で抽出（旧互換） */
async function extractIdToken(req: NextRequest): Promise<string | null> {
  const authz = req.headers.get('authorization') || req.headers.get('Authorization')
  if (authz?.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim()

  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}))
      const t = body?.idToken || body?.auth?.idToken
      if (t && typeof t === 'string') return t
    } catch {}
  }
  const q = new URL(req.url).searchParams.get('idToken')
  return q
}

async function handle(req: NextRequest) {
  const rid = Math.random().toString(36).slice(2, 8)
  console.log(`[resolve-user#${rid}] Init MU_UI_URL=`, MU_UI_URL)

  try {
    if (!MU_SHARED_ACCESS_SECRET) {
      console.error(`[resolve-user#${rid}] missing MU_SHARED_ACCESS_SECRET`)
      return NextResponse.json({ ok: false, error: 'SERVER_MISCONFIG' }, { status: 500 })
    }

    const idToken = await extractIdToken(req)
    if (!idToken) {
      console.warn(`[resolve-user#${rid}] no idToken`)
      return NextResponse.json({ ok: false, error: 'INVALID_TOKEN' }, { status: 400 })
    }

    // Firebase 検証 → uid
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    const firebase_uid = decoded.uid
    console.log(`[resolve-user#${rid}] uid=`, firebase_uid)

    // 1) 既存取得（必要列）
    let { data, error } = await supabaseAdmin
      .from('users')
      .select('user_code, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    // 2) 無ければ作成（unique衝突時は再取得）
    if (error || !data?.user_code) {
      console.warn(`[resolve-user#${rid}] provision user`)
      const user_code = genUserCode()
      const ins = await supabaseAdmin
        .from('users')
        .insert({
          firebase_uid,
          user_code,
          click_type: 'user',
          sofia_credit: 0,
        })
        .select('user_code, click_type, sofia_credit')
        .maybeSingle()

      if (ins.error) {
        if ((ins.error as any).code === '23505') {
          console.warn(`[resolve-user#${rid}] conflict → reselect`)
          const again = await supabaseAdmin
            .from('users')
            .select('user_code, click_type, sofia_credit')
            .eq('firebase_uid', firebase_uid)
            .maybeSingle()
          if (again.error || !again.data?.user_code) {
            console.error(`[resolve-user#${rid}] select after conflict failed`, again.error)
            return NextResponse.json(
              { ok: false, error: 'USER_PROVISION_FAILED', detail: String(again.error?.message ?? 'select failed') },
              { status: 500 }
            )
          }
          data = again.data
        } else {
          console.error(`[resolve-user#${rid}] insert failed`, ins.error)
          return NextResponse.json(
            { ok: false, error: 'USER_PROVISION_FAILED', detail: String(ins.error?.message ?? ins.error) },
            { status: 500 }
          )
        }
      } else {
        data = ins.data
      }
    }

    // 3) MU 向け署名付き login_url を生成（from=pay 固定）
    const user_code = data!.user_code
    const { ts, sig } = makeSignedParams(user_code, MU_SHARED_ACCESS_SECRET)

    const u = new URL(MU_UI_URL)
    u.searchParams.set('user', user_code)
    u.searchParams.set('ts', String(ts))
    u.searchParams.set('sig', sig)
    u.searchParams.set('from', 'pay')     // MU 側からの起点を明示
    u.searchParams.set('tenant', 'mu')    // 必要ならUIで利用

    const login_url = u.toString()

    // 役割フラグ
    const click = String(data!.click_type ?? '').toLowerCase()
    const is_admin = click === 'admin'
    const is_master = click === 'master'

    console.log(`[resolve-user#${rid}] OK ->`, login_url)

    return NextResponse.json({
      ok: true,
      user_code,
      click_type: click,
      sofia_credit: Number(data!.sofia_credit ?? 0),
      is_admin,
      is_master,
      login_url,            // ← MU へのログインURL
    })
  } catch (e: any) {
    console.error(`[resolve-user#${rid}] fatal:`, e)
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }
