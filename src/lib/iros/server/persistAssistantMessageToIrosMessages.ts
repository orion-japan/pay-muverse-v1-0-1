// src/lib/iros/server/persistAssistantMessageToIrosMessages.ts
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  conversationId: string; // ✅ internal uuid（route.ts で解決済み）
  userCode: string;
  content: string;
  meta: any; // ★ route.ts が組んだ meta を必須にする（single-writer保証鍵）
}) {
  const supabase = args.supabase;
  const conversationUuid = String(args.conversationId ?? '').trim();
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
    console.error('[IROS/persistAssistantMessageToIrosMessages] BLOCKED (not route writer)', {
      conversationUuid,
      userCode,
      hasMeta: Boolean(meta),
      metaExtraKeys: meta?.extra ? Object.keys(meta.extra) : [],
    });

    return {
      ok: false,
      inserted: false,
      blocked: true,
      reason: 'SINGLE_WRITER_GUARD_BLOCKED',
    };
  }

  if (!conversationUuid || !userCode) {
    return { ok: false, inserted: false, blocked: false, reason: 'BAD_ARGS' };
  }

  // route.ts が internal uuid を渡す契約。ここで崩れてたら呼び元が悪い。
  if (!UUID_RE.test(conversationUuid)) {
    return { ok: false, inserted: false, blocked: false, reason: 'BAD_CONV_UUID' };
  }

  // 空本文は保存しない（SILENCE等）
  // - 「……」「...」「・・・・」のような “ellipsis-only” は空扱いにする（DB汚染止血）
  const isEllipsisOnly = (s: string) => {
    const t = String(s ?? '').replace(/\s+/g, '').trim();
    if (!t) return true;
    // …(U+2026), ⋯(U+22EF), ‥(U+2025), . , ・(U+30FB)
    return /^[\u2026\u22ef\u2025\.\u30fb]+$/.test(t);
  };

  if (isEllipsisOnly(content)) {
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
  // ✅ 保存直前で meta の表記ゆれを完全同期（single source）
  // - “meta を再代入” しない。row.meta を更新するだけ。
  // - 最後に sanitize をもう一度通して jsonb 安全を確定させる。
  // =========================
  let finalMeta: any = safeMeta;
  try {
    const m: any = finalMeta ?? {};

    // ✅ rephrase系を root にも同期（DB集計/将来互換のため）
    const ex: any = m.extra ?? null;
    if (ex && typeof ex === 'object') {
      if (m.rephraseBlocks == null && Array.isArray(ex.rephraseBlocks)) m.rephraseBlocks = ex.rephraseBlocks;
      if (m.rephraseHead == null && typeof ex.rephraseHead === 'string') m.rephraseHead = ex.rephraseHead;
      if (m.rephraseApplied == null && typeof ex.rephraseApplied === 'boolean') m.rephraseApplied = ex.rephraseApplied;
      if (m.rephraseReason == null && typeof ex.rephraseReason === 'string') m.rephraseReason = ex.rephraseReason;
      if (m.rephraseBlocksAttached == null && typeof ex.rephraseBlocksAttached === 'boolean')
        m.rephraseBlocksAttached = ex.rephraseBlocksAttached;
    }

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

    finalMeta = sanitizeForJsonb(m);
  } catch (e) {
    console.warn('[IROS/persist] meta sync failed', e);
    finalMeta = safeMeta;
  }

// timeout 対策：meta を軽量化してリトライ
const shrinkMetaForPersist = (meta: any) => {
  const m: any = meta && typeof meta === 'object' ? { ...meta } : {};
  delete m.rephraseBlocks;
  delete m.rephraseBlocksAttached;

  if (m.extra && typeof m.extra === 'object') {
    const ex: any = { ...(m.extra as any) };
    delete ex.rephraseBlocks;

    // ✅ ctxPack は丸ごと消さない：必要最小だけ残す（flow + phase/depth/q + digest）
    if (ex.ctxPack && typeof ex.ctxPack === 'object') {
      const cp: any = ex.ctxPack as any;

      // flow を最小形に正規化（存在しない場合は入れない）
      const f: any = cp.flow && typeof cp.flow === 'object' ? cp.flow : null;
      const flow =
        f && (typeof f.at === 'string' || typeof f.prevAtIso === 'string' || typeof f.ageSec === 'number')
          ? {
              at: typeof f.at === 'string' ? f.at : null,
              prevAtIso: typeof f.prevAtIso === 'string' ? f.prevAtIso : null,
              ageSec: typeof f.ageSec === 'number' ? f.ageSec : null,
              sessionBreak: typeof f.sessionBreak === 'boolean' ? f.sessionBreak : false,
              fresh: typeof f.fresh === 'boolean' ? f.fresh : true,
            }
          : null;

      // ✅ ctxPack を「flowだけ」にせず、rephraseEngine が拾うキーも残す
      const nextCp: any = {};

      if (flow) nextCp.flow = flow;

      const phase = cp.phase;
      if (phase === 'Inner' || phase === 'Outer') nextCp.phase = phase;

      const depthStage = cp.depthStage;
      if (typeof depthStage === 'string' && depthStage) nextCp.depthStage = depthStage;

      const qCode = cp.qCode;
      if (typeof qCode === 'string' && qCode) nextCp.qCode = qCode;

      const historyDigestV1 = cp.historyDigestV1;
      if (historyDigestV1) nextCp.historyDigestV1 = historyDigestV1;

      ex.ctxPack = Object.keys(nextCp).length ? nextCp : undefined;
    }


    // flowTape は肥大化し得るので、timeout リトライ時は落とす
    delete ex.flowTape;

    m.extra = ex;
  }

  return sanitizeForJsonb(m);
};


  const isStatementTimeout = (e: any) => {
    const code = String(e?.code ?? '').trim();
    const msg = String(e?.message ?? '').toLowerCase();
    return code === '57014' || msg.includes('statement timeout') || msg.includes('canceling statement');
  };

  const baseRow = {
    conversation_id: conversationUuid,
    role: 'assistant',
    content: content,
    text: content,
    meta: finalMeta,

    // ✅ ここが本命（列）
    q_code: qCodeFinal,
    depth_stage: depthStageFinal,

    user_code: userCode,
  } as const;

  // 1) 通常 insert（✅ meta は “正本=finalMeta” を保存する）
  let data: any = null;
  let error: any = null;

  {
    const res = await supabase
      .from('iros_messages')
      .insert([{ ...baseRow, meta: finalMeta }]); // ✅ override
    data = (res as any).data ?? null;
    error = (res as any).error ?? null;
  }

  // 2) timeout のときだけ 1回リトライ（meta軽量化）
  if (error && isStatementTimeout(error)) {
    console.warn('[IROS/persistAssistantMessageToIrosMessages] retry with shrunk meta (statement timeout)', {
      conversationUuid,
      userCode,
      code: error?.code ?? null,
      message: error?.message ?? null,
    });

    const retryRow = {
      ...baseRow,
      meta: shrinkMetaForPersist(finalMeta), // ✅ timeout時だけ落とす
    };

    const res2 = await supabase.from('iros_messages').insert([retryRow]);
    data = (res2 as any).data ?? null;
    error = (res2 as any).error ?? null;
  }

  // 3) それでも timeout → ultra
  if (error && isStatementTimeout(error)) {
    const fm: any = finalMeta && typeof finalMeta === 'object' ? finalMeta : {};
    const ex: any = fm.extra && typeof fm.extra === 'object' ? fm.extra : {};

    const ultraMeta = sanitizeForJsonb({
      itx_step: fm.itx_step ?? fm.itxStep ?? null,
      itx_reason: fm.itx_reason ?? fm.itxReason ?? null,
      intent_anchor_key: fm.intent_anchor_key ?? fm.intentAnchorKey ?? null,
      extra: {
        traceId: ex.traceId ?? null,
        persistedByRoute: ex.persistedByRoute ?? true,
      },
    });

    console.warn('[IROS/persistAssistantMessageToIrosMessages] retry with ULTRA shrunk meta (statement timeout)', {
      conversationUuid,
      userCode,
      code: error?.code ?? null,
      message: error?.message ?? null,
    });

    const res3 = await supabase.from('iros_messages').insert([{ ...baseRow, meta: ultraMeta }]);
    data = (res3 as any).data ?? null;
    error = (res3 as any).error ?? null;
  }

  if (error) {
    console.error('[IROS/persistAssistantMessageToIrosMessages] insert error', {
      conversationUuid,
      userCode,
      error,
    });
    return { ok: false, inserted: false, blocked: false, reason: 'DB_ERROR', error };
  }

  const messageId =
    data && typeof (data as any).id === 'number'
      ? (data as any).id
      : data && typeof (data as any).id === 'string'
        ? Number((data as any).id)
        : null;

  return { ok: true, inserted: true, blocked: false, messageId };
}
