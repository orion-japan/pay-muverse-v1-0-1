// file: src/lib/iros/server/handleIrosReply.ts

import OpenAI from 'openai';

import type { IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import type { IrosUserProfileRow } from './loadUserProfile';

import { getIrosSupabaseAdmin } from './handleIrosReply.supabase';

import { runGreetingGate } from './handleIrosReply.gates';
import { buildTurnContext } from './handleIrosReply.context';
import { runOrchestratorTurn } from './handleIrosReply.orchestrator';
import { postProcessReply } from './handleIrosReply.postprocess';
import { runGenericRecallGate } from '@/lib/iros/server/gates/genericRecallGate';

import {
  persistAssistantMessage,
  persistIntentAnchorIfAny,
  persistMemoryStateIfAny,
  persistUnifiedAnalysisIfAny,
  persistQCodeSnapshotIfAny,
} from './handleIrosReply.persist';

import {
  detectAchievementSummaryPeriod,
  loadNormalizedMessagesForPeriod,
  buildAchievementSummary,
  renderAchievementSummaryText,
} from '@/lib/iros/server/achievementSummaryGate';

import {
  loadRecentHistoryAcrossConversations,
  mergeHistoryForTurn,
} from '@/lib/iros/server/historyX';

// ★ アンカー汚染を防ぐための判定（保存ゲートと同じ基準）
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

// ✅ micro writer（短文LLM）
import {
  runMicroWriter,
  type MicroWriterGenerate,
} from '@/lib/iros/writers/microWriter';

import { loadLatestGoalByUserCode } from '@/lib/iros/server/loadLatestGoalByUserCode';

// ✅ FramePlan（器＋スロット）(Layer C/D)
import {
  buildFramePlan,
  type InputKind,
  type IrosStateLite,
} from '@/lib/iros/language/frameSlots';



/* =========================
   Helpers: Achievement summary drop filter
========================= */

function shouldDropFromAchievementSummary(s: unknown): boolean {
  const t = String(s ?? '').trim();
  if (!t) return true;

  // 1) 目標 recall 系の質問（宣言ではない）
  if (
    /(今日の目標|目標|ゴール).*(覚えてる|なんだっけ|何だっけ|教えて|\?|？)/.test(t) ||
    /^(今日の目標|目標|ゴール)\s*$/.test(t)
  )
    return true;

  // 2) 開発・設計・プロンプト貼り付け系（進捗ではない）
  const devHints = [
    'Sofia → Iros',
    'IROS_SYSTEM',
    'SYSTEM',
    'プロトコル',
    'meta 状態',
    'meta値',
    '推定',
    'このまま',
    '組み込める',
    'テキスト',
    '返答です',
  ];
  if (devHints.some((k) => t.includes(k))) return true;

  // 3) コード／コマンド／パスっぽいもの
  if (
    /(^\s*\/\/|^\s*\/\*|\bimport\b|\bexport\b|src\/|npm run|tsc -p)/.test(t)
  )
    return true;

  // 4) 相談・質問・他者事例（進捗ではない）
  if (
    /(どう対応|どうしたら|どうすれば|どのように対応|アドバイス|教えてください)/.test(
      t,
    )
  )
    return true;

  // 他人主語が明確な相談
  if (/(その人は|あの人は|彼は|彼女は|上司が|部下が|親会社が|相手が)/.test(t))
    return true;

  return false;
}

/* =========================
   Helpers: InputKind detector (LLM禁止・純関数)
========================= */

function detectInputKind(userText: string): InputKind {
  const s = String(userText ?? '').trim();
  if (!s) return 'unknown';

  // review（達成/振り返り系。period gate に乗らない場合でも“器”を選べるように）
  if (/(達成|サマリ|進捗|振り返り|まとめ|総括|レビュー|できたこと|やったこと)/.test(s)) {
    return 'review';
  }

  // task（実装/修正/デバッグ/設計）
  if (
    /(実装|修正|改修|デバッグ|バグ|エラー|ログ|原因|再現|調査|確認|設計|仕様|コード|関数|ファイル|import|export|tsc|typecheck|TypeScript|Next\.js|Supabase|SQL)/i.test(
      s,
    )
  ) {
    return 'task';
  }

  // question（明確な質問）
  if (
    /[?？]$/.test(s) ||
    /(なに|何|どこ|いつ|だれ|誰|なぜ|どうして|どうやって)/.test(s)
  ) {
    return 'question';
  }

  return 'chat';
}

/* =========================
   Types
========================= */

export type HandleIrosReplyInput = {
  conversationId: string;
  text: string;
  hintText?: string;
  mode: string;
  userCode: string;
  tenantId: string;
  rememberScope: RememberScopeKind | null;
  reqOrigin: string;
  authorizationHeader: string | null;
  traceId?: string | null;

  userProfile?: IrosUserProfileRow | null;
  style?: IrosStyle | string | null;

  /** ✅ 会話履歴（Writer/LLMに渡すため） */
  history?: unknown[];
    // ✅ 追加：route.ts から渡す拡張情報（NextStep / IT trigger / renderMode など）
    extra?: Record<string, any>;
};

export type HandleIrosReplySuccess = {
  ok: true;
  result: any;
  assistantText: string;
  metaForSave: any;
  finalMode: string | null;
};

export type HandleIrosReplyError = {
  ok: false;
  error: 'generation_failed';
  detail: string;
};

export type HandleIrosReplyOutput =
  | HandleIrosReplySuccess
  | HandleIrosReplyError;

const supabase = getIrosSupabaseAdmin();
const IROS_MODEL =
  process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';


/**
 * ✅ Goal recall を完全に止めるフラグ
 * - '1' のときだけ有効
 * - それ以外は無効（デフォルトOFF）
 */
const enableGoalRecall = process.env.IROS_ENABLE_GOAL_RECALL === '1';



/* =========================
   History loader (single source of truth)
========================= */

async function loadConversationHistory(
  supabaseClient: any,
  conversationId: string,
  limit = 30,
): Promise<unknown[]> {
  try {
    const { data, error } = await supabaseClient
      .from('iros_messages')
      // ✅ meta を必ず取る（qPrimary/qTrace/depthなどがここに入ってる想定）
      .select('role, text, content, meta, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[IROS/History] load failed', { conversationId, error });
      return [];
    }

    const rows = (data ?? []).slice().reverse();

    const history = rows.map((m: any) => ({
      role: m?.role,
      content:
        typeof m?.content === 'string' && m.content.trim().length > 0
          ? m.content
          : typeof m?.text === 'string'
            ? m.text
            : '',
      // ✅ generate側が m.meta.qPrimary / m.meta.q_code を拾えるようにする
      meta: m?.meta && typeof m.meta === 'object' ? m.meta : undefined,
    }));

    console.log('[IROS/History] loaded', {
      conversationId,
      limit,
      returned: history.length,
      metaSample: (history as any[]).find((x) => x?.meta)?.meta
        ? 'has_meta'
        : 'no_meta',
      first: (history as any[])[0]?.content?.slice?.(0, 40),
      last: (history as any[])[history.length - 1]?.content?.slice?.(0, 40),
    });

    return history;
  } catch (e) {
    console.error('[IROS/History] unexpected', { conversationId, error: e });
    return [];
  }
}

/**
 * ✅ this turn の history を 1回だけ組み立てる（この関数の返り値を全段に渡す）
 * - params.history があればそれを優先（API層から渡す想定）
 * - なければ conversationId の messages をロード
 * - さらに user_code ベースの cross-conversation を必要に応じてマージ
 */
async function buildHistoryForTurn(args: {
  supabaseClient: any;
  conversationId: string;
  userCode: string;
  providedHistory?: unknown[] | null;
  includeCrossConversation?: boolean;
  baseLimit?: number;
  crossLimit?: number;
  maxTotal?: number;
}): Promise<unknown[]> {
  const {
    supabaseClient,
    conversationId,
    userCode,
    providedHistory,
    includeCrossConversation = true,
    baseLimit = 30,
    crossLimit = 60,
    maxTotal = 80,
  } = args;

  // 1) base
  let turnHistory: unknown[] = Array.isArray(providedHistory)
    ? providedHistory
    : await loadConversationHistory(supabaseClient, conversationId, baseLimit);

  // 2) cross-conversation
  if (includeCrossConversation) {
    try {
      const dbHistory = await loadRecentHistoryAcrossConversations({
        supabase: supabaseClient,
        userCode,
        limit: crossLimit,
        excludeConversationId: conversationId,
      });

      turnHistory = mergeHistoryForTurn({
        dbHistory,
        turnHistory: turnHistory as any[],
        maxTotal,
      });

      console.log('[IROS][HistoryX] merged', {
        userCode,
        dbCount: dbHistory.length,
        mergedCount: Array.isArray(turnHistory) ? turnHistory.length : -1,
      });
    } catch (e) {
      console.warn('[IROS][HistoryX] merge failed', e);
    }
  }

  return turnHistory;
}

/* =========================
   Timing helpers
========================= */

function nowNs(): bigint {
  return process.hrtime.bigint();
}
function msSince(startNs: bigint): number {
  const diff = process.hrtime.bigint() - startNs;
  return Number(diff) / 1_000_000;
}
function nowIso(): string {
  return new Date().toISOString();
}

/* =========================
   Micro bypass
========================= */

// ✅ MicroGate をバイパスすべき “文脈参照クエリ” 判定
function shouldBypassMicroGate(userText: string): boolean {
  const s = (userText ?? '').trim();
  if (!s) return false;

  const keywords = [
    '覚えて',
    '覚えてない',
    'なんでしたっけ',
    '何でしたっけ',
    'さっき',
    '先ほど',
    '前に',
    '目標',
    'どれだっけ',
    'どっちだっけ',
    '言った',
  ];

  if (keywords.some((k) => s.includes(k))) return true;

  return false;
}

/* =========================
   Micro turn detect (inline)
========================= */

function normalizeTailPunct(s: string): string {
  return (s ?? '').trim().replace(/[！!。．…]+$/g, '').trim();
}
function buildMicroCore(raw: string) {
  const rawTrim = (raw ?? '').trim();
  const hasQuestion = /[?？]$/.test(rawTrim);

  const core = normalizeTailPunct(rawTrim)
    .replace(/[?？]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return { rawTrim, hasQuestion, core, len: core.length };
}
function isMicroTurn(raw: string): boolean {
  const { rawTrim, core, len } = buildMicroCore(raw);
  if (!rawTrim) return false;

  if (/[A-Za-z0-9]/.test(core)) return false;

  if (/(何|なに|どこ|いつ|だれ|誰|なぜ|どうして|どうやって|いくら|何色|色)/.test(core)) {
    return false;
  }

  if (len < 2 || len > 10) return false;

  return /^(どうする|やる|やっちゃう|いく|いける|どうしよ|どうしよう|行く|行ける)$/.test(
    core,
  );
}

/* =========================
   Goal recall gate helpers
========================= */

function isGoalRecallQ(text: string): boolean {
  const s = String(text ?? '').trim();
  return /^(?:今日の)?(?:目標|ゴール)\s*(?:覚えてる|覚えてる\?|覚えてる？|なんだっけ|なんだっけ\?|なんだっけ？|何だっけ|何だっけ\?|何だっけ？|って何|は何|教えて)/.test(
    s,
  );
}

const norm = (v: any): string => {
  if (v == null) return '';

  // OpenAI-style content parts
  if (Array.isArray(v)) {
    const parts = v
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p) return '';
        if (typeof p === 'object') {
          if (typeof (p as any).text === 'string') return (p as any).text;
          if (typeof (p as any).content === 'string') return (p as any).content;
          if (typeof (p as any).value === 'string') return (p as any).value;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return parts.replace(/\s+/g, ' ').trim();
  }

  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();

  if (typeof v === 'object') {
    const t =
      (typeof (v as any).text === 'string' && (v as any).text) ||
      (typeof (v as any).content === 'string' && (v as any).content) ||
      (typeof (v as any).message === 'string' && (v as any).message) ||
      '';
    return String(t).replace(/\s+/g, ' ').trim();
  }

  return String(v).replace(/\s+/g, ' ').trim();
};

function extractGoalFromHistory(history: any[]): string | null {
  const arr = Array.isArray(history) ? history : [];

  const normText = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

  const toText = (v: any): string => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p?.type === 'text' && typeof p?.text === 'string') return p.text;
          if (typeof p?.text === 'string') return p.text;
          if (typeof p?.content === 'string') return p.content;
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (typeof v.content === 'string') return v.content;
    }
    return '';
  };

  const getText = (m: any) =>
    normText(toText(m?.content ?? m?.text ?? (m as any)?.message ?? ''));

  const cleanup = (raw: unknown): string | null => {
    let out = normText(raw);
    if (!out) return null;

    if (out === '[object Object]' || out.includes('[object Object]')) return null;

    out = out.replace(/^今日の目標は[「『"]?/g, '');
    out = out.replace(/[」』"]?です[。\.！!]?$/g, '');

    out = out.replace(/^[\s「『"'\(\[\{、,，。．・:：\-—–]+/g, '');
    out = out.replace(/[\s」』"'\)\]\}、,，。．・]+$/g, '');

    out = out.trim();
    if (!out) return null;
    if (out.length <= 2) return null;
    return out;
  };

  const isGoalRecallQuestion = (s: string) =>
    /(今日の目標|目標|ゴール|goal).*(覚えてる|なんだっけ|何\?|何？|教えて)/i.test(s) ||
    /^(今日の目標|目標|ゴール|goal)\s*(は|って|を)?\s*(\?|？)$/.test(s);

  const isGoalStatement = (s: string) => {
    if (isGoalRecallQuestion(s)) return false;
    if (
      /^(今日は|今日|本日)/.test(s) &&
      /(する|やる|直す|実装|確認|整理|調査|再現|通す|分割|移行|追加|削除|テスト)/.test(s)
    ) {
      return true;
    }
    if (/(今日の目標|目標|ゴール|goal)\s*(は|:|：)/i.test(s)) return true;
    return false;
  };

  const fallback: string[] = [];

  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const role = String(m?.role ?? '').toLowerCase();
    if (role !== 'user') continue;

    const t = getText(m);
    if (!t) continue;

    const cleaned = cleanup(t);
    if (!cleaned) continue;

    if (isGoalRecallQuestion(cleaned)) continue;
    if (/\?$|？$/.test(cleaned)) continue;

    if (isGoalStatement(cleaned)) return cleaned;
    fallback.push(cleaned);
  }

  return fallback.length ? fallback[0] : null;
}

/* =========================
   IntentAnchor sanitize
========================= */

function pickIntentAnchorText(m: any): string {
  const a1 = m?.intentAnchor;
  const t1 =
    (a1?.anchor_text ?? '') ||
    (a1?.anchorText ?? '') ||
    (a1?.text ?? '') ||
    '';

  const a2 = m?.intent_anchor;
  const t2 =
    (a2?.anchor_text ?? '') ||
    (a2?.anchorText ?? '') ||
    (a2?.text ?? '') ||
    '';

  return String(t1 || t2 || '');
}

function sanitizeIntentAnchorMeta(metaForSave: any): any {
  const m = metaForSave ?? {};
  if (!m.intentAnchor && !m.intent_anchor) return m;

  const fixedNorthKey =
    typeof m?.fixedNorth?.key === 'string' ? m.fixedNorth.key : null;

  const fixed1 = Boolean(m?.intentAnchor?.fixed);
  const fixed2 = Boolean(m?.intent_anchor?.fixed);

  if (fixedNorthKey === 'SUN' || fixed1 || fixed2) {
    return m;
  }

  const anchorText = pickIntentAnchorText(m);
  const hasText = Boolean(anchorText && anchorText.trim());

  const aCamel = m.intentAnchor;
  const aSnake = m.intent_anchor;

  const looksLikeRow =
    Boolean(aCamel?.id) ||
    Boolean(aCamel?.user_id) ||
    Boolean(aCamel?.created_at) ||
    Boolean(aCamel?.updated_at) ||
    Boolean(aSnake?.id) ||
    Boolean(aSnake?.user_id) ||
    Boolean(aSnake?.created_at) ||
    Boolean(aSnake?.updated_at);

  if (!hasText) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  if (isMetaAnchorText(anchorText)) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  const ev: string | null =
    m.anchorEventType ??
    m.intentAnchorEventType ??
    m.anchor_event_type ??
    m.intent_anchor_event_type ??
    null;

  const shouldBeRealEvent = ev === 'set' || ev === 'reset';

  if (!looksLikeRow && !shouldBeRealEvent) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  return m;
}

/* =========================================================
   Micro Writer: generator（同じOpenAIで短文だけ作る）
========================================================= */

const microGenerate: MicroWriterGenerate = async (args) => {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages: [
      { role: 'system', content: String(args.system ?? '') },
      { role: 'user', content: String(args.prompt ?? '') },
    ],
    temperature: typeof args.temperature === 'number' ? args.temperature : 0.6,
    max_tokens: typeof args.maxTokens === 'number' ? args.maxTokens : 140,
  });

  return res.choices?.[0]?.message?.content ?? '';
};

/* =========================================================
   main
========================================================= */

export async function handleIrosReply(
  params: HandleIrosReplyInput,
): Promise<HandleIrosReplyOutput> {
  const t0 = nowNs();
  const startedAt = nowIso();

  const t: any = {
    started_at: startedAt,
    finished_at: startedAt,
    total_ms: 0,

    gate_ms: 0,
    context_ms: 0,
    orchestrator_ms: 0,
    postprocess_ms: 0,

    persist_ms: {
      q_snapshot_ms: 0,
      intent_anchor_ms: 0,
      memory_state_ms: 0,
      unified_analysis_ms: 0,
      assistant_message_ms: 0,
      total_ms: 0,
    },
  };

  const {
    conversationId,
    text,
    mode,
    userCode,
    tenantId,
    rememberScope,
    reqOrigin,
    authorizationHeader,
    traceId,
    userProfile,
    style,
    history,
    extra, // ✅ 追加：route.ts から渡される拡張情報（NextStep / IT trigger / renderMode 等）
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    style,
    history_len: Array.isArray(history) ? history.length : null,
  });

  console.log('[IROS/Reply] extra keys', {
    conversationId,
    keys: Object.keys(extra ?? {}),
    extra: extra ?? null,
  });



  try {
    /* ---------------------------
       0) Gates
    ---------------------------- */

    const tg = nowNs();

    const gatedGreeting = await runGreetingGate({
      supabase,
      conversationId,
      userCode,
      text,
      userProfile,
      reqOrigin,
      authorizationHeader,
    });
    if (gatedGreeting) return gatedGreeting;

    const bypassMicro = shouldBypassMicroGate(text);

    // ✅ Micro（独立ルート）
    if (!bypassMicro && isMicroTurn(text)) {
      const name = userProfile?.user_call_name || 'あなた';
      const seed = `${conversationId}|${userCode}|${traceId ?? ''}|${Date.now()}`;

      const mw = await runMicroWriter(microGenerate, {
        name,
        userText: text,
        seed,
      });

      if (mw.ok) {
        // ✅ single source of truth（microでも同じ historyForTurn を1回だけ作る）
        const historyForTurn = await buildHistoryForTurn({
          supabaseClient: supabase,
          conversationId,
          userCode,
          providedHistory: history ?? null,
          includeCrossConversation: false, // microは軽量優先（必要なら true にしてOK）
          baseLimit: 30,
        });

        // 2) context（数値メタだけ欲しい）
        const tc = nowNs();
        const ctx = await (buildTurnContext as any)({
          supabase,
          conversationId,
          userCode,
          text,
          mode,
          traceId,
          userProfile,
          requestedStyle: style ?? null,
          history: historyForTurn,
        });
        t.context_ms = msSince(tc);

        // 3) meta（短文用：数値だけは乗せる）
        const metaForSave: any = {
          ...(ctx?.baseMetaForTurn ?? {}),
          style:
            ctx?.effectiveStyle ??
            style ??
            (userProfile as any)?.style ??
            'friendly',

          mode: 'light',
          microOnly: true,

          skipMemory: true,
          skipTraining: true,

          nextStep: null,
          next_step: null,
          timing: t,
        };

        // SUN固定保護（念のため）
        try {
          const sanitized = sanitizeIntentAnchorMeta(metaForSave);
          Object.assign(metaForSave, sanitized);
        } catch {}

        // 4) persist（最低限）
        const ts = nowNs();

        const t1 = nowNs();
        await persistQCodeSnapshotIfAny({
          userCode,
          conversationId,
          requestedMode: ctx?.requestedMode ?? mode,
          metaForSave,
        });
        t.persist_ms.q_snapshot_ms = msSince(t1);

        const t5 = nowNs();
        await persistAssistantMessage({
          supabase,
          reqOrigin,
          authorizationHeader,
          conversationId,
          userCode,
          assistantText: mw.text,
          metaForSave,
        });
        t.persist_ms.assistant_message_ms = msSince(t5);

        t.persist_ms.total_ms = msSince(ts);

        t.gate_ms = msSince(tg);
        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        return {
          ok: true,
          result: { gate: 'micro_writer' },
          assistantText: mw.text,
          metaForSave,
          finalMode: 'light',
        };
      }

      console.warn('[IROS/MicroWriter] failed -> fallback to normal', {
        reason: mw.reason,
        detail: mw.detail,
      });
    } else if (bypassMicro) {
      console.log('[IROS/Gate] bypass micro gate (context recall)', {
        conversationId,
        userCode,
        text,
      });
    }

    t.gate_ms = msSince(tg);

    /* ---------------------------
       1) History (single source of truth for this turn)
       - ここで1回だけ作って、以後すべてに渡す
    ---------------------------- */

    const historyForTurn: unknown[] = await buildHistoryForTurn({
      supabaseClient: supabase,
      conversationId,
      userCode,
      providedHistory: history ?? null,
      includeCrossConversation: true,
      baseLimit: 30,
      crossLimit: 60,
      maxTotal: 80,
    });

    // デバッグ：直近3件だけ
    console.log(
      '[DEBUG][historyForTurn last3]',
      (historyForTurn as any[]).slice(-3).map((m, i) => ({
        idx: i,
        role: m?.role,
        contentType: typeof m?.content,
        content: m?.content,
        text: m?.text,
      })),
    );

    /* ---------------------------
       ✅ Goal recall: ここで確定回答してLLMへ流さない
    ---------------------------- */

    const goalRecallQ = isGoalRecallQ(text);

    // ✅ デモ中の誤爆を止める：ENVが1のときだけ Goal recall を動かす
if (enableGoalRecall && goalRecallQ) {

      let goalRaw: string | null = null;
      let goalSource: 'db' | 'history' | 'none' = 'none';

      // 1) DB（user_code基準）で最新goalを拾う（conversationId完全無視）
      try {
        const hit = await loadLatestGoalByUserCode(supabase, userCode, {
          limit: 250,
        });
        if (hit?.goalText) {
          goalRaw = hit.goalText;
          goalSource = 'db';
        }
      } catch (e) {
        console.warn(
          '[goal_recall] loadLatestGoalByUserCode failed (fallback to history)',
          e,
        );
      }

      // 2) DBで取れなければ historyForTurn fallback
      if (!goalRaw) {
        goalRaw = extractGoalFromHistory(historyForTurn as any[]);
        if (goalRaw) goalSource = 'history';
      }

      if (!goalRaw) goalSource = 'none';

      function concretizeGoalOneLine(goal: string | null): string | null {
        if (!goal) return null;
        const g = String(goal).trim();
        if (!g) return null;

        const looksSpecific =
          g.length >= 12 ||
          /[0-9]/.test(g) ||
          /（|\(|:|：|->|→|\/|・/.test(g) ||
          /(修正|実装|確認|整理|分割|移行|追加|削除|テスト|直す|原因|調査|再現|通す)/.test(g);

        if (looksSpecific) return g;

        if (g === 'iros進') {
          return 'irosを前に進める：goal recallの挙動を整えて、typecheckが通る状態にする';
        }
        if (/回転|3軸|スピン/.test(g)) {
          return '3軸回転を前に進める：spinLoopの配線を整理し、renderまで一周させる';
        }
        if (/目標|goal/.test(g)) {
          return '目標まわりを整える：抽出ロジックのノイズを直し、1行で返せるようにする';
        }
        if (/記憶|memory|recall/.test(g)) {
          return '記憶／recallを整える：goal系をrecall gateに落とさず安定動作させる';
        }

        return `${g}を前に進める：今日の詰まりを1点直して確認まで行う`;
      }

      const goal1 = concretizeGoalOneLine(goalRaw);

      const assistantText = goal1
        ? `今日の目標は「${goal1}」です。🪔`
        : `直近の履歴から「今日の目標」が見つかりませんでした。いまの目標を1行で置いてください。🪔`;

      const metaForSave = {
        style: style ?? (userProfile as any)?.style ?? 'friendly',
        mode: 'light',
        goalRecallOnly: true,
        skipTraining: true,
        skipMemory: true,
        nextStep: null,
        next_step: null,
        timing: t,
      };

      await persistAssistantMessage({
        supabase,
        reqOrigin,
        authorizationHeader,
        conversationId,
        userCode,
        assistantText,
        metaForSave,
      });

      t.finished_at = nowIso();
      t.total_ms = msSince(t0);

      return {
        ok: true,
        result: { gate: 'goal_recall', found: Boolean(goal1), source: goalSource },
        assistantText,
        metaForSave,
        finalMode: 'light',
      };
    }

    /* ---------------------------
       ✅ Achievement Summary Gate（明示トリガーがある時だけ）
    ---------------------------- */

    const wantsAchSummary =
      /(?:達成|サマリ|進捗|振り返り|まとめ|総括|レビュー|できたこと|やったこと)/.test(text) &&
      /(?:昨日|今日|先週|今週|最近|直近|\d+日|\d+週間|\d+週)/.test(text);

    const period = wantsAchSummary ? detectAchievementSummaryPeriod(text) : null;

    if (period) {
      try {
        const msgs = await loadNormalizedMessagesForPeriod({
          supabase,
          userCode,
          startIso: period.startIso,
          endIso: period.endIso,
          limit: 200,
        });

        const allUser = (msgs ?? []).filter(
          (m: any) => String(m?.role ?? '').toLowerCase() === 'user',
        );

        const dropped = allUser
          .map((m: any) => String(m?.text ?? m?.content ?? ''))
          .filter((s: string) => shouldDropFromAchievementSummary(s));

        const kept = allUser
          .map((m: any) => String(m?.text ?? m?.content ?? ''))
          .filter((s: string) => !shouldDropFromAchievementSummary(s));

        console.log('[IROS][AchSummary][debug]', {
          kind: period.kind,
          totalUser: allUser.length,
          dropped: dropped.length,
          kept: kept.length,
          droppedHead: dropped.slice(0, 5),
          keptHead: kept.slice(0, 5),
        });

        const userMsgs = (msgs ?? [])
          .filter((m: any) => String(m?.role ?? '').toLowerCase() === 'user')
          .filter(
            (m: any) =>
              !shouldDropFromAchievementSummary(String(m?.text ?? m?.content ?? '')),
          );

        const summary = buildAchievementSummary(userMsgs as any, period);
        const assistantText = renderAchievementSummaryText(summary);

        const metaForSave = {
          style: style ?? (userProfile as any)?.style ?? 'friendly',
          mode: 'light',
          achievementSummaryOnly: true,
          skipTraining: true,
          skipMemory: true,
          nextStep: null,
          next_step: null,
          timing: t,
        };

        await persistAssistantMessage({
          supabase,
          reqOrigin,
          authorizationHeader,
          conversationId,
          userCode,
          assistantText,
          metaForSave,
        });

        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        return {
          ok: true,
          result: { gate: 'achievement_summary', kind: period.kind },
          assistantText,
          metaForSave,
          finalMode: 'light',
        };
      } catch (e) {
        console.warn('[IROS][AchSummary] failed', e);
      }
    }

    /* ---------------------------
       1.3) Generic Recall Gate（会話の糊）
    ---------------------------- */
    try {
      const recall = await runGenericRecallGate({
        text,
        history: (historyForTurn as any[])
          .filter((m) => String(m?.role ?? '').toLowerCase() === 'user')
          .filter((m) => {
            const s = norm(m?.content ?? m?.text ?? (m as any)?.message ?? '');
            if (!s) return false;

            if (/^たぶんこれのことかな：/.test(s)) return false;
            if (/^たぶんこれのことかな：「/.test(s)) return false;

            return true;
          }),
      });

      if (recall) {
        const gateMetaForSave = {
          style: style ?? (userProfile as any)?.style ?? 'friendly',
          mode: 'recall',
          recall: {
            kind: recall.recallKind,
            recalledText: recall.recalledText,
          },
          skipTraining: true,
          skipMemory: true,
          timing: t,
        };

        const ts = nowNs();

        const t5 = nowNs();
        await persistAssistantMessage({
          supabase,
          reqOrigin,
          authorizationHeader,
          conversationId,
          userCode,
          assistantText: recall.assistantText,
          metaForSave: gateMetaForSave,
        });
        t.persist_ms.assistant_message_ms = msSince(t5);

        t.persist_ms.total_ms = msSince(ts);
        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        return {
          ok: true,
          result: { gate: 'generic_recall', ...recall },
          assistantText: recall.assistantText,
          metaForSave: gateMetaForSave,
          finalMode: 'recall',
        };
      }
    } catch (e) {
      console.warn('[IROS/Gate] genericRecallGate failed', e);
    }

/* ---------------------------
   2) Context
---------------------------- */

const tc = nowNs();
const ctx = await (buildTurnContext as any)({
  supabase,
  conversationId,
  userCode,
  text,
  mode,
  traceId,
  userProfile,
  requestedStyle: style ?? null,
  history: historyForTurn,

  // ✅ 追加：route から来た extra を context に渡す
  extra: extra ?? null,
});
t.context_ms = msSince(tc);

/* ---------------------------
   3) Orchestrator
---------------------------- */

// ✅ baseMetaForTurn に extra を必ずマージ（ここが “消えない” 本体）
const baseMetaMergedForTurn: any = {
  ...(ctx.baseMetaForTurn ?? {}),
  extra: {
    ...(((ctx.baseMetaForTurn as any)?.extra) ?? {}),
    ...(extra ?? {}),
  },
};

// デバッグ（必要なら）
console.log('[IROS/Reply] merged extra', {
  keys: Object.keys(baseMetaMergedForTurn.extra ?? {}),
  renderMode: baseMetaMergedForTurn.extra?.renderMode ?? null,
  forceIT: baseMetaMergedForTurn.extra?.forceIT ?? null,
});

const to = nowNs();
const orch = await (runOrchestratorTurn as any)({
  conversationId,
  userCode,
  text,
  isFirstTurn: ctx.isFirstTurn,
  requestedMode: ctx.requestedMode,
  requestedDepth: ctx.requestedDepth,
  requestedQCode: ctx.requestedQCode,

  // ✅ 差し替え：マージ済みを渡す
  baseMetaForTurn: baseMetaMergedForTurn,

  userProfile: userProfile ?? null,
  effectiveStyle: ctx.effectiveStyle,
  history: historyForTurn,

  // ✅ 追加：orch にも extra を渡す（受け側が拾えるように）
  extra: extra ?? null,
});
t.orchestrator_ms = msSince(to);

/* ---------------------------
   4) PostProcess
---------------------------- */

const tp = nowNs();
const out = await (postProcessReply as any)({
  supabase,
  userCode,
  conversationId,
  userText: text,
  effectiveStyle: ctx.effectiveStyle,
  requestedMode: ctx.requestedMode,
  orchResult: orch,
  history: historyForTurn,

  // ✅ 追加：postprocess にも extra を渡す
  extra: extra ?? null,
});
t.postprocess_ms = msSince(tp);

/* ---------------------------
   5) Timing / Sanitize / Rotation bridge
---------------------------- */

out.metaForSave = out.metaForSave ?? {};
out.metaForSave.timing = t;

    // ✅ persist に必ず残す（postProcess が extra を作り直しても守る）
// ✅ persist に必ず残す（postProcess が extra を作り直しても守る）
out.metaForSave.extra = out.metaForSave.extra ?? {};

// ✅ 1) route から来た extra を “最後に” 必ず再注入（single source）
if (extra && typeof extra === 'object') {
  out.metaForSave.extra = {
    ...(out.metaForSave.extra ?? {}),
    ...(extra ?? {}),
  };
}

// ✅ 2) renderMode はトップレベル1本化（ここが最終固定点）
const extraRenderMode =
  typeof out.metaForSave.extra?.renderMode === 'string'
    ? out.metaForSave.extra.renderMode
    : null;

if (!out.metaForSave.renderMode && extraRenderMode) {
  out.metaForSave.renderMode = extraRenderMode;
}

// ✅ 3) forceIT が true なら renderMode を必ず IT に落とす（補助情報→決定情報へ）
if (
  String(out.metaForSave.renderMode ?? '').trim() === '' &&
  out.metaForSave.extra?.forceIT === true
) {
  out.metaForSave.renderMode = 'IT';
}


    try {
      out.metaForSave = sanitizeIntentAnchorMeta(out.metaForSave);
    } catch (e) {
      console.warn('[IROS/Reply] sanitizeIntentAnchorMeta failed', e);
    }

    // rotation bridge（最低限・安定版）
    // ✅ descentGate を boolean/unknown で持ち込ませない。必ず union に落とす。
    // ✅ spinLoop / depth も rot 側優先で “取りこぼし” を防ぐ。
    const normalizeDescentGateBridge = (
      v: any,
    ): 'closed' | 'offered' | 'accepted' => {
      if (v == null) return 'closed';

      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'closed' || s === 'offered' || s === 'accepted') return s;
        return 'closed';
      }

      // 互換：boolean のとき（旧）
      if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

      return 'closed';
    };

    const normalizeSpinLoopBridge = (v: any): 'SRI' | 'TCF' | null => {
      if (typeof v !== 'string') return null;
      const s = v.trim().toUpperCase();
      if (s === 'SRI' || s === 'TCF') return s as any;
      return null;
    };

    const normalizeDepthBridge = (v: any): string | null => {
      if (typeof v !== 'string') return null;
      const s = v.trim();
      return s ? s : null;
    };

    try {
      const m: any = out.metaForSave ?? {};

      const rot =
        m.rotation ??
        m.rotationState ??
        m.spin ??
        (m.will && (m.will.rotation ?? m.will.spin)) ??
        null;

      // ✅ descentGate: rot優先 → meta fallback → 最後は closed
      m.descentGate = normalizeDescentGateBridge(
        rot?.descentGate ?? m.descentGate,
      );

      // ✅ spinLoop: rot優先で拾う（無ければmeta）
      m.spinLoop =
        normalizeSpinLoopBridge(rot?.spinLoop ?? rot?.loop) ??
        normalizeSpinLoopBridge(m.spinLoop) ??
        null;

      // ✅ depth: rotの nextDepth/depth を優先（無ければmeta）
      m.depth =
        normalizeDepthBridge(rot?.nextDepth ?? rot?.depth) ??
        normalizeDepthBridge(m.depth) ??
        null;

      // ✅ persist が読む “正規化済み” の rotationState を再構成
      m.rotationState = {
        spinLoop: m.spinLoop,
        descentGate: m.descentGate,
        depth: m.depth,
        reason: rot?.reason ?? undefined,
      };

      out.metaForSave = m;

      console.log('[IROS/Reply] rotation bridge', {
        spinLoop: m.spinLoop,
        descentGate: m.descentGate,
        depth: m.depth,
      });
    } catch (e) {
      console.warn('[IROS/Reply] rotation bridge failed', e);
    }

    /* ---------------------------
       6) Persist (order fixed)
    ---------------------------- */

    {
      const ts = nowNs();

      const t1 = nowNs();
      await persistQCodeSnapshotIfAny({
        userCode,
        conversationId,
        requestedMode: ctx.requestedMode,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.q_snapshot_ms = msSince(t1);

      const t2 = nowNs();
      await persistIntentAnchorIfAny({
        supabase,
        userCode,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.intent_anchor_ms = msSince(t2);

      const t3 = nowNs();
      await persistMemoryStateIfAny({
        supabase,
        userCode,
        userText: text,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.memory_state_ms = msSince(t3);

      const t4 = nowNs();
      await persistUnifiedAnalysisIfAny({
        supabase,
        userCode,
        tenantId,
        userText: text,
        assistantText: out.assistantText,
        metaForSave: out.metaForSave,
        conversationId,
      });
      t.persist_ms.unified_analysis_ms = msSince(t4);

      const t5 = nowNs();
      await persistAssistantMessage({
        supabase,
        reqOrigin,
        authorizationHeader,
        conversationId,
        userCode,
        assistantText: out.assistantText,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.assistant_message_ms = msSince(t5);

      t.persist_ms.total_ms = msSince(ts);
    }

    const finalMode =
      typeof (orch as any)?.mode === 'string'
        ? (orch as any).mode
        : (ctx as any).finalMode ?? mode;

    t.finished_at = nowIso();
    t.total_ms = msSince(t0);

    return {
      ok: true,
      result: orch,
      assistantText: out.assistantText,
      metaForSave: out.metaForSave,
      finalMode,
    };
  } catch (e) {
    console.error('[IROS/Reply] handleIrosReply failed', {
      conversationId,
      userCode,
      error: e,
    });

    t.finished_at = nowIso();
    t.total_ms = msSince(t0);

    return {
      ok: false,
      error: 'generation_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
