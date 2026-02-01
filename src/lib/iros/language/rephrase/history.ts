// src/lib/iros/language/rephrase/history.ts
// iros — history extraction helpers (for LLM only / non-exposed)

/* eslint-disable @typescript-eslint/no-explicit-any */

export type TurnMsg = { role: 'user' | 'assistant'; content: string };

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function clampChars(text: string, maxChars: number): string {
  const t = norm(text);
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function tryGet(obj: any, path: string[]): any {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function pickArray(v: any): any[] | null {
  return Array.isArray(v) ? v : null;
}

function normalizeRole(raw: any): 'user' | 'assistant' | null {
  const r = String(raw ?? '').trim().toLowerCase();
  if (r === 'assistant' || r === 'a' || r === 'ai' || r === 'bot' || r === 'iros') return 'assistant';
  if (r === 'user' || r === 'u' || r === 'human') return 'user';
  return null;
}

function isSystemish(m: any): boolean {
  const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
  const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();
  return roleRaw === 'system' || fromRaw === 'system';
}

function compressSameRoleSeq(msgs: TurnMsg[]): TurnMsg[] {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];
  const out: TurnMsg[] = [];
  for (const m of msgs) {
    if (!m?.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      // 同一roleが連続したら「後勝ち」で1つに圧縮（assistant連打の抑制）
      out[out.length - 1] = m;
    } else {
      out.push(m);
    }
  }
  return out;
}

function takeTailWithBalance(msgs: TurnMsg[], maxMsgs: number): TurnMsg[] {
  if (!Array.isArray(msgs) || msgs.length === 0) return [];

  // まず圧縮してから tail
  const compact = compressSameRoleSeq(msgs);
  let tail = compact.slice(Math.max(0, compact.length - maxMsgs));

  // 片側しかないなら少し広げる
  const hasA = tail.some((m) => m.role === 'assistant');
  const hasU = tail.some((m) => m.role === 'user');
  if (!(hasA && hasU)) {
    const expand = Math.min(compact.length, maxMsgs + 2);
    tail = compact.slice(Math.max(0, compact.length - expand));
  }

  // 1メッセージ上限
  tail = tail.map((m) => ({ ...m, content: clampChars(m.content, 600) })).filter((m) => !!m.content);

  // もう一回圧縮（expandで連続が復活し得るので）
  return compressSameRoleSeq(tail);
}

/**
 * internal context から "履歴っぽいテキスト" を抽出（LLM用 / 露出禁止）
 * - turns/chat/historyForWriter/historyMessages 等を広く拾う
 */
export function extractHistoryTextFromContext(userContext: unknown): string {
  if (!userContext || typeof userContext !== 'object') return '';
  const uc: any = userContext as any;

  const candidates = [
    // 近傍履歴
    tryGet(uc, ['turns']),
    tryGet(uc, ['chat']),
    tryGet(uc, ['ctxPack', 'turns']),
    tryGet(uc, ['ctxPack', 'chat']),
    tryGet(uc, ['ctx_pack', 'turns']),
    tryGet(uc, ['ctx_pack', 'chat']),

    // writer向けに刻んだ最小履歴（handleIrosReply 由来）
    tryGet(uc, ['historyForWriter']),
    tryGet(uc, ['ctxPack', 'historyForWriter']),
    tryGet(uc, ['ctx_pack', 'historyForWriter']),

    // 従来の候補
    tryGet(uc, ['historyText']),
    tryGet(uc, ['history_text']),
    tryGet(uc, ['history']),
    tryGet(uc, ['messages']),
    tryGet(uc, ['historyMessages']),
    tryGet(uc, ['history_messages']),
    tryGet(uc, ['historyX']),
    tryGet(uc, ['ctxPack', 'history']),
    tryGet(uc, ['ctx_pack', 'history']),
    tryGet(uc, ['contextPack', 'history']),
  ];

  const raw = candidates.find((x) => x != null);
  if (!raw) return '';

  if (typeof raw === 'string') return clampChars(raw, 1800);

  if (Array.isArray(raw)) {
    const items = raw
      .filter(Boolean)
      .slice(-12)
      .flatMap((m: any) => {
        if (isSystemish(m)) return [];
        const role = normalizeRole(m?.role ?? m?.r ?? m?.speaker ?? m?.type ?? m?.from) ?? 'user';
        const body = norm(m?.text ?? m?.content ?? m?.message ?? m?.in_text ?? m?.out_text ?? '');
        if (!body) return [];
        const tag = role === 'assistant' ? 'A' : 'U';
        return [`${tag}: ${body}`];
      })
      .filter(Boolean);

    return clampChars(items.join('\n'), 1800);
  }

  try {
    return clampChars(JSON.stringify(raw), 1800);
  } catch {
    return clampChars(String(raw), 1800);
  }
}

/**
 * historyMessages/messages から role/content 配列を抽出
 * - 旧い形（in/out）にも対応
 */
export function extractHistoryMessagesFromContext(userContext: unknown): TurnMsg[] {
  if (!userContext || typeof userContext !== 'object') return [];
  const uc: any = userContext as any;

  const raw =
    tryGet(uc, ['historyMessages']) ??
    tryGet(uc, ['history_messages']) ??
    tryGet(uc, ['messages']) ??
    tryGet(uc, ['history']) ??
    null;

  if (!Array.isArray(raw)) return [];

  const pickIn = (m: any) =>
    norm(
      m?.in_text ??
        m?.inText ??
        m?.in_head ??
        m?.inHead ??
        m?.in ??
        m?.userText ??
        m?.user_text ??
        '',
    );

  const pickOut = (m: any) =>
    norm(
      m?.out_text ??
        m?.outText ??
        m?.out_head ??
        m?.outHead ??
        m?.out ??
        m?.assistantText ??
        m?.assistant_text ??
        m?.assistant ??
        '',
    );

  const pickGeneric = (m: any) => norm(m?.content ?? m?.text ?? m?.message ?? '');

  const inferIsAssistant = (m: any, hasOutLike: boolean, hasInLike: boolean) => {
    const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
    const agentRaw = norm(m?.agent ?? m?.provider ?? m?.source ?? '').toLowerCase();
    const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();

    const isIrosAgent = agentRaw === 'iros' || agentRaw.includes('iros');

    const isAssistantByRole =
      roleRaw === 'assistant' ||
      roleRaw === 'bot' ||
      roleRaw === 'ai' ||
      roleRaw === 'iros' ||
      roleRaw.startsWith('assistant') ||
      roleRaw === 'a';

    const isAssistantByFrom =
      fromRaw === 'assistant' ||
      fromRaw === 'bot' ||
      fromRaw === 'ai' ||
      fromRaw === 'iros' ||
      fromRaw.startsWith('assistant') ||
      fromRaw === 'a';

    const isAssistantByAgent =
      isIrosAgent || agentRaw === 'assistant' || agentRaw === 'bot' || agentRaw === 'ai';

    if (isAssistantByRole || isAssistantByFrom || isAssistantByAgent) return true;

    // role/from/agent が空なら、in/out の存在で推定
    if (!roleRaw && !fromRaw && !agentRaw) {
      if (hasOutLike && !hasInLike) return true;
      if (!hasOutLike && hasInLike) return false;
      if (hasOutLike && hasInLike) return true;
    }

    return false;
  };

  const out = raw
    .filter(Boolean)
    .flatMap((m: any): TurnMsg[] => {
      if (isSystemish(m)) return [];

      // ✅ role が明示されている場合は最優先
      const explicitRole = normalizeRole(m?.role ?? m?.r ?? m?.speaker ?? m?.type ?? m?.from);
      if (explicitRole) {
        const content = norm(m?.content ?? m?.text ?? m?.message ?? '');
        return content ? [{ role: explicitRole, content }] : [];
      }

      const hasOutLike =
        m?.out_text != null ||
        m?.outText != null ||
        m?.out_head != null ||
        m?.outHead != null ||
        m?.out != null ||
        m?.assistantText != null ||
        m?.assistant_text != null ||
        m?.assistant != null;

      const hasInLike =
        m?.in_text != null ||
        m?.inText != null ||
        m?.in_head != null ||
        m?.inHead != null ||
        m?.in != null ||
        m?.userText != null ||
        m?.user_text != null;

      // ✅ 1レコードに in/out が両方ある形
      if (hasInLike && hasOutLike) {
        const inBody = pickIn(m);
        const outBody = pickOut(m);
        const res: TurnMsg[] = [];
        if (inBody) res.push({ role: 'user', content: inBody });
        if (outBody) res.push({ role: 'assistant', content: outBody });
        return res;
      }

      // ✅ それ以外は推定
      const isAssistant = inferIsAssistant(m, hasOutLike, hasInLike);
      const body = isAssistant
        ? pickOut(m) || (!hasOutLike ? pickGeneric(m) : '')
        : pickIn(m) || (!hasInLike ? pickGeneric(m) : '');

      return body ? [{ role: isAssistant ? 'assistant' : 'user', content: body }] : [];
    })
    .filter((x) => !!x?.content);

  return out;
}

/**
 * ✅ 直近2〜3往復（最大Nメッセージ）を抽出
 * 優先順:
 * 1) turns/chat (ctx/ctxPack/ctx_pack)
 * 2) historyForWriter (ctx/ctxPack/ctx_pack)
 * 3) historyMessages/messages/history
 */
export function extractLastTurnsFromContext(userContext: unknown): TurnMsg[] {
  if (!userContext || typeof userContext !== 'object') return [];
  const ctx: any = userContext as any;

  const maxMsgsRaw = Number(process.env.IROS_REPHRASE_LAST_TURNS_MAX);
  const maxMsgs = maxMsgsRaw > 0 ? Math.floor(maxMsgsRaw) : 6;

  const rawTurns =
    pickArray(ctx?.turns) ||
    pickArray(ctx?.chat) ||
    pickArray(ctx?.ctxPack?.turns) ||
    pickArray(ctx?.ctxPack?.chat) ||
    pickArray(ctx?.ctx_pack?.turns) ||
    pickArray(ctx?.ctx_pack?.chat) ||
    null;

  const rawHistoryForWriter =
    pickArray(ctx?.historyForWriter) ||
    pickArray(ctx?.ctxPack?.historyForWriter) ||
    pickArray(ctx?.ctx_pack?.historyForWriter) ||
    null;

  const normalizeRoleContentArray = (raw: any[]): TurnMsg[] => {
    return raw
      .filter(Boolean)
      .flatMap((m: any): TurnMsg[] => {
        if (isSystemish(m)) return [];
        const role = normalizeRole(m?.role ?? m?.r ?? m?.speaker ?? m?.type ?? m?.from);
        const content = norm(m?.content ?? m?.text ?? m?.message ?? '');
        if (!role || !content) return [];
        return [{ role, content }];
      });
  };

  const hasBothRoles = (arr: TurnMsg[]) => {
    const hasA = arr.some((m) => m.role === 'assistant');
    const hasU = arr.some((m) => m.role === 'user');
    return hasA && hasU;
  };

  let normalized: TurnMsg[] = [];

  // 1) turns/chat（ただし片側しか無いなら採用しない）
  if (rawTurns) {
    const n = normalizeRoleContentArray(rawTurns);
    if (n.length > 0 && hasBothRoles(n)) normalized = n;
  }

  // 2) historyForWriter
  if (normalized.length === 0 && rawHistoryForWriter) {
    const n = normalizeRoleContentArray(rawHistoryForWriter);
    if (n.length > 0) normalized = n;
  }

  // 3) historyMessages/messages/history
  if (normalized.length === 0) normalized = extractHistoryMessagesFromContext(ctx);
  if (normalized.length === 0) return [];

  return takeTailWithBalance(normalized, maxMsgs);
}

