// app/api/resolve-user/route.ts
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
// RLSを確実に越えるため Service Role を使用
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { makeSignedParams } from '@/lib/signed'
import { randomUUID } from 'crypto'

const MU_UI_URL = (process.env.MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '')
const SHARED_SECRET = process.env.MU_SHARED_ACCESS_SECRET || ''

/** 最低限の user_code 生成（必要なら独自規則に差し替え） */
function genUserCode() {
  return 'uc-' + randomUUID().slice(0, 8)
}

/** idToken を Authorization / body / query の順で抽出（旧仕様互換） */
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
  try {
    const idToken = await extractIdToken(req)
    if (!idToken) {
      return NextResponse.json({ ok: false, error: 'INVALID_TOKEN' }, { status: 400 })
    }

    // Firebase 検証 → uid
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    const firebase_uid = decoded.uid

    // 1) 既存取得（必須3列のみ）
    let { data, error } = await supabaseAdmin
      .from('users')
      .select('user_code, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    // 2) 無ければ作成（insert → unique衝突時は再取得）
    if (error || !data?.user_code) {
      const user_code = genUserCode()
      const ins = await supabaseAdmin
        .from('users')
        .insert({
          firebase_uid,
          user_code,
          click_type: 'user',   // デフォルト
          sofia_credit: 0       // デフォルト
        })
        .select('user_code, click_type, sofia_credit')
        .maybeSingle()

      if (ins.error) {
        // Postgres unique violation (23505) 等 → 再取得で継続
        if ((ins.error as any).code === '23505') {
          const again = await supabaseAdmin
            .from('users')
            .select('user_code, click_type, sofia_credit')
            .eq('firebase_uid', firebase_uid)
            .maybeSingle()
          if (again.error || !again.data?.user_code) {
            console.error('[resolve-user] select after 23505 failed:', again.error)
            return NextResponse.json(
              { ok: false, error: 'USER_PROVISION_FAILED', detail: String(again.error?.message ?? 'select failed') },
              { status: 500 }
            )
          }
          data = again.data
        } else {
          console.error('[resolve-user] insert error:', ins.error)
          return NextResponse.json(
            { ok: false, error: 'USER_PROVISION_FAILED', detail: String(ins.error?.message ?? ins.error) },
            { status: 500 }
          )
        }
      } else {
        data = ins.data
      }
    }

    // 署名付き login_url（従来互換）
    const { ts, sig } = makeSignedParams(data!.user_code, SHARED_SECRET)
    const query = `user=${encodeURIComponent(data!.user_code)}&ts=${ts}&sig=${sig}&from=pay`
    const login_url = `${MU_UI_URL}?${query}`

    // クリックタイプで簡易権限（必要ならUI側で使用）
    const click = String(data!.click_type ?? '').toLowerCase()
    const is_admin = click === 'admin'
    const is_master = click === 'master'

    return NextResponse.json({
      ok: true,
      user_code: data!.user_code,
      click_type: click,
      sofia_credit: Number(data!.sofia_credit ?? 0),
      is_admin,
      is_master,
      login_url,
    })
  } catch (e: any) {
    console.error('[resolve-user] fatal:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }
