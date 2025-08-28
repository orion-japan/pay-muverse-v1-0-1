// src/app/iros/page.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'

const FOOTER_H = 60 as const

// =====================
// ログユーティリティ
// =====================
const TAG = '[iros]'
let runId = 0
const now = () => Math.round(performance.now())

function log(...args: any[]) {
  // eslint-disable-next-line no-console
  console.log(`${TAG}#${runId}`, ...args)
}
function group(title: string) {
  // eslint-disable-next-line no-console
  console.groupCollapsed(`${TAG}#${runId} ${title}`)
}
function groupEnd() {
  // eslint-disable-next-line no-console
  console.groupEnd()
}

// ★ /iros は SOFIA 固定
const TENANT: 'sofia' = 'sofia'

// （MU は未使用だが、念のため環境確認ログ用に残す）
const MU_UI_URL = (process.env.NEXT_PUBLIC_MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '')
const SOFIA_UI_URL = (process.env.NEXT_PUBLIC_SOFIA_UI_URL ?? 'https://s.muverse.jp').replace(/\/+$/, '')
const TARGET_UI_URL = SOFIA_UI_URL // ← /iros は常に SOFIA をターゲット

export default function IrosPage() {
  const { user, loading } = useAuth()
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const startedAtRef = useRef<number>(0)

  // 画面初期化ログ（1回だけ）
  useEffect(() => {
    runId += 1
    startedAtRef.current = now()
    group('Init')
    log('TENANT =', TENANT)
    log('ENV:', {
      NEXT_PUBLIC_MU_UI_URL: process.env.NEXT_PUBLIC_MU_UI_URL,
      NEXT_PUBLIC_SOFIA_UI_URL: process.env.NEXT_PUBLIC_SOFIA_UI_URL,
      resolved: { MU_UI_URL, SOFIA_UI_URL, TARGET_UI_URL },
    })
    groupEnd()
  }, [])

  // メモ：ユーザーの見える属性だけ（機微情報は出さない）
  const userBrief = useMemo(
    () => (user ? { uid: user.uid, email: user.email ?? null } : null),
    [user]
  )

  useEffect(() => {
    const start = async () => {
      group('Start iros flow')

      log('Auth state:', { loading, hasUser: !!user, user: userBrief })

      if (loading) {
        log('Auth still loading → wait')
        groupEnd()
        return
      }
      if (!user) {
        const msg = 'Firebase未ログインです'
        log('❌', msg)
        setError(msg)
        groupEnd()
        return
      }

      try {
        const t0 = now()
        log('🔐 getIdToken(true) …')
        const idToken = await user.getIdToken(true)
        log('🔐 got idToken length =', idToken?.length ?? 0, `(+${now() - t0}ms)`)
        if (!idToken) throw new Error('IDトークン取得失敗')

        // ===== /api/resolve-so 呼び出し =====
        const t1 = now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)

        const reqBody = { idToken }
        log('📡 fetch /api/resolve-so', { body: { idToken: `<len:${idToken.length}>` } })

        const res = await fetch('/api/resolve-so', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          cache: 'no-store',
          signal: controller.signal,
        })

        clearTimeout(timer)
        log('📨 /api/resolve-so status =', res.status, `(+${now() - t1}ms)`)

        const headersDump: Record<string, string> = {}
        res.headers.forEach((v, k) => (headersDump[k] = v))
        log('📨 response headers:', headersDump)

        const json: any = await res.clone().json().catch(() => ({}))

        group('resolve-so payload')
        log('ok =', json?.ok)
        log('tenant =', json?.tenant)
        log('user_code =', json?.user_code)
        log('login_url =', json?.login_url)
        log('raw json =', json)
        groupEnd()

        if (!res.ok || !json?.ok) {
          throw new Error(json?.error || `RESOLVE_FAILED (HTTP ${res.status})`)
        }

        const loginUrl: string | undefined = json?.login_url
        const userCode: string | undefined = json?.user_code

        // ① ベースURL（login_url 優先、なければフォールバック）
        let base = loginUrl
        if (!base) {
          if (!userCode) throw new Error('署名付きURLが取得できませんでした')
          base =
            `${TARGET_UI_URL}${TARGET_UI_URL.includes('?') ? '&' : '?'}` +
            `user=${encodeURIComponent(userCode)}`
        }
        log('🧭 base url (before force) =', base)

        // ② 必ず s.muverse.jp を向ける（返ってきたURLが MU でも強制上書き）
        let finalUrl = ''
        try {
          const u = new URL(base)
          const sofiaHost = new URL(SOFIA_UI_URL).host

          if (u.host !== sofiaHost) {
            log('⚠️ host force → SOFIA', { before: u.host, after: sofiaHost })
          }
          u.protocol = 'https:'
          u.host = sofiaHost

          // ③ iFrame用オプション（必須クエリを強制付与）
          u.searchParams.set('hideHeader', '1')
          u.searchParams.set('from', 'so') // ★ 追加：ここで from=so を確定

          finalUrl = u.toString()
          log('🎯 final iframe url =', finalUrl)
          log('🔎 final url parts:', {
            origin: u.origin,
            host: u.host,
            pathname: u.pathname,
            search: u.search,
          })
        } catch (e) {
          // 失敗時は “文字列置換” で最終バリア
          log('URL parse failed for base=', base, e)
          finalUrl = base
            .replace('https://m.muverse.jp', 'https://s.muverse.jp')
            .replace('http://m.muverse.jp', 'https://s.muverse.jp')

          if (!/https:\/\/s\.muverse\.jp/i.test(finalUrl)) {
            const qs = base.includes('?') ? base.slice(base.indexOf('?') + 1) : ''
            finalUrl = `https://s.muverse.jp${qs ? `?${qs}` : ''}`
          }
          const sep = finalUrl.includes('?') ? '&' : '?'
          finalUrl = `${finalUrl}${sep}hideHeader=1&from=so`

          log('🎯 final iframe url (fallback) =', finalUrl)
        }

        setUrl(finalUrl)
        log('✅ setUrl() done')
      } catch (e: any) {
        const msg = e?.message || '不明なエラー'
        log('❌ error:', msg, e)
        setError(msg)
      } finally {
        log('⏱ total +', now() - startedAtRef.current, 'ms')
        groupEnd()
      }
    }

    start()
  }, [user, loading, userBrief])

  // 画面描画
  if (error) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
          color: 'red',
          fontWeight: 'bold',
        }}
      >
        エラー: {error}
      </div>
    )
  }

  if (!url) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Sofia_AI を開始中…
      </div>
    )
  }

  return (
    <div>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: FOOTER_H, // フッター分だけ空ける
          width: '100vw',
          height: `calc(100vh - ${FOOTER_H}px)`,
          margin: 0,
          padding: 0,
          overflow: 'hidden',
          zIndex: 0,
        }}
      >
        <iframe
          src={url}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          allow="clipboard-write; microphone; camera"
          onLoad={() => log('📺 iframe loaded:', url)}
        />
      </div>
    </div>
  )
}
