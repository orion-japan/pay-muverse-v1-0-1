// file: src/lib/iros/server/handleIrosReply.supabase.ts
// iros - Supabase admin client (server-only)

import { createClient } from '@supabase/supabase-js';

export function getIrosSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      '[IROS] Missing Supabase env. NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required for server handlers.',
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },

    // ✅ Supabase(Cloudflare) 520/HTML 返却で route が 110s ハングするのを止血
    // - AbortControllerでタイムアウト（20s）
    // - text/html を検出したら先頭だけログ用に取り、即例外
    global: {
      fetch: async (input: any, init?: any) => {
        const controller = new AbortController();
        const timeoutMs = 20_000;

        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await fetch(input, {
            ...(init ?? {}),
            signal: controller.signal,
          });

          const status = res.status;
          const ct = String(res.headers.get('content-type') ?? '').toLowerCase();

          const looksLikeHtml = ct.includes('text/html') || ct.includes('application/xhtml+xml');
          const isUpstreamBad = status >= 520;

          if (!res.ok && (looksLikeHtml || isUpstreamBad)) {
            let head = '';
            try {
              const txt = await res.text();
              head = txt.slice(0, 400); // ✅ dev.log 汚染防止（先頭だけ）
            } catch {}

            const cfRay =
              res.headers.get('cf-ray') ||
              res.headers.get('x-amz-cf-id') ||
              res.headers.get('x-request-id') ||
              '';

            throw new Error(
              `[SUPABASE_UPSTREAM_BAD] status=${status} ct=${ct || '(none)'} cfRay=${cfRay || '(none)'} head=${head || '(empty)'}`
            );
          }

          return res;
        } catch (e: any) {
          if (e?.name === 'AbortError') {
            throw new Error(`[SUPABASE_FETCH_TIMEOUT] ${timeoutMs}ms`);
          }
          throw e;
        } finally {
          clearTimeout(t);
        }
      },
    },
  });
}

// 念のため：このファイルを確実に “module” 扱いにする
export {};
