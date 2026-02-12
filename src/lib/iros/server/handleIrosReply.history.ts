// file: src/lib/iros/server/handleIrosReply.history.ts
// iros — handleIrosReply history helpers (single source of truth)
//
// 目的：handleIrosReply.ts から “history 周り” を切り離して軽量化する
// 方針：
// - stringify しない（[object Object] を作らない）
// - conversationId が uuid でない場合は iros_conversations で uuid 解決してから iros_messages を引く
// - 最後に sanitize して role/text を正規化する（content object 混入を根絶）

type AnySupabase = any;

function isUuidLike(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function loadConversationHistory(
  supabaseClient: AnySupabase,
  userCode: string,
  conversationId: string,
  limit = 30,
): Promise<unknown[]> {
  const cidRaw = String(conversationId ?? '').trim();
  const ucode = String(userCode ?? '').trim();
  if (!cidRaw || !ucode) return [];

  try {
    // ✅ conversation_id(uuid) を確定する
    let conversationUuid = cidRaw;

    if (!isUuidLike(cidRaw)) {
      const { data: conv, error: convErr } = await supabaseClient
        .from('iros_conversations')
        .select('id')
        .eq('user_code', ucode)
        .eq('conversation_key', cidRaw)
        .limit(1)
        .maybeSingle();

      if (convErr) {
        console.error('[IROS/History] resolve conversation uuid failed', {
          conversationId: cidRaw,
          userCode: ucode,
          error: convErr,
        });
        return [];
      }

      if (!conv?.id) {
        // conversation がまだ無い（= messages も無い）なら空でOK
        return [];
      }

      conversationUuid = String(conv.id);
    }

    // ✅ iros_messages は uuid で引く（ここで 22P02 を潰す）
    const { data, error } = await supabaseClient
      .from('iros_messages')
      .select('role, text, content, meta, created_at')
      .eq('conversation_id', conversationUuid)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[IROS/History] load failed', {
        conversationId: cidRaw,
        conversationUuid,
        error,
      });
      return [];
    }

    const rows = (data ?? []).slice().reverse();

    const pickTextFromRow = (m: any): string => {
      // 1) content が文字列なら最優先
      if (typeof m?.content === 'string' && m.content.trim().length > 0) return m.content.trim();

      // 2) text が文字列なら採用
      if (typeof m?.text === 'string' && m.text.trim().length > 0) return m.text.trim();

      // 3) content が object の場合：安全に “中の文字列候補” だけ拾う（stringify 禁止）
      const c = m?.content;
      if (c && typeof c === 'object') {
        const cText =
          (typeof (c as any)?.text === 'string' && (c as any).text.trim().length > 0
            ? (c as any).text
            : null) ??
          (typeof (c as any)?.content === 'string' && (c as any).content.trim().length > 0
            ? (c as any).content
            : null) ??
          null;

        if (cText) return String(cText).trim();
      }

      return '';
    };

    const history = rows
      .map((m: any) => {
        const text = pickTextFromRow(m);
        return {
          role: m?.role,
          text, // ✅ sanitizeHistoryForTurn が最優先で見る正本
          meta: m?.meta && typeof m.meta === 'object' ? m.meta : undefined,
        };
      })
      .filter((x: any) => typeof x?.text === 'string' && x.text.trim().length > 0);

    console.log('[IROS/History] loaded', {
      conversationId: cidRaw,
      conversationUuid,
      limit,
      returned: history.length,
      metaSample: (history as any[]).find((x) => x?.meta)?.meta ? 'has_meta' : 'no_meta',
    });

    return history;
  } catch (e) {
    console.error('[IROS/History] unexpected', { conversationId: cidRaw, error: e });
    return [];
  }
}

/**
 * ✅ this turn の history を 1回だけ組み立てる（この関数の返り値を全段に渡す）
 * - 返す前に sanitize して [object Object] 混入を根絶する
 */
export function sanitizeHistoryForTurn(history: unknown[], maxTotal: number): unknown[] {
  if (!Array.isArray(history) || history.length === 0) return [];

  const out: any[] = [];

  for (const m of history) {
    if (m == null || typeof m !== 'object') continue;

    const roleRaw = (m as any)?.role;
    const role = typeof roleRaw === 'string' ? roleRaw.toLowerCase().trim() : '';

    // role が壊れてる行は落とす（orchestrator 側の filter を安定させる）
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) continue;

    const v = (m as any)?.text ?? (m as any)?.content ?? null;

    // ✅ 文字列以外は絶対に stringify しない（[object Object] を作らない）
    if (typeof v !== 'string') continue;

    const text = v.trim();
    if (!text) continue;

    // text を正に統一（content が object の可能性を潰す）
    const mm: any = { ...(m as any), role, text };

    // content が残っていても良いが、誤混入を防ぐなら消す
    if (typeof mm.content !== 'string') delete mm.content;

    out.push(mm);
    if (out.length >= maxTotal) break;
  }

  return out;
}

export async function buildHistoryForTurn(args: {
  supabaseClient: AnySupabase;
  conversationId: string;
  userCode: string;
  providedHistory?: unknown[] | null;
  includeCrossConversation?: boolean;
  baseLimit?: number;
  maxTotal?: number;

  // cross-conversation は呼び出し側で mergeHistoryForTurn をやる（ここでは責務外）
}): Promise<unknown[]> {
  const {
    supabaseClient,
    conversationId,
    userCode,
    providedHistory,
    includeCrossConversation = false, // ここでは false が安全。必要なら呼び出し側で merge して渡す
    baseLimit = 30,
    maxTotal = 80,
  } = args;

  // 1) base
  let turnHistory: unknown[] = Array.isArray(providedHistory)
    ? providedHistory
    : await loadConversationHistory(supabaseClient, userCode, conversationId, baseLimit);

  // 2) cross-conversation はこのモジュールでは扱わない（責務を狭める）
  //    includeCrossConversation が true で来ても “ここでは何もしない”
  //    ※呼び出し側で HistoryX と mergeHistoryForTurn を実施してから sanitize に渡す
  void includeCrossConversation;

  // ✅ 最後に sanitize（正本）
  turnHistory = sanitizeHistoryForTurn(turnHistory, maxTotal);

  return turnHistory;
}
