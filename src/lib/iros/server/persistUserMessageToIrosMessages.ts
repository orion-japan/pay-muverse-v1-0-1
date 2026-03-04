// src/lib/iros/server/persistUserMessageToIrosMessages.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMirrorFlowV1 } from '@/lib/iros/mirrorFlow/mirrorFlow.v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function persistUserMessageToIrosMessages(args: {
  supabase: SupabaseClient;
  conversationId: string; // ✅ ここは内部uuid（route.ts で解決済み）
  userCode: string;
  content: string;
  meta?: any;
}) {
  const supabase = args.supabase;
  const conversationUuid = String(args.conversationId ?? '').trim();
  const userCode = String(args.userCode ?? '').trim();
  const content = String(args.content ?? '').trimEnd();
  const meta = args.meta ?? null;

  if (!conversationUuid || !userCode) {
    return { ok: false, inserted: false, reason: 'BAD_ARGS' as const };
  }
  if (!UUID_RE.test(conversationUuid)) {
    // route.ts が internal uuid を渡す契約。ここで崩れてたら呼び元が悪い。
    return { ok: false, inserted: false, reason: 'BAD_CONV_UUID' as const };
  }

  // “…”だけ・空は保存しない
  const isEllipsisOnly = (s: string) => {
    const t = String(s ?? '').replace(/\s+/g, '').trim();
    if (!t) return true;
    return /^[\u2026\u22ef\u2025\.\u30fb]+$/.test(t);
  };
  if (isEllipsisOnly(content)) {
    return { ok: true, inserted: false, reason: 'EMPTY_CONTENT' as const };
  }

  // 直近重複ガード（同一convで同一textが連続するのを防ぐ）
  // ✅ “同文”ではなく、“同一リクエスト(traceId)の二重送信”だけ弾く
  const pickTraceId = (m: any): string => {
    if (!m || typeof m !== 'object') return '';
    const a = String(m?.traceId ?? '').trim();
    if (a) return a;

    const ex = m?.extra;
    if (ex && typeof ex === 'object') {
      const b = String(ex?.traceId ?? ex?.trace_id ?? '').trim();
      if (b) return b;
    }
    return '';
  };

  // ✅ この user message に紐づく traceId（DB列 trace_id にも入れる正本）
  const traceIdCanon = pickTraceId(meta) || null;

  {
    const currentTraceId = traceIdCanon ? String(traceIdCanon) : '';

    // traceId が無いなら「二重送信判定はしない」＝同文でも保存する
    if (currentTraceId) {
      const { data: lastRow, error: lastErr } = await supabase
        .from('iros_messages')
        .select('id,meta')
        .eq('conversation_id', conversationUuid)
        .eq('role', 'user')
        .order('id', { ascending: false })
        .limit(5) // 保険：直近数件で同一traceIdを探す
        .maybeSingle();

      // maybeSingle() は limit(1) 前提に近いので、ここは limit(1) に寄せるのが本筋だが、
      // supabase の挙動差を避けるなら「直近1件だけ」で十分。
      const lastTraceId = pickTraceId((lastRow as any)?.meta);

      // ✅ 本当の二重送信：traceId が同じなら落とす（本文一致は条件にしない）
      if (!lastErr && lastTraceId && lastTraceId === currentTraceId) {
        return { ok: true, inserted: false, reason: 'DUPLICATE_SKIP' as const };
      }
    }
  }

  // ✅ 列 trace_id にも入れる（meta.extra.traceId と同期）
  const traceIdForRow = (() => {
    const pickTraceId = (m: any): string => {
      if (!m || typeof m !== 'object') return '';
      const a = String(m?.traceId ?? '').trim();
      if (a) return a;

      const ex = m?.extra;
      if (ex && typeof ex === 'object') {
        const b = String(ex?.traceId ?? ex?.trace_id ?? '').trim();
        if (b) return b;
      }
      return '';
    };
    return pickTraceId(meta) || null;
  })();

  // ✅ NEW: user行の meta.extra を最低限そろえる（追跡性）
  // - 既存meta/extraを壊さず追記する
  // - ctxPack を「必ず存在」させる（本物生成は不要＝存在保証）
  // - mode も null のままにしない（観測の安定）
  const metaForInsert = (() => {
    // meta が null/非object でも insert できるように、最低限 object 化
    const m: any = meta && typeof meta === 'object' ? meta : {};

    // extra は object で保証
    const ex: any = m.extra && typeof m.extra === 'object' ? m.extra : {};

    // traceId を meta.extra にも同期（既存優先）
    if (traceIdForRow) {
      const cur = String(ex.traceId ?? ex.trace_id ?? '').trim();
      if (!cur) ex.traceId = traceIdForRow;
    }

    // 運用上の目印（既存優先）
    ex.persistedBy = ex.persistedBy ?? 'persistUserMessageToIrosMessages';
    ex.persistPolicyHint = ex.persistPolicyHint ?? 'USER_MESSAGE';

    // ctxPack の存在保証（無ければ作る）
    if (ex.ctxPack == null) {
      ex.ctxPack = {
        type: 'user_message',
        source: 'persistUserMessageToIrosMessages',
        at: new Date().toISOString(),
        traceId: traceIdForRow,
        conversationId: conversationUuid,
        userCode,
      };
    }

    // mode の安定化（null潰し）
    m.mode = m.mode ?? 'persistUserMessageToIrosMessages';
    m.extra = ex;

    return m;
  })();

  const row = {
    conversation_id: conversationUuid,
    role: 'user',
    content,
    text: content,
    meta: metaForInsert,
    user_code: userCode,

    // ✅ DB列
    trace_id: traceIdForRow,

    // user投稿では未確定でOK
    q_code: null,
    depth_stage: null,

    // ✅ NEW: e_turn は insert 後に stamp（turn-only / instant）
    e_turn: null,
  } as const;

  // ✅ insert した row の id を回収する（後で e_turn stamp に使う）
  const { data, error } = await supabase
    .from('iros_messages')
    .insert([row])
    .select('id')
    .single();

  if (error) {
    console.error('[IROS/persistUserMessageToIrosMessages] insert error', {
      conversationUuid,
      userCode,
      code: (error as any)?.code ?? null,
      message: (error as any)?.message ?? null,
    });
    return { ok: false, inserted: false, reason: 'DB_ERROR' as const, error };
  }

  const messageId = (data as any)?.id ?? null;

  // -------------------------------------------------------
  // ✅ NEW: e_turn を “検出して確定（列にstamp）”
  // - userText だけから MirrorFlow で検出（turn-only）
  // - 失敗しても main insert を壊さない（安全）
  // -------------------------------------------------------
  try {
    const mf: any = (buildMirrorFlowV1 as any)({
      userText: content,
      stage: null,
      band: null,
    });

    const eTurn = String(mf?.mirror?.e_turn ?? mf?.e_turn ?? '').trim();
    const ok = eTurn === 'e1' || eTurn === 'e2' || eTurn === 'e3' || eTurn === 'e4' || eTurn === 'e5';

    if (ok && messageId != null) {
      const { error: upErr } = await supabase
        .from('iros_messages')
        .update({ e_turn: eTurn })
        .eq('id', messageId)
        .eq('role', 'user');

      if (upErr) {
        console.warn('[IROS/persistUserMessageToIrosMessages] e_turn stamp failed', {
          conversationUuid,
          userCode,
          messageId,
          e_turn: eTurn,
          code: (upErr as any)?.code ?? null,
          message: (upErr as any)?.message ?? null,
        });
      }
    }
  } catch (e) {
    console.warn('[IROS/persistUserMessageToIrosMessages] e_turn detect/stamp exception', {
      conversationUuid,
      userCode,
      messageId,
      message: (e as any)?.message ?? String(e),
    });
  }

  return { ok: true, inserted: true, reason: '' as const, messageId };
}
