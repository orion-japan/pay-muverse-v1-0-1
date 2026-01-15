// src/lib/iros/language/rephrase/history.ts
// iros — history extraction helpers (for LLM only / non-exposed)

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
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

/**
 * internal context から "履歴っぽいテキスト" を抽出（LLM用 / 露出禁止）
 */
export function extractHistoryTextFromContext(userContext: unknown): string {
  if (!userContext || typeof userContext !== 'object') return '';
  const uc: any = userContext as any;

  const candidates = [
    tryGet(uc, ['historyText']),
    tryGet(uc, ['history_text']),
    tryGet(uc, ['history']),
    tryGet(uc, ['messages']),
    tryGet(uc, ['historyMessages']),
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
      .map((m: any) => {
        const role = String(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
        const body = norm(m?.text ?? m?.content ?? m?.message ?? '');
        if (!body) return '';
        const tag = role.startsWith('a') ? 'A' : role.startsWith('u') ? 'U' : 'M';
        return `${tag}: ${body}`;
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

export function extractHistoryMessagesFromContext(
  userContext: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
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

  const isSystemish = (m: any) => {
    const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
    const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();
    return roleRaw === 'system' || fromRaw === 'system';
  };

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

    if (!roleRaw && !fromRaw && !agentRaw) {
      if (hasOutLike && !hasInLike) return true;
      if (!hasOutLike && hasInLike) return false;
      if (hasOutLike && hasInLike) return true;
    }

    return false;
  };

  const out = raw
    .filter(Boolean)
    .flatMap((m: any) => {
      if (isSystemish(m)) return [];

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

      if (hasInLike && hasOutLike) {
        const inBody = pickIn(m);
        const outBody = pickOut(m);

        const res: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (inBody) res.push({ role: 'user', content: inBody });
        if (outBody) res.push({ role: 'assistant', content: outBody });
        return res;
      }

      const isAssistant = inferIsAssistant(m, hasOutLike, hasInLike);

      const body = isAssistant
        ? pickOut(m) || (!hasOutLike ? pickGeneric(m) : '')
        : pickIn(m) || (!hasInLike ? pickGeneric(m) : '');

      if (!body) return [];
      return [{ role: isAssistant ? ('assistant' as const) : ('user' as const), content: body }];
    });

  return out.filter((x) => !!x?.content);
}

/**
 * ✅ 直近2往復（最大4メッセージ）を抽出（固定）
 * - turns/chat があれば優先
 * - 無ければ historyMessages/messages から組み立てる
 */
export function extractLastTurnsFromContext(
  userContext: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!userContext || typeof userContext !== 'object') return [];
  const ctx: any = userContext as any;

  const rawTurns =
    pickArray(ctx?.turns) ||
    pickArray(ctx?.chat) ||
    pickArray(ctx?.ctxPack?.turns) ||
    pickArray(ctx?.ctxPack?.chat) ||
    pickArray(ctx?.ctx_pack?.turns) ||
    pickArray(ctx?.ctx_pack?.chat) ||
    null;

  const normalizeTurnsArray = (
    raw: any[],
  ): Array<{ role: 'user' | 'assistant'; content: string }> => {
    return raw
      .map((m) => {
        const roleRaw = String(m?.role ?? m?.r ?? '').trim().toLowerCase();
        const role =
          roleRaw === 'assistant' || roleRaw === 'a'
            ? ('assistant' as const)
            : roleRaw === 'user' || roleRaw === 'u'
              ? ('user' as const)
              : null;

        const content = norm(m?.content ?? m?.text ?? m?.message ?? '');
        if (!role || !content) return null;
        return { role, content };
      })
      .filter(Boolean) as Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  let normalized: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (rawTurns) normalized = normalizeTurnsArray(rawTurns);
  if (normalized.length === 0) normalized = extractHistoryMessagesFromContext(ctx);
  if (normalized.length === 0) return [];

  let tail = normalized.slice(Math.max(0, normalized.length - 4));

  const hasAssistant = tail.some((m) => m.role === 'assistant');
  const hasUser = tail.some((m) => m.role === 'user');

  if (!(hasAssistant && hasUser)) {
    tail = normalized.slice(Math.max(0, normalized.length - 6));
  }

  tail = tail.map((m) => ({ ...m, content: clampChars(m.content, 600) }));

  return tail;
}
