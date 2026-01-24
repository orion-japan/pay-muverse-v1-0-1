// src/lib/llm/chatComplete.ts
// iros — Single LLM Exit (chat.completions)
//
// 方針：
// - OpenAI への「出口」はここだけ
// - 用途は purpose で切り替える（writer/judge/digest/title/soul/reply）
// - 「黙らせる」はしない。生成は常に行い、採用/不採用は上位で決める。
//   ※ただし「SCAFFOLDでwriterを呼ぶ」など“設計違反”は、任意でガードできる（後述）
//
// 追加（監査）：
// - 呼び出しの事実を [IROS/LLM][CALL] に必ず残す（writer が呼ばれていない証拠化）
// - 失敗時も trace 情報を [IROS/LLM][ERR] に必ず残す
// - 任意の強制ガード：SCAFFOLD で writer を呼んだら例外（IROS_LLM_GUARD!=0 のとき）
//
// 注意：
// - ここは「文章の品質」ではなく、"呼び出し/監査/安全" が責務
// - trace は「top-level優先 → args.trace 互換 → null」で統一する

import crypto from 'node:crypto';
import { flagshipGuard as judgeFlagship } from '@/lib/iros/quality/flagshipGuard';


export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatPurpose = 'writer' | 'judge' | 'digest' | 'title' | 'soul' | 'reply';

/**
 * ✅ response_format 拡張
 * - text / json_object に加えて json_schema を正式対応
 * - 将来の拡張を壊さないため、body へはそのまま passthrough する
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema: Record<string, any>;
        strict?: boolean;
      };
    };

type ChatArgs = {
  purpose: ChatPurpose;
  messages: ChatMessage[];

  model?: string;
  apiKey?: string;
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;

  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  responseFormat?: ResponseFormat;

  // ✅ pass-through trace fields
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;

  // ✅ 互換：古い呼び出しが trace を渡す場合
  trace?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
  };

  // ✅ 監査の補助情報（上位が決めた結果だけ渡す）
  audit?: {
    slotPlanPolicy?: 'FINAL' | 'SCAFFOLD' | string | null;
    mode?: string | null;
    qCode?: string | null;
    depthStage?: string | null;
  };

  allowEmpty?: boolean;
};

function nowMs() {
  return Date.now();
}

function pickDefaultModel() {
  return (
    process.env.IROS_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.OPENAI_DEFAULT_MODEL ||
    'gpt-4o'
  );
}

function defaultTempByPurpose(purpose: ChatPurpose): number {
  if (purpose === 'soul') return 0;
  if (purpose === 'judge' || purpose === 'digest' || purpose === 'title') return 0.2;
  if (purpose === 'reply') return 0.35;
  return 0.6;
}

function safeTrimEnd(s: unknown): string {
  return String(s ?? '').replace(/\r\n/g, '\n').trimEnd();
}

function norm(s: unknown): string {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function makeCallId() {
  return crypto.randomBytes(6).toString('hex');
}

function head(s: string, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function tail(s: string, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

function validateMessages(messages: ChatMessage[]) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatComplete: messages is required');
  }
  for (let i = 0; i < messages.length; i++) {
    const m: any = messages[i];
    const r = String(m?.role ?? '');
    const c = String(m?.content ?? '');
    if (r !== 'system' && r !== 'user' && r !== 'assistant') {
      throw new Error(`chatComplete: invalid role at messages[${i}] = ${r}`);
    }
    if (!c.trim()) {
      throw new Error(`chatComplete: empty content at messages[${i}] (${r})`);
    }
  }
}

function pickTrace(args: ChatArgs) {
  return {
    traceId: args.traceId ?? args.trace?.traceId ?? null,
    conversationId: args.conversationId ?? args.trace?.conversationId ?? null,
    userCode: args.userCode ?? args.trace?.userCode ?? null,
  };
}

function envGuardOn(): boolean {
  const v = String(process.env.IROS_LLM_GUARD ?? '').trim().toLowerCase();
  if (!v) return true; // デフォルトON（安全側）
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return true;
}

function envFlagshipRewriteOn(): boolean {
  const v = String(process.env.IROS_FLAGSHIP_REWRITE ?? '').trim().toLowerCase();
  if (!v) return false; // デフォルトOFF（必要なときだけONにする）
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return false;
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: safeTrimEnd(m.content),
  }));
}

function safeCaller(): string | null {
  try {
    const s = new Error().stack?.split('\n') ?? [];
    // 0:Error, 1:this fn, 2:chatComplete, 3:caller...
    const line = s[3] ?? s[2] ?? '';
    const t = String(line).trim();
    return t || null;
  } catch {
    return null;
  }
}

function detectHasDigest(messages: ChatMessage[]): boolean {
  try {
    return (
      messages.some((m) =>
        /history(digest|summary)|situation[_\s-]?summary/i.test(m.content),
      ) ?? false
    );
  } catch {
    return false;
  }
}

function detectHasAnchorHints(messages: ChatMessage[]): boolean {
  try {
    return (
      messages.some((m) =>
        /intent[_\s-]?anchor|fixedNorth|itx[_\s-]?step|itx[_\s-]?reason/i.test(m.content),
      ) ?? false
    );
  } catch {
    return false;
  }
}

function lastUserHead(messages: ChatMessage[]): string | null {
  try {
    const m = [...messages].reverse().find((x) => x.role === 'user');
    return m ? head(m.content, 80) : null;
  } catch {
    return null;
  }
}

// --- ここから追加（envFlagshipRewriteOn の下あたりに置く） ---
function stripInternalExtraBody(input: Record<string, any>): Record<string, any> {
  try {
    const out: Record<string, any> = {};
    const src = input && typeof input === 'object' ? input : {};
    for (const [k, v] of Object.entries(src)) {
      // ✅ "__" で始まるものは「内部フラグ」扱い → OpenAI には送らない
      if (k.startsWith('__')) continue;
      // undefined は落とす（JSON stringify の意図しない差を避ける）
      if (typeof v === 'undefined') continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
// --- 追加ここまで ---


export async function chatComplete(args: ChatArgs): Promise<string> {
  const purpose = args.purpose;
  const model = args.model ?? pickDefaultModel();
  const apiKey = args.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const temperature =
    typeof args.temperature === 'number' ? args.temperature : defaultTempByPurpose(purpose);
  const max_tokens = typeof args.max_tokens === 'number' ? args.max_tokens : 512;

  if (process.env.IROS_DEBUG_LLM_MAXTOKENS === '1') {
    console.info('[LLM][MAXTOKENS_TRACE]', {
      purpose: args.purpose,
      model,
      max_tokens,
      temperature,
      msgCount: Array.isArray(args.messages) ? args.messages.length : null,
    });
  }

  const endpoint = args.endpoint ?? 'https://api.openai.com/v1/chat/completions';
  const extraHeaders = args.extraHeaders ?? {};


  // ✅ extraBody は「内部フラグが混ざる」ので、送信用と内部判定用を分ける
  const extraBodyRaw = (args.extraBody ?? {}) as Record<string, any>;

  // 内部判定用（OpenAIへは送らない）
  const internalFlagshipPass = Boolean(extraBodyRaw?.__flagship_pass);

  // 送信用（__ で始まるキーは全部落とす）
  const extraBody: Record<string, any> = stripInternalExtraBody(extraBodyRaw);
  const responseFormat = args.responseFormat;
  const audit = args.audit;
  const allowEmpty = Boolean(args.allowEmpty);

  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');
  if (!purpose) throw new Error('chatComplete: purpose is required');

  validateMessages(args.messages);

  const traceFinal = pickTrace(args);
  const callId = makeCallId();
  const started = nowMs();

  // ✅ Guard：SCAFFOLDでwriterを呼ぶのは設計違反（任意で遮断）
  if (envGuardOn() && audit?.slotPlanPolicy === 'SCAFFOLD' && purpose === 'writer') {
    const msg = `[IROS/LLM][GUARD] writer called under SCAFFOLD (callId=${callId})`;
    console.error(msg, {
      callId,
      purpose,
      model,
      traceId: traceFinal.traceId,
      conversationId: traceFinal.conversationId,
      userCode: traceFinal.userCode,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
    });
    throw new Error(msg);
  }

  const messages = normalizeMessages(args.messages);

  const body: Record<string, any> = {
    model,
    messages,
    temperature,
    max_tokens,
    ...extraBody,
  };

  // ✅ response_format passthrough（text は送らない / json_* はそのまま送る）
  if (responseFormat && responseFormat.type !== 'text') {
    body.response_format = responseFormat;
  }

// ===== 監査ログ（CALL）=====
try {
  const first = messages[0];
  const last = messages[messages.length - 1];

  // ✅ 送信bodyの最上位キーだけ監査（内部フラグ混入検知）
  const bodyKeys = Object.keys(body ?? {}).sort();
  const extraBodyKeys = Object.keys(extraBody ?? {}).sort();

  console.log('[IROS/LLM][CALL]', {
    callId,
    purpose,
    model,
    temperature,
    responseFormat: responseFormat?.type ?? 'text',
    endpoint,

    traceId: traceFinal.traceId,
    conversationId: traceFinal.conversationId,
    userCode: traceFinal.userCode,

    slotPlanPolicy: audit?.slotPlanPolicy ?? null,
    mode: audit?.mode ?? null,
    qCode: audit?.qCode ?? null,
    depthStage: audit?.depthStage ?? null,

    msgCount: messages.length,
    firstRole: first?.role ?? null,
    lastRole: last?.role ?? null,
    firstHead: first ? head(first.content) : null,
    lastTail: last ? tail(last.content) : null,
    lastUserHead: lastUserHead(messages),

    hasDigest: detectHasDigest(messages),
    hasAnchor: detectHasAnchorHints(messages),

    roles: messages.map((m) => m.role),
    caller: safeCaller(),

    // ✅ 追加：混入検知
    bodyKeys,
    extraBodyKeys,
    hasInternalKeys: bodyKeys.some((k) => k.startsWith('__')) || extraBodyKeys.some((k) => k.startsWith('__')),
  });
} catch {}


  let res: Response | null = null;
  let elapsed = 0;

  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

    elapsed = nowMs() - started;
  } catch (e: any) {
    // ✅ fetchレベル失敗も trace を残す
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: nowMs() - started,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'fetch',
        message: String(e?.message ?? e),
      });
    } catch {}
    throw e;
  }

  if (!res) {
    const err = new Error(`LLM fetch returned null response (${purpose})`);
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: nowMs() - started,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'fetch',
        message: err.message,
      });
    } catch {}
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM HTTP ${res.status} (${purpose}) ${text}`);
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: elapsed,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'http',
        status: res.status,
        bodyHead: head(text, 240),
      });
    } catch {}
    throw err;
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch (e: any) {
    const err = new Error(`LLM JSON parse failed (${purpose}): ${String(e?.message ?? e)}`);
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: elapsed,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'json',
        message: err.message,
      });
    } catch {}
    throw err;
  }

  const raw = data?.choices?.[0]?.message?.content;

  if (typeof raw !== 'string') {
    const err = new Error(`LLM returned non-string content (${purpose})`);
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: elapsed,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'content',
        contentType: typeof raw,
      });
    } catch {}
    throw err;
  }

  const out = safeTrimEnd(raw);

  // ─────────────────────────────────────────────
  // ✅ 旗印REWRITE（purpose=reply のときだけ / 1回だけ）
  // - IROS_FLAGSHIP_REWRITE=1 で有効化
  // - extraBody.__flagship_pass が付いている場合は再実行しない（無限ループ防止）
  const flagshipEnabled = envFlagshipRewriteOn() && purpose === 'reply' && !internalFlagshipPass;


  if (flagshipEnabled) {
    const v1 = judgeFlagship(out);

    if (!v1.ok) {
      const rewriteSystem =
        [
          'あなたは iros の会話生成（reply）担当です。',
          '',
          '【旗印】この文章は「答えを渡す」ためではなく、読み手が“自分で答えを出せる場所”に立てるための文章。',
          '',
          '【必須ルール】',
          '- 断定・指示・結論の押し付けをしない（〜すべき、必ず、絶対、結論、正解、答えは、等を避ける）',
          '- 判断を急がせない（今すぐ、急いで、今日中、等を避ける）',
          '- 質問は最大1つ（0でもOK）',
          '- 箇条書き・番号・A/B などで「増やさない」（文章で）',
          '- 励まし/評価で押さない（大丈夫、あなたならできる、等を主にしない）',
          '- “足場”だけを短く置く（観察→許可→一歩、の順でよい）',
          '',
          '【検出された違反】',
          `- 判定: ${v1.level}`,
          `- 理由: ${v1.reasons.join(' / ')}`,
          '',
          'これから出すのは「書き直した本文のみ」。',
        ].join('\n');

      // v2: 1回だけ書き直し（同じ chatComplete を再利用）
      const rewritten = await chatComplete({
        ...args,
        // 既存 messages に “書き直しルール” を追加して実行
        messages: [
          ...messages,
          { role: 'system', content: rewriteSystem },
          { role: 'user', content: out },
        ],
        // 無限ループ防止フラグ
        extraBody: { ...(extraBody ?? {}), __flagship_pass: 1 },
        // 過度に創作させない
        temperature: Math.min(0.35, temperature),
        allowEmpty: false,
      });

      const v2 = judgeFlagship(rewritten);

      // “よりマシ”を採用（両方NGでもスコアが低い方）
      const score = (v: ReturnType<typeof judgeFlagship>) =>
        v.score.fatal * 10 + v.score.warn * 3 + v.score.qCount + v.score.bulletLike;

      const pick = score(v2) <= score(v1) ? rewritten : out;

// ✅ “maxQuestions:0” を守れなかったら FATAL
function constraintsDemandZeroQuestions(text: string): boolean {
  // ここは “出力に @CONSTRAINTS が露出しない前提” なので、
  // constraints は slot 側から meta で渡されている想定。
  // もしここで参照できないなら、judgeFlagship の引数に constraints を渡す。
  return false;
}


      // ここで out を差し替える
      // 以降の [IROS/LLM][OK] ログにも反映される
      return pick;
    }
  }
  // ─────────────────────────────────────────────

  if (!allowEmpty && out.trim().length === 0) {
    const err = new Error(`LLM empty content (${purpose})`);
    try {
      console.error('[IROS/LLM][ERR]', {
        callId,
        purpose,
        model,
        ms: elapsed,
        traceId: traceFinal.traceId,
        conversationId: traceFinal.conversationId,
        userCode: traceFinal.userCode,
        stage: 'empty',
      });
    } catch {}
    throw err;
  }

  // ✅ OKログ
  try {
    console.log('[IROS/LLM][OK]', {
      callId,
      purpose,
      model,
      ms: elapsed,
      ok: true,
      usage: data?.usage ?? null,
      traceId: traceFinal.traceId,
      conversationId: traceFinal.conversationId,
      userCode: traceFinal.userCode,
      outLen: out.length,
      outHead: out.slice(0, 80),
    });
  } catch {}

  return out;
}

export async function chatCompleteJSON<T = any>(
  args: Omit<ChatArgs, 'responseFormat'> & { responseFormat?: ResponseFormat },
): Promise<T> {
  const raw = await chatComplete({
    ...args,
    responseFormat: args.responseFormat ?? { type: 'json_object' },

    // ✅ 互換：ここでも top-level を優先して確実に渡す
    traceId: (args as any).traceId ?? (args as any)?.trace?.traceId ?? null,
    conversationId: (args as any).conversationId ?? (args as any)?.trace?.conversationId ?? null,
    userCode: (args as any).userCode ?? (args as any)?.trace?.userCode ?? null,
  });

  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`LLM JSON parse failed (${(args as any)?.purpose}): ${String(e)}`);
  }
}
