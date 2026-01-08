// src/lib/iros/server/persistAssistantMessageToIrosMessages.ts
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Postgres jsonb が嫌う「壊れたUnicode（サロゲート片割れ）」を除去しつつ
 * meta を “確実にJSONとして成立” させる。
 *
 * - 文字列内の「単独ハイサロゲート」「単独ローサロゲート」を落とす
 * - JSON.stringify が落ちる／循環参照などは {} にフォールバック
 */
function sanitizeForJsonb(input: any): any {
  const stripBrokenSurrogates = (s: string) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);

      // high surrogate: 0xD800..0xDBFF
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;

        // valid pair with low surrogate: 0xDC00..0xDFFF
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += s[i] + s[i + 1];
          i++; // consume low surrogate too
        } else {
          // broken high surrogate -> drop
        }
        continue;
      }

      // low surrogate without preceding high surrogate -> drop
      if (c >= 0xdc00 && c <= 0xdfff) {
        continue;
      }

      out += s[i];
    }
    return out;
  };

  const seen = new WeakSet<object>();

  const walk = (v: any): any => {
    if (v == null) return v;

    const t = typeof v;

    if (t === 'string') return stripBrokenSurrogates(v);
    if (t === 'number' || t === 'boolean') return v;

    // bigint は JSON不可 -> 文字列化
    if (t === 'bigint') return String(v);

    if (t !== 'object') return v;

    // Date
    if (v instanceof Date) return v.toISOString();

    // Buffer / Uint8Array など
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('base64');
    if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');

    // 循環参照ガード
    if (seen.has(v)) return '[Circular]';
    seen.add(v);

    if (Array.isArray(v)) return v.map(walk);

    const o: any = {};
    for (const k of Object.keys(v)) {
      const val = (v as any)[k];
      // undefined は jsonb に不要
      if (val === undefined) continue;
      o[k] = walk(val);
    }
    return o;
  };

  try {
    // walk → stringify/parse で JSONとして確定させる
    const cleaned = walk(input);
    return JSON.parse(JSON.stringify(cleaned));
  } catch {
    return {};
  }
}

export async function persistAssistantMessageToIrosMessages(args: {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  content: string;
  meta: any; // ★ route.ts が組んだ meta を必須にする（single-writer保証鍵）
}) {
  const supabase = args.supabase;
  const conversationId = String(args.conversationId ?? '').trim();
  const userCode = String(args.userCode ?? '').trim();
  const content = String(args.content ?? '').trimEnd();
  const meta = args.meta ?? null;

  // =========================
  // ✅ single-writer guard
  // - route.ts からの呼び出しのみ許可
  // =========================
  const persistedByRoute =
    meta?.extra?.persistedByRoute === true &&
    meta?.extra?.persistAssistantMessage === false;

  if (!persistedByRoute) {
    console.error(
      '[IROS/persistAssistantMessageToIrosMessages] BLOCKED (not route writer)',
      {
        conversationId,
        userCode,
        hasMeta: Boolean(meta),
        metaExtraKeys: meta?.extra ? Object.keys(meta.extra) : [],
      },
    );

    return {
      ok: false,
      inserted: false,
      blocked: true,
      reason: 'SINGLE_WRITER_GUARD_BLOCKED',
    };
  }

  if (!conversationId || !userCode) {
    return { ok: false, inserted: false, blocked: false, reason: 'BAD_ARGS' };
  }

  // 空本文は保存しない（SILENCE等）
  if (!content || content.trim().length === 0) {
    return { ok: true, inserted: false, blocked: false, reason: 'EMPTY_CONTENT' };
  }

  // =========================
  // ✅ jsonb(meta) の止血
  // =========================
  const safeMeta = sanitizeForJsonb(meta ?? {});

  // ✅ q_code / depth_stage を “列として” 確定（view/API が列を見るため）
  const qCodeFinal =
    (typeof meta?.q_code === 'string' && meta.q_code) ||
    (typeof meta?.qCode === 'string' && meta.qCode) ||
    (typeof meta?.unified?.q?.current === 'string' && meta.unified.q.current) ||
    null;

  const depthStageFinal =
    (typeof meta?.depth_stage === 'string' && meta.depth_stage) ||
    (typeof meta?.depth === 'string' && meta.depth) ||
    (typeof meta?.depthStage === 'string' && meta.depthStage) ||
    (typeof meta?.unified?.depth?.stage === 'string' && meta.unified.depth.stage) ||
    null;

  // =========================
  // ✅ Phase3: 保存直前で meta の表記ゆれを完全同期（single source）
  // - “meta を再代入” しない。row.meta を更新するだけ。
  // - 最後に sanitize をもう一度通して jsonb 安全を確定させる。
  // =========================
  let finalMeta: any = safeMeta;
  try {
    const m: any = finalMeta ?? {};

    if (typeof qCodeFinal === 'string' && qCodeFinal.trim()) {
      const q = qCodeFinal.trim();
      m.qCode = q;
      m.q_code = q;
      m.qcode = q;
    }

    if (typeof depthStageFinal === 'string' && depthStageFinal.trim()) {
      const d = depthStageFinal.trim();
      m.depthStage = d;
      m.depth_stage = d;
      m.depthstage = d;
    }

    // ✅ 最終確定（jsonb安全を再保証）
    finalMeta = sanitizeForJsonb(m);
  } catch (e) {
    console.warn('[IROS/persist] meta sync failed', e);
    finalMeta = safeMeta;
  }

  const row = {
    conversation_id: conversationId,
    role: 'assistant',
    content: content,
    text: content,
    meta: finalMeta,

    // ✅ ここが本命（列）
    q_code: qCodeFinal,
    depth_stage: depthStageFinal,

    // ✅ schema に列がある前提（無いなら削除）
    user_code: userCode,
  };

  const { error } = await supabase.from('iros_messages').insert([row]);
  if (error) {
    console.error('[IROS/persistAssistantMessageToIrosMessages] insert error', {
      conversationId,
      userCode,
      error,
    });
    return { ok: false, inserted: false, blocked: false, reason: 'DB_ERROR', error };
  }

  return { ok: true, inserted: true, blocked: false };
}
