// src/app/api/thread/comment/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

type Body = { threadId?: string; userCode?: string; content?: string }

// 実行環境から自分自身の絶対URLを作る（HOME_URL > NEXT_PUBLIC_SITE_URL > リクエストOrigin）
function getBaseUrl(req: NextRequest) {
  const envBase =
    process.env.HOME_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    ''
  if (envBase) return envBase.replace(/\/+$/, '')
  return req.nextUrl.origin.replace(/\/+$/, '')
}

// 内部ユーティリティ：/api/push/send をベストエフォートで呼ぶ
async function sendPush(baseUrl: string, params: {
  to: string
  title: string
  body: string
  url: string
  kind?: 'rtalk' | 'generic'
  tag?: string
  renotify?: boolean
}) {
  try {
    // baseUrl とパスの結合を安全に
    const endpoint = new URL('/api/push/send', baseUrl).toString()
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_code: params.to,
        kind: params.kind ?? 'rtalk',
        title: params.title,
        body: params.body,
        url: params.url,          // ここは相対でOK（SW 側で location.origin を付与して遷移）
        tag: params.tag,          // 同一スレ上書き用
        renotify: params.renotify // 上書き時にも鳴らす
      }),
      cache: 'no-store',
    })
  } catch {
    // ベストエフォート：失敗してもAPIは成功を優先
  }
}

export async function POST(req: NextRequest) {
  try {
    const { threadId, userCode, content } = (await req.json()) as Body
    if (!threadId || !userCode || !content?.trim()) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! // SRK未設定でも一応動く（権限は要注意）

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // コメント挿入
    const { data: inserted, error } = await admin
      .from('posts')
      .insert({
        thread_id: String(threadId),
        user_code: String(userCode),
        content: content.trim(),
        is_posted: false,
      })
      .select('post_id,user_code,content,created_at,thread_id,is_posted')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 参加者へアプリ内通知 + Push（どちらもベストエフォート）
    try {
      // スレッド参加者（親＋既存子）の user_code 一覧を取得
      const { data: rows } = await admin
        .from('posts')
        .select('user_code')
        .eq('thread_id', String(threadId))

      const recipients = new Set<string>()
      rows?.forEach((r: any) => {
        if (r.user_code && r.user_code !== userCode) recipients.add(r.user_code)
      })

      // アプリ内通知（任意）
      if (recipients.size > 0) {
        const notifRows = [...recipients].map((to) => ({
          recipient_user_code: to,
          from_user_code: userCode,
          title: '新しいコメント',
          body: content.slice(0, 80),
          url: `/thread/${threadId}`,
        }))
        if (notifRows.length) await admin.from('notifications').insert(notifRows)
      }

      // Push 通知（受信者ごと）
      if (recipients.size > 0) {
        const baseUrl = getBaseUrl(req)
        const preview = content.slice(0, 80)
        const tag = `reply-${threadId}`

        await Promise.allSettled(
          [...recipients].map((to) =>
            sendPush(baseUrl, {
              to,
              title: 'あなたのSelfTalkに返信がありました',
              body: preview,
              url: `/thread/${threadId}?focus=${inserted.post_id}`,
              kind: 'rtalk',
              tag,
              renotify: true,
            })
          )
        )
      }
    } catch {
      // ベストエフォートなので握りつぶす
    }

    return NextResponse.json(inserted, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'internal error' }, { status: 500 })
  }
}
