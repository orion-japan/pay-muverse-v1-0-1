// file: src/lib/iros/server/handleIrosReply.ts
// iros — handleIrosReply (V2 / single-writer friendly)
//
// ✅ 方針（ここを徹底）
// - /reply/route.ts が assistant 保存の single-writer（iros_messages insert）
// - handleIrosReply.ts は assistant を **絶対に保存しない**
// - ここは「判断・meta確定・補助テーブル更新（Q/anchor/state/unified）」だけ
// - persistAssistantMessage は import もしない / 呼ばない

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete'; // ✅ 追加
import type { IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import type { IrosUserProfileRow } from './loadUserProfile';

import { getIrosSupabaseAdmin } from './handleIrosReply.supabase';

import { runGreetingGate } from './handleIrosReply.gates';
import { buildTurnContext } from './handleIrosReply.context';
import { runOrchestratorTurn } from './handleIrosReply.orchestrator';
import { postProcessReply } from './handleIrosReply.postprocess';
import { extractSlotsForRephrase, rephraseSlotsFinal } from '@/lib/iros/language/rephraseEngine';

import { runGenericRecallGate } from '@/lib/iros/server/gates/genericRecallGate';
import { writeIT } from '@/lib/iros/language/itWriter';
import { resolveRememberBundle } from '@/lib/iros/remember/resolveRememberBundle';
import { logConvEvidence } from '@/lib/iros/conversation/evidenceLog';

import {
  // ✅ assistant保存はしない
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

// ✅ LLM Gate（Policy -> Execute）
// - ここでは “OpenAIを叩かない”
// - route.ts が叩く直前に FINAL を通すのが最終理想だが、
//   handleIrosReply 側では「metaに入口3通りを刻む」までをやる
import { probeLlmGate, writeLlmGateToMeta, logLlmGate } from './llmGate';

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

  /** ✅ route.ts から渡す拡張情報（NextStep / IT trigger / renderMode など） */
  extra?: Record<string, any>;
};

// ✅ 置き換え：HandleIrosReplySuccess（ブロック全体）
// file: src/lib/iros/server/handleIrosReply.ts

export type HandleIrosReplySuccess = {
  ok: true;

  // 既存
  result: any;
  assistantText: string;
  metaForSave: any;
  finalMode: 'auto' | 'light' | 'deep' | 'it' | string;

  // ✅ 追加（micro などで downstream が slots/meta を期待する経路に対応）
  // - 既存の呼び出し側を壊さないため optional にする
  slots?: any[];
  meta?: any;
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
const IROS_MODEL = process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

/**
 * ✅ Goal recall を完全に止めるフラグ
 * - '1' のときだけ有効
 * - それ以外は無効（デフォルトOFF）
 */
const enableGoalRecall = process.env.IROS_ENABLE_GOAL_RECALL === '1';

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
   Helpers: extra merge (never lose)
========================= */

function mergeExtra(metaForSave: any, extra?: Record<string, any> | null): any {
  const m0 = metaForSave ?? {};
  const prev = m0.extra && typeof m0.extra === 'object' ? m0.extra : {};
  const ex = extra && typeof extra === 'object' ? extra : {};

  const pid =
    (typeof (ex as any).personaId === 'string' && (ex as any).personaId.trim()) ||
    (typeof (ex as any).persona_id === 'string' && (ex as any).persona_id.trim()) ||
    (typeof (ex as any).persona === 'string' && (ex as any).persona.trim()) ||
    null;

  const hasRoot =
    (typeof (m0 as any).personaId === 'string' && (m0 as any).personaId.trim().length > 0) ||
    (typeof (m0 as any).persona_id === 'string' && (m0 as any).persona_id.trim().length > 0) ||
    (typeof (m0 as any).persona === 'string' && (m0 as any).persona.trim().length > 0);

  const rootPatch = pid && !hasRoot ? { personaId: pid } : {};

  return { ...m0, ...rootPatch, extra: { ...prev, ...ex } };
}


/**
 * ✅ single-writer stamp（必ず meta.extra に刻む）
 * - gates / handleIrosReply / postprocess から “保存しない” を宣言
 * - route.ts が最終保存者なので、下流が勝手に保存しないための統一フラグ
 */
function stampSingleWriter(metaForSave: any): any {
  const m0 = metaForSave ?? {};
  const prevExtra = m0.extra && typeof m0.extra === 'object' ? m0.extra : {};

  return {
    ...m0,
    extra: {
      ...prevExtra,
      persistAssistantMessage: false,
      persistPolicyHint: prevExtra.persistPolicyHint ?? 'REPLY_SINGLE_WRITER',
    },
  };
}

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
  ) {
    return true;
  }

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
  if (/(^\s*\/\/|^\s*\/\*|\bimport\b|\bexport\b|src\/|npm run|tsc -p)/.test(t))
    return true;

  // 4) 相談・質問・他者事例（進捗ではない）
  if (/(どう対応|どうしたら|どうすれば|どのように対応|アドバイス|教えてください)/.test(t))
    return true;

  // 他人主語が明確な相談
  if (/(その人は|あの人は|彼は|彼女は|上司が|部下が|親会社が|相手が)/.test(t))
    return true;

  return false;
}

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
      .select('role, text, content, meta, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[IROS/History] load failed', { conversationId, error });
      return [];
    }

    const rows = (data ?? []).slice().reverse();

    const pickTextFromRow = (m: any): string => {
      // 1) content が文字列なら最優先
      if (typeof m?.content === 'string' && m.content.trim().length > 0) return m.content.trim();

      // 2) text が文字列なら採用
      if (typeof m?.text === 'string' && m.text.trim().length > 0) return m.text.trim();

      // 3) content が object の場合：安全に “中の文字列候補” だけ拾う（stringifyは禁止）
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
      conversationId,
      limit,
      returned: history.length,
      metaSample: (history as any[]).find((x) => x?.meta)?.meta ? 'has_meta' : 'no_meta',
    });

    return history;
  } catch (e) {
    console.error('[IROS/History] unexpected', { conversationId, error: e });
    return [];
  }
}

/**
 * ✅ this turn の history を 1回だけ組み立てる（この関数の返り値を全段に渡す）
 * - 返す前に sanitize して [object Object] 混入を根絶する
 */
function sanitizeHistoryForTurn(history: unknown[], maxTotal: number): unknown[] {
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
// ✅ Phase1: 同一conversation の直近を “まず流す”
// - 旧設計では excludeConversationId を渡して同一conversationを除外していた
// - いまは「会話が成立すること」が最優先なので、まず除外しない
// - 汚染対策（crossConvUserOnly / silence / hidden / banned assistant）は HistoryX 側で維持される
const dbHistory = await loadRecentHistoryAcrossConversations({
  supabase: supabaseClient,
  userCode,

  limit: 120,

  // ❌ ここは Phase1 では渡さない（same を混ぜるのに除外すると矛盾する）
  // excludeConversationId: conversationId,

  includeSameConversation: true,
  sameConversationLimit: 8,

  crossConversationLimit: 60,
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

  // ✅ 最後に sanitize（ここが本修正）
  turnHistory = sanitizeHistoryForTurn(turnHistory, maxTotal);

  return turnHistory;
}

/* =========================
   Micro bypass / detect
========================= */

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

  return keywords.some((k) => s.includes(k));
}

/**
 * 相づち系（そうですね/はい/うん等）が、
 * 直前の assistant 発話（質問・続き要求）に対する返答なら micro を避ける。
 */
function shouldBypassMicroGateByHistory(args: {
  userText: string;
  history: any[] | null | undefined;
}): boolean {
  const s = (args.userText ?? '').trim();
  if (!s) return false;

  // ✅ 相づち（必要なら増やす）
  const ack = new Set([
    'そう',
    'そうだね',
    'そうですね',
    'うん',
    'うんうん',
    'はい',
    '了解',
    'なるほど',
    'たしかに',
    'よし',
    'ok',
    'おーけー',
  ]);

  const core = normalizeTailPunct(s)
    .replace(/[?？]/g, '')
    .trim()
    .toLowerCase();

  if (!ack.has(core)) return false;

  const h = Array.isArray(args.history) ? args.history : [];
  if (h.length <= 0) return false;

  const pickText = (v: any): string => {
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
      if (typeof v.message === 'string') return v.message;
    }
    return '';
  };

  // 直前の assistant 発話を拾う（content/text/message 全対応）
  let lastA: string | null = null;
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    const role = String(m?.role ?? '').toLowerCase();
    if (role === 'assistant') {
      const t = pickText(m?.content ?? m?.text ?? m?.message ?? null).trim();
      if (t) lastA = t;
      break;
    }
  }
  if (!lastA) return false;

  // ✅「続きが来る前提」なら bypass（質問/選択/続き要求）
  if (/[?？]$/.test(lastA)) return true;
  if (/(どれ|どこ|いつ|なに|何|どう|なぜ|どうして|教えて|選んで|どっち)/.test(lastA)) return true;
  if (/(話して|聞かせて|続けて|もう少し|そのまま|どこからでも)/.test(lastA)) return true;

  return false;
}

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

  // ✅ 単語（1トークン）micro は「単語っぽい」ものだけに限定する
  // - 無スペースでも「文」になっている入力（助詞/数字入り）は除外
  // - 長い無スペース文の誤爆を止めるため len 上限も必須
  const isSingleToken =
    rawTrim.length > 0 &&
    !/\s/.test(rawTrim) &&
    /^[\p{L}\p{N}ー・]+$/u.test(rawTrim); // 日本語/英数/長音/中点（句読点などは除外）

  const hasDigit = /[0-9０-９]/.test(rawTrim);

  // 「文」になりやすい助詞/接続（最小セット）
  const hasSentenceParticle = /[がをにへでとものは]|から|まで|より|ので|のに/.test(rawTrim);

  if (isSingleToken && len >= 2 && len <= 10 && !hasDigit && !hasSentenceParticle) {
    return true;
  }

  // 英数混じりは micro にしない（誤爆防止）
  if (/[A-Za-z0-9]/.test(core)) return false;

  // 疑問語は micro では扱わない（通常フローへ）
  if (/(何|なに|どこ|いつ|だれ|誰|なぜ|どうして|どうやって|いくら|何色|色)/.test(core)) {
    return false;
  }

  // 長すぎ/短すぎは micro では扱わない
  if (len < 2 || len > 10) return false;

  // 既存：短い「動詞系 micro」
  return /^(どうする|やる|やっちゃう|いく|いける|どうしよ|どうしよう|行く|行ける)$/.test(core);
}


/* =========================
   Goal recall helpers
========================= */

function isGoalRecallQ(text: string): boolean {
  const s = String(text ?? '').trim();
  return /^(?:今日の)?(?:目標|ゴール)\s*(?:覚えてる|覚えてる\?|覚えてる？|なんだっけ|なんだっけ\?|なんだっけ？|何だっけ|何だっけ\?|何だっけ？|って何|は何|教えて)/.test(
    s,
  );
}

const norm = (v: any): string => {
  if (v == null) return '';

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

/* =========================
  Helpers: meta fill (null禁止)
========================= */

type PhaseIO = 'Inner' | 'Outer';
type SpinLoop2 = 'SRI' | 'TCF';
type DescentGate2 = 'closed' | 'offered' | 'accepted';

function normalizePhaseIO(v: any): PhaseIO | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'inner') return 'Inner';
  if (s === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop2(v: any): SpinLoop2 | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI' || s === 'TCF') return s as SpinLoop2;
  return null;
}

function normalizeDescentGate2(v: any): DescentGate2 {
  if (v == null) return 'closed';
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as any;
    return 'closed';
  }
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';
  return 'closed';
}

function pickFirstString(...cands: any[]): string | null {
  for (const v of cands) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function ensureMetaFilled(args: { meta: any; ctx: any; orch: any }): any {
  const m = args.meta ?? {};
  const ctx = args.ctx ?? {};
  const orch = args.orch ?? {};

  // ==== Q（qPrimary / q_code を必ず埋める）====
  const qFromMeta = pickFirstString(m.qPrimary, m.q_code, m.qCode, m.currentQ);
  const qFromCtx = pickFirstString(
    ctx?.baseMetaForTurn?.qPrimary,
    ctx?.baseMetaForTurn?.q_code,
    ctx?.baseMetaForTurn?.qCode,
    ctx?.requestedQCode,
  );
  const qFinal = qFromMeta ?? qFromCtx ?? 'unknown';

  if (!m.qPrimary) m.qPrimary = qFinal;
  if (!m.q_code) m.q_code = qFinal;

  // ==== Phase（Inner/Outer を必ず埋める）====
  const phaseFromMeta = normalizePhaseIO(m.phase) ?? normalizePhaseIO(m.phaseIO);
  const phaseFromCtx =
    normalizePhaseIO(ctx?.baseMetaForTurn?.phase) ??
    normalizePhaseIO(ctx?.baseMetaForTurn?.phaseIO);

  const phaseFinal: PhaseIO = phaseFromMeta ?? phaseFromCtx ?? 'Inner';
  if (!m.phase) m.phase = phaseFinal;

  // ==== Depth（null禁止：文字列を必ず入れる）====
  const depthFromMeta = pickFirstString(m.depth, m.depthStage, m.depthstage);
  const depthFromCtx = pickFirstString(
    ctx?.baseMetaForTurn?.depth,
    ctx?.baseMetaForTurn?.depthStage,
    ctx?.requestedDepth,
  );
  const depthFromOrch = pickFirstString(
    orch?.meta?.depth,
    orch?.meta?.depthStage,
    orch?.result?.meta?.depth,
    orch?.result?.meta?.depthStage,
  );

  const depthFinal = depthFromMeta ?? depthFromCtx ?? depthFromOrch ?? 'unknown';
  if (!m.depth) m.depth = depthFinal;

  // ==== Rotation（spinLoop / descentGate / depth を必ず埋める）====
  const rot = m.rotationState ?? m.rotation ?? null;

  const spinLoopFinal: SpinLoop2 =
    normalizeSpinLoop2(rot?.spinLoop ?? rot?.loop) ??
    normalizeSpinLoop2(m.spinLoop) ??
    'SRI';

  const descentGateFinal: DescentGate2 = normalizeDescentGate2(
    rot?.descentGate ?? m.descentGate,
  );

  const rotDepthFinal = pickFirstString(rot?.depth, m.depth) ?? depthFinal;

  m.spinLoop = spinLoopFinal;
  m.descentGate = descentGateFinal;

  m.rotationState = {
    ...(typeof m.rotationState === 'object' ? m.rotationState : {}),
    spinLoop: spinLoopFinal,
    descentGate: descentGateFinal,
    depth: rotDepthFinal,
    filled: true,
  };

  // ==== Bridge: framePlan / inputKind を必ず残す（writerHints 用）====
  if (!(m as any).framePlan && (ctx?.baseMetaForTurn as any)?.framePlan) {
    (m as any).framePlan = (ctx.baseMetaForTurn as any).framePlan;
  }
  if (!(m as any).inputKind && (ctx?.baseMetaForTurn as any)?.inputKind) {
    (m as any).inputKind = (ctx.baseMetaForTurn as any).inputKind;
  }

  return m;
}

/* =========================================================
   Micro Writer: generator（短文だけ作る）
   - ✅ OpenAI直呼び禁止
   - ✅ chatComplete に統一
========================================================= */

const microGenerate: MicroWriterGenerate = async (args) => {
  try {
    const baseSystem = String(args.system ?? '').trim();
    const userPrompt = String(args.prompt ?? '').trim();

    // ✅ 追加：micro用 writer制約（短い・判断しない・応援テンプレにしない）
    // - “くどさ回避”を壊さないため、ここでは短く・禁止系だけを足す
    const microWriterConstraints = `
# Micro Writer Constraints（必須）
- 1〜2行で終える。長くしない。
- 判断・分析・助言・診断をしない（決めつけない）。
- 「大丈夫/素晴らしい/楽しみですね/ワクワク/きっと」などの応援テンプレを使わない。
- 「かもしれない/と思います/〜してみると」などのhedge・一般論を使わない。
- 質問は原則0（入れるなら最大1つまで、短く）。
- 相手の語尾や勢いを軽く受けて、“場を進める一言”だけ返す。
`.trim();

    // 1st try
    const messages1: ChatMessage[] = [
      { role: 'system', content: `${baseSystem}\n\n${microWriterConstraints}`.trim() },
      { role: 'user', content: userPrompt },
    ];

    const callLLM = async (messages: ChatMessage[], temperature: number) => {
      const out = await chatComplete({
        purpose: 'writer',
        model: IROS_MODEL,
        messages,
        temperature,
        max_tokens: typeof (args as any).maxTokens === 'number' ? (args as any).maxTokens : 420,
        traceId: (args as any).traceId ?? null,
        conversationId: (args as any).conversationId ?? null,
        userCode: (args as any).userCode ?? null,
      });
      return String(out ?? '').trim();
    };

    const judgeMicro = async (text: string) => {
      const t = String(text ?? '').trim();
      if (!t) return { ok: false as const, reason: 'EMPTY' };

      // ✅ 旗印ゲートを“後付け”で通す（回路は変えない）
      // micro は slotKeys を持たないので ctx=null だと strict qCount になり、
      // 「?なし疑問推定（の$ / かな / ですか 等）」で誤って QCOUNT_TOO_MANY に落ちる。
      // → micro の採点だけ normalChatLite 扱いの slotKeys を渡して qCount を「?数」に固定する。
      const { flagshipGuard } = await import('@/lib/iros/quality/flagshipGuard');
      const v = flagshipGuard(t, {
        slotKeys: ['SEED_TEXT', 'OBS', 'SHIFT'],
        slotsForGuard: null,
      });

      // microは短いので、WARNでも「応援/無難/hedge」理由が入るなら落とす
      const badWarnReasons = new Set([
        'CHEER_PRESENT',
        'CHEER_MANY',
        'GENERIC_PRESENT',
        'GENERIC_MANY',
        'HEDGE_PRESENT',
        'HEDGE_MANY',
        'SHORT_GENERIC_CHEER_WITH_QUESTION',
        'NO_FLAGSHIP_SIGN_WITH_BLAND_PRESSURE',
      ]);

      const hasBadWarn = (v.reasons ?? []).some((r: string) => badWarnReasons.has(r));

      if (!v.ok) return { ok: false as const, reason: `FATAL:${(v.reasons ?? []).join('|')}` };
      if (v.level === 'WARN' && hasBadWarn)
        return { ok: false as const, reason: `WARN_BAD:${(v.reasons ?? []).join('|')}` };

      return { ok: true as const, reason: v.level };
    };


    let out1 = await callLLM(messages1, typeof args.temperature === 'number' ? args.temperature : 0.6);
    let j1 = await judgeMicro(out1);
    if (j1.ok) return out1;

    // 2nd try（1回だけ）：さらに短く、質問0を強制
    const retryConstraints = `
# Retry Hard Constraints（再生成）
- 1行で返す（最大でも2行にしない）。
- 質問は0。
- 応援テンプレ/hedge/一般論は禁止（上と同じ）。
`.trim();

    const messages2: ChatMessage[] = [
      { role: 'system', content: `${baseSystem}\n\n${microWriterConstraints}\n\n${retryConstraints}`.trim() },
      { role: 'user', content: userPrompt },
    ];

    const out2 = await callLLM(messages2, 0.2);
    const j2 = await judgeMicro(out2);
    if (j2.ok) return out2;

    // ✅ まだダメなら「空文字」で返す：
    // - 回路は維持
    // - 上位（handleIrosReply側）の forward fallback / seed fallback に任せる
    return '';
  } catch (e) {
    console.warn('[IROS/MicroWriter][llm] failed', e);
    return '';
  }
};



/* =========================================================
   FORWARD fallback（テンプレ臭を消す：seed + userText で揺らす）
========================================================= */

function buildForwardFallbackText(seed: string, userText: string): string {
  const normalize = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();

  const clip = (s: string, max = 18) => {
    const t = normalize(s);
    if (!t) return '';
    return t.length > max ? t.slice(0, max) + '…' : t;
  };

  const hash32 = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return h >>> 0;
  };

  const u = clip(userText);
  const key = `${seed}|${u}`;

  const variants: Array<() => string> = [
    () =>
      u
        ? `一手：「${u}」を1行に縮めて、いちばん軽い着手を1つだけ決める。🪔`
        : `一手：一点だけ名指しして、いちばん軽い着手を1つだけ決める。🪔`,
    () =>
      u
        ? `一手：候補は増やさず、「${u}」の最小の一歩を1つだけ書く。🪔`
        : `一手：候補は増やさず、最小の一歩を1つだけ書く。🪔`,
    () =>
      u
        ? `一手：「誰に／いつ／何を」を1つにして、「${u}」を“行動”に落とす。🪔`
        : `一手：「誰に／いつ／何を」を1つにして、行動に落とす。🪔`,
    () =>
      u
        ? `一手：「${u}」の対象を1つに絞り、今日の着手を1つだけやる。🪔`
        : `一手：対象を1つに絞り、今日の着手を1つだけやる。🪔`,
  ];

  const idx = variants.length ? hash32(key) % variants.length : 0;
  return variants[idx]();
}

/**
 * ✅ slotPlanLen 推定（推測しない：手元にある meta からだけ）
 */
function inferSlotPlanLen(meta: any): number | null {
  try {
    const sp = meta?.slotPlan ?? null;

    if (Array.isArray(sp)) return sp.length;

    const slots =
      sp && typeof sp === 'object' && Array.isArray((sp as any).slots)
        ? (sp as any).slots
        : null;
    if (slots) return slots.length;

    if (sp && typeof sp === 'object') return Object.keys(sp).length;

    const fpSlots = meta?.framePlan?.slots;
    if (Array.isArray(fpSlots)) return fpSlots.length;

    return null;
  } catch {
    return null;
  }
}

// =========================================================
// ✅ llmGate を「必ず通す」共通関数（candidate対応版）
// - probeLlmGate へ “slotsを含む meta” を渡す（metaForCandidate 優先）
// - hasSlots / slotPlanPolicy も “濃いmeta” を見る
// - ✅ decision.resolvedText を返す（呼び出し側が本文採用できる）
// =========================================================
function runLlmGate(args: {
  tag: 'PROBE' | 'FINAL';
  conversationId: string;
  userCode: string;
  metaForSave: any;
  metaForCandidate: any;
  allowLLM_final: boolean;
  assistantTextNow: string;
}): {
  llmEntry: string | null;
  resolvedText: string | null;
  rewriteSeed: string | null;
} {
  const { tag, conversationId, userCode, metaForSave, metaForCandidate, allowLLM_final, assistantTextNow } = args;

  try {
    const allowLLM_final0 = typeof allowLLM_final === 'boolean' ? allowLLM_final : true;

    const metaForProbe = metaForCandidate ?? metaForSave ?? null;

    const hasSlots =
      Boolean(metaForProbe?.framePlan?.slots) ||
      Boolean(metaForProbe?.framePlan?.framePlan?.slots) ||
      Boolean(metaForProbe?.slotPlan?.slots) ||
      Boolean(metaForProbe?.slots);

    let slotPlanLen: number | null =
      metaForProbe?.framePlan?.slotPlanLen ??
      metaForProbe?.framePlan?.framePlan?.slotPlanLen ??
      metaForProbe?.slotPlan?.slotPlanLen ??
      metaForProbe?.slotPlanLen ??
      metaForSave?.slotPlanLen ??
      null;

    const slotPlanPolicy: any =
      metaForProbe?.framePlan?.slotPlanPolicy ??
      metaForProbe?.framePlan?.framePlan?.slotPlanPolicy ??
      metaForProbe?.slotPlan?.slotPlanPolicy ??
      metaForProbe?.slotPlanPolicy ??
      metaForSave?.slotPlanPolicy ??
      metaForSave?.framePlan?.slotPlanPolicy ??
      metaForSave?.extra?.slotPlanPolicy ??
      null;

    const exProbe: any = metaForProbe?.extra ?? null;
    const exSave: any = metaForSave?.extra ?? null;

    const seedFallbackRaw =
      exProbe?.slotPlanSeed ??
      exProbe?.llmRewriteSeed ??
      exSave?.slotPlanSeed ??
      exSave?.llmRewriteSeed ??
      null;

    const seedFallback =
      seedFallbackRaw != null && String(seedFallbackRaw).trim().length > 0
        ? String(seedFallbackRaw).trim()
        : '';

    const textNowRaw = String(assistantTextNow ?? '').trim();
    const textNow = textNowRaw.length > 0 ? textNowRaw : seedFallback;

    // slotPlanLen 推定（既存ロジックを保持）
    if (slotPlanLen == null) {
      const slotsObj =
        metaForProbe?.framePlan?.slots ??
        metaForProbe?.framePlan?.framePlan?.slots ??
        metaForProbe?.framePlan?.slotPlan?.slots ??
        metaForProbe?.slotPlan?.slots ??
        metaForProbe?.slots ??
        metaForProbe?.extra?.framePlan?.slots ??
        null;

      if (Array.isArray(slotsObj)) {
        if (slotsObj.length > 0) slotPlanLen = slotsObj.length;
      } else if (slotsObj && typeof slotsObj === 'object') {
        const n = Object.keys(slotsObj).length;
        if (n > 0) slotPlanLen = n;
      }
    }

    const probe = probeLlmGate({
      conversationId,
      userCode,
      allowLLM_final: allowLLM_final0,
      brakeReason: (metaForProbe as any)?.speechBrakeReason ?? null,
      speechAct: (metaForProbe as any)?.speechAct ?? null,
      finalAssistantTextNow: textNow,
      slotPlanLen,
      hasSlots,
      slotPlanPolicy,
      meta: metaForProbe,
    } as any);

    writeLlmGateToMeta(metaForSave, probe.patch);

    logLlmGate(tag, {
      conversationId,
      userCode,
      patch: probe.patch,
      decision: probe.decision,
    });

    const resolvedTextRaw = (probe.decision as any)?.resolvedText;
    const resolvedText =
      resolvedTextRaw != null && String(resolvedTextRaw).trim().length > 0
        ? String(resolvedTextRaw).trim()
        : null;

    // ✅ 追加：CALL_LLM の “本命” は rewriteSeed
    const rewriteSeedRaw = (probe.decision as any)?.rewriteSeed;
    const rewriteSeed =
      rewriteSeedRaw != null && String(rewriteSeedRaw).trim().length > 0
        ? String(rewriteSeedRaw).trim()
        : null;

    return {
      llmEntry: (probe.patch as any)?.llmEntry ?? null,
      resolvedText,
      rewriteSeed,
    };
  } catch (e) {
    console.warn('[IROS/LLM_GATE][FAILED]', { tag, conversationId, userCode, error: e });
    return { llmEntry: null, resolvedText: null, rewriteSeed: null };
  }
}


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
    extra,
  } = params;
// ✅ extra は const のままなので、ローカルで更新して回す（関数スコープで宣言）
let extraLocal: any = extra ?? null;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    style,
    history_len: Array.isArray(history) ? history.length : null,
    // single-writer 前提なので常に false に寄せる
    persistAssistantAllowed: false,
  });

  if (process.env.IROS_DEBUG_EXTRA === '1') {
    console.log('[IROS/Reply] extra keys', {
      conversationId,
      keys: Object.keys(extra ?? {}),
      extra: extraLocal ?? null,
    });
  }

  try {
    /* ---------------------------
       0) Gates
    ---------------------------- */

    const tg = nowNs();

// ✅ extra は const のままなので、ローカルで更新して回す
let extraLocal: any = extra ?? null;

const gatedGreeting = await runGreetingGate({
  supabase,
  conversationId,
  userCode,
  text,
  userProfile,
  reqOrigin,
  authorizationHeader,
});

if (gatedGreeting?.ok) {
  // ✅ gate の metaForSave は「rootメタ」なので、extra に注入するのは metaForSave.extra のみ
  const gateExtra =
    gatedGreeting?.metaForSave &&
    typeof gatedGreeting.metaForSave === 'object' &&
    (gatedGreeting.metaForSave as any).extra &&
    typeof (gatedGreeting.metaForSave as any).extra === 'object'
      ? (gatedGreeting.metaForSave as any).extra
      : null;

  if (gateExtra) {
    const prev = extraLocal && typeof extraLocal === 'object' ? extraLocal : {};
    extraLocal = { ...prev, ...gateExtra };
  }

  // 保険：後段のデバッグ用（無くてもOK）
  const prev2 = extraLocal && typeof extraLocal === 'object' ? extraLocal : {};
  extraLocal = {
    ...prev2,
    gatedGreeting: {
      ok: true,
      result: gatedGreeting.result ?? null,
    },
  };

  // ✅ ここで return しない。下へ続行させる。
}

    // ok=false / gate不成立はそのまま下へ

    const bypassMicro =
    shouldBypassMicroGate(text) ||
    shouldBypassMicroGateByHistory({ userText: text, history });


    // ✅ Micro（独立ルート）
    if (!bypassMicro && isMicroTurn(text)) {
      const name = userProfile?.user_call_name || 'あなた';
      const seed = `${conversationId}|${userCode}|${traceId ?? ''}|${Date.now()}`;

      const s0 = String(text ?? '').trim();
      const isSingleToken =
        s0.length > 0 &&
        !/\s/.test(s0) &&
        /^[\p{L}\p{N}ー・]+$/u.test(s0); // 日本語/英数/長音/中点（句読点などは除外）

      const microUserText = isSingleToken
        ? `${s0}

意味づけはしない。
次は2つだけ：
・連想を3語
・浮かんだ場面を1つ`
        : text;

      const mw = await runMicroWriter(microGenerate, {
        name,
        userText: microUserText,
        seed,
      });

      // ✅ micro 成功 → このブロック内で完結して return（t1/ts/metaForSave を漏らさない）
      if (mw.ok) {
        const historyForTurn = await buildHistoryForTurn({
          supabaseClient: supabase,
          conversationId,
          userCode,
          providedHistory: history ?? null,
          includeCrossConversation: false,
          baseLimit: 30,
        });

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
          extra: extraLocal ?? null,
        });
        t.context_ms = msSince(tc);

        let metaForSave: any = {
          ...(ctx?.baseMetaForTurn ?? {}),
          style:
            ctx?.effectiveStyle ??
            style ??
            (userProfile as any)?.style ??
            'friendly',

          mode: 'light',
          microOnly: true,

          // micro は独立。memory/training を触らない
          skipMemory: true,
          skipTraining: true,

          nextStep: null,
          next_step: null,
          timing: t,
        };

        metaForSave = stampSingleWriter(mergeExtra(metaForSave, extraLocal ?? null));

        // SUN固定保護（念のため）
        try {
          metaForSave = sanitizeIntentAnchorMeta(metaForSave);
        } catch {}

        // persist（最低限：assistant保存はしない）
        const ts = nowNs();

        const t1 = nowNs();
        await persistQCodeSnapshotIfAny({
          userCode,
          conversationId,
          requestedMode: ctx?.requestedMode ?? mode,
          metaForSave,
        });
        t.persist_ms.q_snapshot_ms = msSince(t1);

        t.persist_ms.total_ms = msSince(ts);
        t.gate_ms = msSince(tg);
        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        // ✅ micro成功でも slots を必ず返す（downstream が NO_SLOTS で落ちない）
        const slots = [
          {
            key: 'OBS',
            role: 'assistant',
            style: 'soft',
            content: String(text ?? '').trim() || '（短文）',
          },
          { key: 'TASK', role: 'assistant', style: 'soft', content: 'micro_reply_only' },
          {
            key: 'CONSTRAINTS',
            role: 'assistant',
            style: 'soft',
            content: 'micro:1-2lines;no_menu;no_analysis;emoji:🪔(<=1)',
          },
          { key: 'DRAFT', role: 'assistant', style: 'soft', content: mw.text },
        ];

        return {
          ok: true,
          result: { gate: 'micro_writer' },
          assistantText: mw.text,
          metaForSave,
          finalMode: 'light',
          slots,
          meta: metaForSave,
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
       1) History (single source)
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


// --- 1.0) Remember (period bundle) ---
let rememberTextForIros: string | null = null;

if (rememberScope) {
  try {
    const resolved = await resolveRememberBundle({
      supabase: supabase,
      userCode,
      tenantId,
      scopeKind: rememberScope,
      maxLogsForSummary: 80,
    });

    rememberTextForIros = resolved?.textForIros ?? null;

    console.log('[IROS/Remember] resolved', {
      userCode,
      rememberScope,
      hasText: Boolean(rememberTextForIros),
      bundleId: resolved?.bundle?.id ?? null,
    });
  } catch (e) {
    console.warn('[IROS/Remember] resolve failed', { userCode, rememberScope, error: e });
  }
}


    /* ---------------------------
       1.1) Goal recall gate（ENV=1 かつ 質問一致のときだけ）
    ---------------------------- */

    const goalRecallQ = isGoalRecallQ(text);

    if (enableGoalRecall && goalRecallQ) {
      let goalRaw: string | null = null;
      let goalSource: 'db' | 'history' | 'none' = 'none';

      try {
        const hit = await loadLatestGoalByUserCode(supabase, userCode, { limit: 250 });
        if (hit?.goalText) {
          goalRaw = hit.goalText;
          goalSource = 'db';
        }
      } catch (e) {
        console.warn('[goal_recall] loadLatestGoalByUserCode failed (fallback to history)', e);
      }

      if (!goalRaw) {
        goalRaw = extractGoalFromHistory(historyForTurn as any[]);
        if (goalRaw) goalSource = 'history';
      }
      if (!goalRaw) goalSource = 'none';

      const assistantText = goalRaw
        ? `今日の目標は「${String(goalRaw).trim()}」です。🪔`
        : `直近の履歴から「今日の目標」が見つかりませんでした。いまの目標を1行で置いてください。🪔`;

      let metaForSave: any = {
        style: style ?? (userProfile as any)?.style ?? 'friendly',
        mode: 'light',
        goalRecallOnly: true,
        skipTraining: true,
        skipMemory: true,
        nextStep: null,
        next_step: null,
        timing: t,
      };
      metaForSave = stampSingleWriter(mergeExtra(metaForSave, extra ?? null));

      t.finished_at = nowIso();
      t.total_ms = msSince(t0);

      return {
        ok: true,
        result: { gate: 'goal_recall', found: Boolean(goalRaw), source: goalSource },
        assistantText,
        metaForSave,
        finalMode: 'light',
      };
    }

    /* ---------------------------
       1.2) Achievement Summary Gate（明示トリガー時だけ）
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

        const userMsgs = (msgs ?? [])
          .filter((m: any) => String(m?.role ?? '').toLowerCase() === 'user')
          .filter((m: any) => !shouldDropFromAchievementSummary(String(m?.text ?? m?.content ?? '')));

        const summary = buildAchievementSummary(userMsgs as any, period);
        const assistantText = renderAchievementSummaryText(summary);

        let metaForSave: any = {
          style: style ?? (userProfile as any)?.style ?? 'friendly',
          mode: 'light',
          achievementSummaryOnly: true,
          skipTraining: true,
          skipMemory: true,
          nextStep: null,
          next_step: null,
          timing: t,
        };
        metaForSave = stampSingleWriter(mergeExtra(metaForSave, extra ?? null));

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
        let metaForSave: any = {
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
        metaForSave = stampSingleWriter(mergeExtra(metaForSave, extra ?? null));

        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        return {
          ok: true,
          result: { gate: 'generic_recall', ...recall },
          assistantText: recall.assistantText,
          metaForSave,
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
      extra: extraLocal ?? null,
    });
    t.context_ms = msSince(tc);

    /* ---------------------------
       3) Orchestrator
    ---------------------------- */

    // ✅ baseMeta は extra を絶対に落とさない（V2: route/ctx → orch へ橋渡し）
    const baseMetaMergedForTurn: any = mergeExtra({ ...(ctx.baseMetaForTurn ?? {}) }, extraLocal ?? null);

    // ✅ R -> I gate（入口で確定。途中上書き禁止）
    const prevDepthStage: string | null =
      typeof (ctx?.baseMetaForTurn as any)?.depthStage === 'string'
        ? String((ctx.baseMetaForTurn as any).depthStage)
        : typeof (ctx?.baseMetaForTurn as any)?.depth === 'string'
          ? String((ctx.baseMetaForTurn as any).depth)
          : typeof (baseMetaMergedForTurn as any)?.depthStage === 'string'
            ? String((baseMetaMergedForTurn as any).depthStage)
            : typeof (baseMetaMergedForTurn as any)?.depth === 'string'
              ? String((baseMetaMergedForTurn as any).depth)
              : null;

    let requestedDepthFinal: string | undefined =
      typeof ctx.requestedDepth === 'string' && ctx.requestedDepth.trim().length > 0
        ? ctx.requestedDepth.trim()
        : undefined;

    if (
      prevDepthStage?.startsWith('R') &&
      typeof requestedDepthFinal === 'string' &&
      requestedDepthFinal.startsWith('C')
    ) {
      requestedDepthFinal = 'I1';
    }

    console.log('[IROS][DepthGate] R->I check', {
      prevDepthStage,
      requestedDepth_in: ctx.requestedDepth ?? null,
      requestedDepth_out: requestedDepthFinal ?? null,
    });

    // ✅ Orchestrator（V2: 判断のみ。本文生成はしない）
    const to = nowNs();
    const orch = await (runOrchestratorTurn as any)({
      conversationId,
      userCode,
      text,
      isFirstTurn: !!ctx.isFirstTurn,

      requestedMode: ctx.requestedMode,
      requestedDepth: requestedDepthFinal,
      requestedQCode: ctx.requestedQCode,

      baseMetaForTurn: baseMetaMergedForTurn,
      userProfile: userProfile ?? null,
      effectiveStyle: ctx.effectiveStyle,

      history: historyForTurn,
      sb: supabase,
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
      extra: extraLocal ?? null,
    });
    t.postprocess_ms = msSince(tp);

    /* ---------------------------
       5) Timing / Extra / Sanitize / Rotation / IT apply
    ---------------------------- */

    out.metaForSave = out.metaForSave ?? {};
    out.metaForSave.timing = t;

    // ✅ extra を “最後に” 再注入（undefined / null は上書きしない）
    out.metaForSave.extra = out.metaForSave.extra ?? {};
    if (extra && typeof extra === 'object') {
      const prev = out.metaForSave.extra ?? {};
      const next: any = { ...prev };
      for (const [k, v] of Object.entries(extra as any)) {
        // ✅ null も「値なし」とみなし、postprocess側の確定値を潰さない
        if (v !== undefined && v !== null) next[k] = v;
      }
      out.metaForSave.extra = next;
    }


    // ✅ single-writer stamp（最後に確定）
    out.metaForSave = stampSingleWriter(out.metaForSave);

    if (process.env.IROS_DEBUG_EXTRA === '1') {
      console.log('[IROS/Reply][extra-merged]', out.metaForSave.extra);
    }

    // =========================================================
    // ✅ SpeechAct single-source stamp (ALWAYS write to metaForSave.extra)
    // =========================================================
    try {
      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.extra = out.metaForSave.extra ?? {};
      const ex: any = out.metaForSave.extra;

      const ctxAny: any = ctx as any;
      const orchAny: any = orch as any;

      const decision =
        ctxAny?.speechDecision ??
        ctxAny?.speechActDecision ??
        ctxAny?.speech ??
        orchAny?.speechDecision ??
        orchAny?.speechActDecision ??
        null;

      const applied =
        ctxAny?.speechApplied ??
        ctxAny?.speechActApplied ??
        orchAny?.speechApplied ??
        orchAny?.speechActApplied ??
        null;

      const pickAct = (v: any): string | null => {
        const a = v?.act ?? v?.actCandidate ?? v?.hardStop ?? null;
        return typeof a === 'string' && a.trim() ? a.trim() : null;
      };

      const pickReason = (v: any): string | null => {
        const r = v?.reason ?? v?.hardStopReason ?? v?.actReason ?? null;
        return typeof r === 'string' && r.trim() ? r.trim() : null;
      };

      const pickConfidence = (v: any): number | null => {
        const c = v?.confidence ?? v?.conf ?? null;
        return typeof c === 'number' && Number.isFinite(c) ? c : null;
      };

      if (ex.speechAct === undefined) ex.speechAct = pickAct(applied) ?? pickAct(decision) ?? null;
      if (ex.speechActReason === undefined) ex.speechActReason = pickReason(decision) ?? null;
      if (ex.speechActConfidence === undefined) ex.speechActConfidence = pickConfidence(decision);

      // ✅ allowLLM は “単一ソース” として必ず boolean
      // - default = true（通常会話は喋れる）
      const allowFromMeta =
        typeof (out.metaForSave as any)?.speechAllowLLM === 'boolean'
          ? (out.metaForSave as any).speechAllowLLM
          : undefined;

      const allowFromExtra =
        typeof ex.speechAllowLLM === 'boolean'
          ? ex.speechAllowLLM
          : undefined;

      const allowFromDecision =
        typeof decision?.allowLLM === 'boolean'
          ? decision.allowLLM
          : typeof decision?.allow === 'boolean'
            ? decision.allow
            : undefined;

      const allowFromApplied =
        typeof applied?.allowLLM === 'boolean'
          ? applied.allowLLM
          : typeof applied?.allow === 'boolean'
            ? applied.allow
            : undefined;

      const finalAllow =
        typeof allowFromMeta === 'boolean'
          ? allowFromMeta
          : typeof allowFromExtra === 'boolean'
            ? allowFromExtra
            : typeof allowFromDecision === 'boolean'
              ? allowFromDecision
              : typeof allowFromApplied === 'boolean'
                ? allowFromApplied
                : true;

      ex.speechAllowLLM = finalAllow;
      (out.metaForSave as any).speechAllowLLM = finalAllow;

      // rawTextFromModel が無ければ “現時点の本文” を入れておく（空は禁止）
      if (ex.rawTextFromModel === undefined || ex.rawTextFromModel === null) {
        const cur = String(out.assistantText ?? out.content ?? '').trim();
        ex.rawTextFromModel = cur.length ? cur : '…';
      }

      if (ex.extractedTextFromModel === undefined) ex.extractedTextFromModel = '';
    } catch (e) {
      console.warn('[IROS/Reply] SpeechAct stamp failed', e);
    }

// ✅ writer入力用の “このターン確定データ” を meta.extra に刻む（route.ts が拾う）
try {
  out.metaForSave = out.metaForSave ?? {};
  out.metaForSave.extra = out.metaForSave.extra ?? {};

  const exAny: any = out.metaForSave.extra;

  // history は巨大化し得るので “必要最小限” の形にして渡す
  // （role/content/meta のみ）
  exAny.historyForWriter = Array.isArray(historyForTurn)
    ? (historyForTurn as any[]).map((m) => ({
        role: m?.role,
        content: m?.content ?? m?.text ?? '',
        meta: m?.meta,
      }))
    : [];

  exAny.rememberTextForIros = typeof rememberTextForIros === 'string' ? rememberTextForIros : null;
  exAny.historyForWriterAt = new Date().toISOString();

  // =========================================================
  // ✅ FlowTape / FlowDigest（LLM-facing tiny continuity）
  // - “禁止/縛り” は入れない（ログとして素直に刻むだけ）
  // - metaForSave.extra に正本一本化（route.ts が拾える）
  // =========================================================
  try {
    // 依存を増やして import 衝突させないため、ここでは動的 import にする
    const { appendFlowTape } = await import('../flow/flowTape');
    const { buildFlowDigest } = await import('../flow/flowDigest');

    const prevTape = typeof exAny.flowTape === 'string' ? exAny.flowTape : null;

    // 1) META:coord
    const coord = {
      depthStage:
        (out.metaForSave as any)?.depthStage ??
        (out.metaForSave as any)?.depth_stage ??
        (out.metaForSave as any)?.unified?.depth?.stage ??
        null,
      phase:
        (out.metaForSave as any)?.phase ??
        (out.metaForSave as any)?.unified?.phase ??
        null,
      intentLayer:
        (out.metaForSave as any)?.intentLayer ??
        (out.metaForSave as any)?.intent_layer ??
        (out.metaForSave as any)?.unified?.layer ??
        null,
      itxStep:
        (out.metaForSave as any)?.itxStep ??
        (out.metaForSave as any)?.itx_step ??
        (out.metaForSave as any)?.unified?.itx?.step ??
        null,
      anchor:
        (out.metaForSave as any)?.intentAnchor ??
        (out.metaForSave as any)?.intent_anchor ??
        (out.metaForSave as any)?.unified?.intent_anchor ??
        null,
    };

    let tape = prevTape;

    // coord が全部 null でも META は刻まない（ノイズ削減）
    const hasAnyCoord =
      coord.depthStage != null || coord.phase != null || coord.intentLayer != null || coord.itxStep != null || coord.anchor != null;

    if (hasAnyCoord) {
      tape = appendFlowTape(tape, { t: 'META', k: 'coord', v: coord });
    }

    // 2) OBS:（会話の芯として “このターンのユーザー本文” を短く刻む）
    const userObs = String(text ?? '').trim();

    if (userObs) {
      tape = appendFlowTape(tape, { t: 'OBS', k: 'user', v: userObs });
    }

    // 正本保存
    exAny.flowTape = tape;

    // 3) digest（最大3行）
    exAny.flowDigest = buildFlowDigest(tape, { maxLines: 3 });

// 3.5) metaForSave.extra にも保存（下流: userContext / 保存 / 復元の正規ルート）
{
  const mf: any = (out as any)?.metaForSave;
  if (mf && typeof mf === 'object') {
    if (!mf.extra || typeof mf.extra !== 'object') mf.extra = {};
    (mf.extra as any).flowTape = tape ?? null;
    (mf.extra as any).flowDigest = exAny.flowDigest ?? null;
  }
}

// 4) ctxPack にも “読む側の入口” を作る（rephraseEngine 側が拾える）
//    NOTE: exAny は metaForSave.extra だが、ctxPack が未初期化のケースがあるため必ず用意する

// エラーハンドリングとログ出力を追加
console.log("[DEBUG] Before initializing ctxPack:", exAny.ctxPack);

if (!exAny.ctxPack || typeof exAny.ctxPack !== 'object') {
  console.warn("[WARNING] Initializing exAny.ctxPack as an empty object...");
  exAny.ctxPack = {};  // ctxPackの初期化処理
}

console.log("[DEBUG] After initializing ctxPack:", exAny.ctxPack);

// flow に関する処理
console.log("[DEBUG] Before assigning flow to ctxPack:", exAny.ctxPack.flow);

exAny.ctxPack.flow = (() => {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayKey = nowIso.slice(0, 10);

  // 既存 flow があれば “前回の at” を拾って鮮度判定する（無ければ null）
  const prevFlow = (exAny.ctxPack as any)?.flow ?? null;
  const prevAtIso = typeof prevFlow?.at === 'string' ? prevFlow.at : null;

  // prevAtIso の有無とその時刻をログに出力
  console.log("[DEBUG] prevFlow and prevAtIso:", prevFlow, prevAtIso);

  const prevAtMs = (() => {
    if (!prevAtIso) return null;
    const ms = Date.parse(prevAtIso);
    return Number.isFinite(ms) ? ms : null;
  })();

  // prevAtMs（前回のタイムスタンプ）をログに出力
  console.log("[DEBUG] prevAtMs (timestamp of previous flow):", prevAtMs);

  const ageSec = prevAtMs != null ? Math.max(0, Math.floor((now.getTime() - prevAtMs) / 1000)) : null;
  const sessionBreak = false;  // 仮設定

  console.log("[DEBUG] ageSec and sessionBreak:", ageSec, sessionBreak);

  return {
    at: nowIso,     // “このターンの刻み”
    prevAtIso,
    ageSec,
    sessionBreak,  // セッションブレイクの判定（仮設定）
    fresh: !sessionBreak, // fresh状態の確認
  };
})();
console.log("[DEBUG] After assigning flow to ctxPack:", exAny.ctxPack.flow);

  } catch (e) {
    // Flow は非必須：失敗しても会話を止めない
    console.warn('[IROS/FlowTape] stamp failed (non-fatal)', e);
  }
} catch (e) {
  console.warn('[IROS/Reply] failed to stamp history/remember for writer', e);
}



// =========================================================
// ✅ LLM Gate PROBE（ここは “刻む＋seed注入”）
// - resolvedText を本文に採用してよいのは「SKIP系」だけ（維持）
// - ✅ CALL_LLM のときは resolvedText を “LLM rewrite seed” として meta.extra に必ず渡す
// =========================================================
try {
  // ✅ out.text は見ない（ここで拾うと “本文がある扱い” になって LLM が負ける）
  const assistantTextNow = String(out?.assistantText ?? out?.content ?? '').trim();

  const allowLLM_final =
    typeof out?.metaForSave?.speechAllowLLM === 'boolean'
      ? out.metaForSave.speechAllowLLM
      : true;

  const metaForCandidate =
    (orch as any)?.result?.meta ??
    (orch as any)?.meta ??
    null;

  if ((out.metaForSave as any)?.slotPlanLen == null) {
    const n = inferSlotPlanLen(metaForCandidate ?? out.metaForSave);
    if (typeof n === 'number') (out.metaForSave as any).slotPlanLen = n;
  }

  const gate = runLlmGate({
    tag: 'PROBE',
    conversationId,
    userCode,
    metaForSave: out.metaForSave,
    metaForCandidate,
    allowLLM_final,
    assistantTextNow, // ✅ assistantText/content のみ
  });

  // ✅ resolvedText を本文に採用するのは SKIP 系のときだけ
  const isSkip =
    gate?.llmEntry === 'SKIP_POLICY' ||
    gate?.llmEntry === 'SKIP_SILENCE' ||
    gate?.llmEntry === 'SKIP_SLOTPLAN';

  // ---------------------------------------------------------
  // (1) resolvedText の採用ルール（憲法改正：rephraseEngineに依存しない）
  // - SKIP系：本文が空なら resolvedText を採用（現状維持）
  // - DIAGNOSIS_FINAL__SEED_FOR_LLM：CALL_LLM の resolvedText を本文に採用（現状維持）
  // - ✅ TREAT_AS_SCAFFOLD_SEED / SLOTPLAN_SEED_SCAFFOLD：
  //    resolvedText は「seed専用」。ここでは本文に採用しない（漏れ防止・設計どおり）
  // ---------------------------------------------------------
  const finalTextPolicyNow = String((out.metaForSave as any)?.extra?.finalTextPolicy ?? '')
    .trim()
    .toUpperCase();

  const isDiagnosisFinalSeed = finalTextPolicyNow === 'DIAGNOSIS_FINAL__SEED_FOR_LLM';

  // ✅ SCAFFOLD_SEED 系（FINAL_INTERNAL_ONLY->SCAFFOLD_SEED / SCAFFOLD seed運用）
  //    -> 本文には採用しない（seed専用）
  const isScaffoldSeedLike =
    finalTextPolicyNow.includes('TREAT_AS_SCAFFOLD_SEED') ||
    finalTextPolicyNow === 'SLOTPLAN_SEED_SCAFFOLD';

  if (gate?.resolvedText && String(gate.resolvedText).trim().length > 0) {
    const bodyIsEmpty = String(out?.assistantText ?? out?.content ?? '').trim().length === 0;

    // ✅ 1) DIAGNOSIS_FINAL__SEED_FOR_LLM は “LLM本文” を採用する（従来通り）
    if (isDiagnosisFinalSeed && gate.llmEntry === 'CALL_LLM') {
      out.content = gate.resolvedText;
      out.assistantText = gate.resolvedText;

      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.extra = out.metaForSave.extra ?? {};
      (out.metaForSave.extra as any).finalTextPolicy = 'DIAGNOSIS_FINAL__LLM_COMMIT';
      (out.metaForSave.extra as any).finalTextFrom = 'llmGate.resolvedText';
      (out.metaForSave.extra as any).finalTextLen = gate.resolvedText.length;

      console.warn('[IROS/Reply][patch] diagnosis FINAL seed -> LLM commit applied', {
        conversationId,
        userCode,
        len: gate.resolvedText.length,
        llmEntry: gate.llmEntry,
      });
    }

    // ✅ 2) SCAFFOLD_SEED 系は本文に採用しない（seed専用）
    // - postprocess が “本文空のまま” を明示しているので尊重する
    // - 本文を埋めると internal seed の漏れ経路になる
    if (isScaffoldSeedLike && gate.llmEntry === 'CALL_LLM' && bodyIsEmpty && !isDiagnosisFinalSeed) {
      console.log('[IROS/Reply][patch] scaffold seed: keep empty (seed-only)', {
        conversationId,
        userCode,
        llmEntry: gate.llmEntry,
        finalTextPolicyNow,
        resolvedLen: String(gate.resolvedText ?? '').length,
      });
    }

    // ✅ 3) SKIP系：本文が空のときだけ resolvedText を採用（従来通り）
    if (isSkip && bodyIsEmpty && !isDiagnosisFinalSeed && !isScaffoldSeedLike) {
      out.content = gate.resolvedText;
      out.assistantText = gate.resolvedText;

      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.fallbackApplied = 'LLM_GATE_RESOLVED_TEXT_APPLIED';
      (out.metaForSave as any).fallbackLen = gate.resolvedText.length;

      out.metaForSave.extra = out.metaForSave.extra ?? {};
      (out.metaForSave.extra as any).rawTextFromModel = gate.resolvedText;

      console.warn('[IROS/Reply][patch] llmGate resolvedText applied', {
        conversationId,
        userCode,
        len: gate.resolvedText.length,
        llmEntry: gate.llmEntry,
      });
    }
  }

// ---------------------------------------------------------
// (2) seed注入：CALL_LLM の rewriteSeed/resolvedText を meta.extra に注入（FINALでも）
// - 露出はしない（下流の writer/rephrase 用の材料）
// ---------------------------------------------------------
{
  out.metaForSave = out.metaForSave ?? {};
  out.metaForSave.extra = out.metaForSave.extra ?? {};
  const ex: any = out.metaForSave.extra;

  // ✅ seed の単一ソース：CALL_LLM は rewriteSeed、SKIP系などは resolvedText もあり得る
  const seedFromGate = String((gate as any)?.rewriteSeed ?? (gate as any)?.resolvedText ?? '').trim();

  // ✅ CALL_LLM で seed があるなら、FINAL/SCAFFOLD問わず “必ず” 運ぶ
  if (gate?.llmEntry === 'CALL_LLM' && seedFromGate.length > 0) {
    if (ex.llmRewriteSeed == null || String(ex.llmRewriteSeed).trim().length === 0) {
      ex.llmRewriteSeed = seedFromGate;
      ex.llmRewriteSeedFrom = 'llmGate(rewriteSeed)';
      ex.llmRewriteSeedAt = new Date().toISOString();
    }
  }
}


  // =========================================================
  // ✅ PDF 取締（最重要）
  // - SCAFFOLD は本文にしない（seed専用）
  // - FINAL では絶対に本文を空にしない（採用できるようにする）
  // =========================================================
  {
    out.metaForSave = out.metaForSave ?? {};
    out.metaForSave.extra = out.metaForSave.extra ?? {};
    const ex: any = out.metaForSave.extra;

    const policy = String((out.metaForSave?.framePlan as any)?.slotPlanPolicy ?? '')
      .trim()
      .toUpperCase();

    // ✅ “空強制” は policy=SCAFFOLD のときだけ許可する
    //    finalTextPolicy が SLOTPLAN_SEED_SCAFFOLD でも、policy=FINAL の場合は本文を保持する
    const isScaffoldPolicy = policy === 'SCAFFOLD';

    if (isScaffoldPolicy) {
      const seedRaw = String(ex?.slotPlanSeed ?? ex?.llmRewriteSeed ?? '').trim();

      // ✅ 下流で本文を作れる条件が揃ってる時だけ “空固定” を許可
      const rephraseEnabled =
        String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';

      // ✅ seed が「内部行(@〜)だけ」だと、render-v2 は何も出せないので空強制は禁止
      const seedRenderable = seedRaw
        .split('\n')
        .filter((l) => !String(l ?? '').trim().startsWith('@'))
        .join('\n')
        .trim();

      // ✅ rephraseBlocks があるなら render-v2 で出せる（空固定OK）
      const hasRephraseBlocks = Array.isArray((ex as any)?.rephraseBlocks) && (ex as any).rephraseBlocks.length > 0;

      const canRenderFromSeed =
        (hasRephraseBlocks || seedRenderable.length > 0) &&
        seedRaw.length > 0 &&
        allowLLM_final !== false &&
        rephraseEnabled;

      if (canRenderFromSeed) {
        // ① seed がある → SCAFFOLD時だけ本文を空に固定（seed→render-v2で出す）
        out.assistantText = '';
        (out as any).content = '';

        ex.pdfScaffoldNoCommit = true;
        ex.pdfScaffoldNoCommitAt = new Date().toISOString();
        ex.pdfScaffoldNoCommitPolicy = policy || null;

        console.log('[SCAFFOLD][ENFORCE] canRenderFromSeed=1 -> final text forced empty', {
          conversationId,
          userCode,
          policy,
          finalTextPolicy: ex?.finalTextPolicy ?? null,
          seedLen: seedRaw.length,
          seedHead: seedRaw.slice(0, 60),
          seedRenderableLen: seedRenderable.length,
          hasRephraseBlocks,
          allowLLM_final,
          rephraseEnabled,
        });
      } else {
        // ❌ 下流で出せない条件（= 無言になる） → 空にしない（無反応防止）
        ex.pdfScaffoldNoCommit = false;
        ex.pdfScaffoldNoCommitAt = new Date().toISOString();
        ex.pdfScaffoldNoCommitPolicy = policy || null;
        ex.pdfScaffoldNoCommitBlockedReason = {
          seedLen: seedRaw.length,
          seedRenderableLen: seedRenderable.length,
          hasRephraseBlocks,
          allowLLM_final,
          rephraseEnabled,
        };

        console.warn('[SCAFFOLD][ENFORCE] blocked -> keep existing assistantText (no empty force)', {
          conversationId,
          userCode,
          policy,
          finalTextPolicy: ex?.finalTextPolicy ?? null,
          seedLen: seedRaw.length,
          seedRenderableLen: seedRenderable.length,
          hasRephraseBlocks,
          allowLLM_final,
          rephraseEnabled,
        });
      }
    } else {

      // ✅ FINALなど：本文を保持（ここで空にしない）
      ex.pdfFinalAllowsCommit = true;
      ex.pdfFinalAllowsCommitAt = new Date().toISOString();
      ex.pdfFinalAllowsCommitPolicy = policy || null;

      // 観測用：FINALなのにSLOTPLAN_SEED_SCAFFOLDが立っているケースを可視化
      if (String(ex?.finalTextPolicy ?? '').trim().toUpperCase() === 'SLOTPLAN_SEED_SCAFFOLD') {
        ex.pdfFinalKeepsBodyEvenIfSeedScaffold = true;
        ex.pdfFinalKeepsBodyEvenIfSeedScaffoldAt = new Date().toISOString();
        console.warn('[SCAFFOLD][ENFORCE] FINAL policy -> keep body (ignore finalTextPolicy=SLOTPLAN_SEED_SCAFFOLD)', {
          conversationId,
          userCode,
          policy,
          finalTextPolicy: ex?.finalTextPolicy ?? null,
        });
      }
    }
  }

} catch (e) {
  console.warn('[IROS/LLM_GATE][PROBE] failed', e);
}


    // ✅ rotation bridge（最低限・安定版：null に落とさない）
    try {
      const normalizeDescentGateBridge = (v: any): 'closed' | 'offered' | 'accepted' | null => {
        if (v == null) return null;
        if (typeof v === 'string') {
          const s = v.trim().toLowerCase();
          if (s === 'closed' || s === 'offered' || s === 'accepted') return s;
          return null;
        }
        if (typeof v === 'boolean') return v ? 'accepted' : 'closed';
        return null;
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

      const m: any = out.metaForSave ?? {};
      const rot =
        m.rotation ??
        m.rotationState ??
        m.spin ??
        (m.will && (m.will.rotation ?? m.will.spin)) ??
        null;

      const descent = normalizeDescentGateBridge(rot?.descentGate ?? m.descentGate);
      const loop =
        normalizeSpinLoopBridge(rot?.spinLoop ?? rot?.loop) ??
        normalizeSpinLoopBridge(m.spinLoop);

      const depth =
        normalizeDepthBridge(rot?.nextDepth ?? rot?.depth) ??
        normalizeDepthBridge(m.depth);

      // ✅ 分かったものだけ上書き（分からない場合は現状維持）
      if (descent) m.descentGate = descent;
      if (loop) m.spinLoop = loop;
      if (depth) m.depth = depth;

      m.rotationState = {
        ...(typeof m.rotationState === 'object' ? m.rotationState : {}),
        spinLoop: m.spinLoop,
        descentGate: m.descentGate,
        depth: m.depth,
        reason: rot?.reason ?? (m.rotationState?.reason ?? undefined),
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

    // ✅ meta fill（IT writer 前に null 禁止を担保）
    out.metaForSave = ensureMetaFilled({ meta: out.metaForSave, ctx, orch });

// ========= handleIrosReply.ts 変更点 =========
//
// 1) import 追加（ファイル先頭の import 群に追加）
//
//   import { extractSlotsForRephrase, rephraseSlotsFinal } from '@/lib/iros/language/rephraseEngine';
//
// 2) 以下のブロックを、あなたが貼った箇所の
//    「out.metaForSave = ensureMetaFilled({ meta: out.metaForSave, ctx, orch });」直後
//    かつ 「// ✅ IT writer（COMMIT のときだけ）」の直前 に “挿入”
//
// ============================================

// ✅ FINAL writer bridge（SCAFFOLD/FINAL の “本文空” を LLM で可視化する）
// - slotTextCleanedLen=0 は正常（本文は空のまま）
// - ここで rephraseBlocks を生成して route.ts/render-v2 に渡す
{
  // ✅ ログ用は先に退避（catch で out/ctx がスコープ外でも死なない）
  const _conversationId =
    (typeof conversationId === 'string' ? conversationId : null) ?? (ctx as any)?.conversationId ?? null;
  const _userCode = (typeof userCode === 'string' ? userCode : null) ?? (ctx as any)?.userCode ?? null;

  // ✅ dots-only 判定（'…' / '……' / '...' 等は “空扱い”）
  const isDotsOnly = (s0: unknown) => {
    const s = String(s0 ?? '').trim();
    if (!s) return true;
    // 句点/三点リーダ/ピリオド/全角ピリオドだけ
    return /^[\.\uFF0E\u3002\u2026]+$/.test(s);
  };

  try {
    if (!out || typeof out !== 'object') {
      console.warn('[IROS/rephraseBridge][SKIP_OR_FAIL]', {
        conversationId: _conversationId,
        userCode: _userCode,
        policy: null,
        reason: 'out_is_not_object',
      });
    } else {
      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.extra = out.metaForSave.extra ?? {};
      const ex: any = out.metaForSave.extra;

      const policy = String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '').trim().toUpperCase();

      // ✅ “本文空” 判定（FINAL でも slotTextCleanedLen=0 を拾う）
      const slotTextCleanedLen = Number((ex as any)?.slotTextCleanedLen ?? NaN);
      const slotTextRawLen = Number((ex as any)?.slotTextRawLen ?? NaN);

      // 現時点の本文（最終的に '……' になっているケースがあるので、これだけに依存しない）
      const bodyNow = String(out.assistantText ?? (out as any)?.content ?? '').trim();

      const alreadyHasBlocks = Array.isArray(ex?.rephraseBlocks) && ex.rephraseBlocks.length > 0;

      // ✅ allowLLM_final のローカル確定（このブロック内で必ず定義する）
      const allowLLM_final_local: boolean = (() => {
        const v =
          (ctx as any)?.allowLLM_final ??
          (ctx as any)?.allowLLMFinal ??
          (out.metaForSave as any)?.allowLLM_final ??
          (out.metaForSave as any)?.allowLLMFinal ??
          (out.metaForSave as any)?.extra?.allowLLM_final ??
          null;

        if (typeof v === 'boolean') return v;
        return true; // デフォルトは許可（false のときだけ止める）
      })();

// ✅ “空扱い” 判定：
// - bodyNow が空
// - または slotTextRawLen > 0 だが cleanedLen = 0
//   （= 内部マーカーのみで、整形後に本文が消えた状態）
//
// ※ policy が FINAL / hasSlots の場合でも、
//    「本文として空」は異常なので emptyLike 扱いにする
const hasSlotsLocal =
  Array.isArray((out.metaForSave as any)?.slotPlan) &&
  (out.metaForSave as any).slotPlan.length > 0;




const internalMarkersOnly =
Number.isFinite(slotTextCleanedLen) &&
Number.isFinite(slotTextRawLen) &&
slotTextRawLen > 0 &&
slotTextCleanedLen === 0;

// ✅ dots-only（'…' / '……' / '...'）も “空扱い” に含める
// - これが無いと bodyNow='……' の瞬間に emptyLikeNow=false になり、writer/blocks が走らず “……” が残る
const emptyLikeNow =
  !bodyNow ||
  isDotsOnly(bodyNow) ||
  (
    // internalMarkersOnly をこの場で安全に再計算
    Number.isFinite(Number((out.metaForSave as any)?.extra?.slotTextCleanedLen)) &&
    Number.isFinite(Number((out.metaForSave as any)?.extra?.slotTextRawLen)) &&
    Number((out.metaForSave as any)?.extra?.slotTextRawLen) > 0 &&
    Number((out.metaForSave as any)?.extra?.slotTextCleanedLen) === 0
  );

      // ✅ 走らせる条件：
      // - SCAFFOLD または FINAL
      // - emptyLikeNow
      // - blocks が無い
      // - allowLLM_final が false なら触らない
      const shouldRunWriter =
        (
          String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '').toUpperCase() === 'SCAFFOLD' ||
          String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '').toUpperCase() === 'FINAL'
        ) &&
        emptyLikeNow &&
        !Array.isArray((out.metaForSave as any)?.extra?.rephraseBlocks) &&
        allowLLM_final_local !== false;

      // ✅ 追跡用（ENTER）
      if (emptyLikeNow) {
        console.log('[IROS/rephraseBridge][ENTER]', {
          conversationId: _conversationId,
          userCode: _userCode,
          policy: String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '').toUpperCase(),
          emptyLikeNow,
          allowLLM_final: allowLLM_final_local,
          alreadyHasBlocks: Array.isArray((out.metaForSave as any)?.extra?.rephraseBlocks),
          slotTextCleanedLen: Number((out.metaForSave as any)?.extra?.slotTextCleanedLen ?? null),
          slotTextRawLen: Number((out.metaForSave as any)?.extra?.slotTextRawLen ?? null),
          bodyNowLen: bodyNow.length,
          bodyNowHead: bodyNow.slice(0, 40),
          shouldRunWriter,
        });
      }

      if (shouldRunWriter) {
        const extracted = extractSlotsForRephrase({
          meta: out.metaForSave,
          framePlan: (out.metaForSave as any)?.framePlan ?? null,
          slotPlan: (out.metaForSave as any)?.slotPlan ?? null,
          assistantText: out.assistantText ?? null,
          content: (out as any)?.content ?? null,
          text: (out as any)?.text ?? null,
          extra: out.metaForSave.extra,
          orch: { framePlan: (out.metaForSave as any)?.framePlan ?? null },
        });

        const model = String(
          process.env.IROS_REPHRASE_FINAL_MODEL ??
          process.env.IROS_MODEL ??
          'gpt-4o'
        ).trim();

        const rr = await rephraseSlotsFinal(extracted, {
          model,
          temperature: 0.7,
          maxLinesHint: 8,
          userText: typeof text === 'string' ? text : null,
          userContext: (() => {
            const turns: Array<{ role: 'user' | 'assistant'; content: string }> = Array.isArray(
              (out.metaForSave as any)?.extra?.historyForWriter,
            )
              ? (out.metaForSave as any).extra.historyForWriter
                  .map((m: any) => ({
                    role: m?.role,
                    content: m?.content ?? m?.text ?? '',
                  }))
                  .filter(
                    (m: any) =>
                      (m?.role === 'user' || m?.role === 'assistant') &&
                      String(m?.content ?? '').trim().length > 0,
                  )
              : [];

            const historyText = turns.length
              ? turns
                  .slice(-12)
                  .map((m) => `${m.role === 'assistant' ? 'A' : 'U'}: ${String(m.content ?? '').trim()}`)
                  .join('\n')
              : '';

            return {
              conversationId: _conversationId ?? null,
              userCode: _userCode ?? null,
              inputKind: (ctx as any)?.inputKind ?? null,
              ctxPack: {
                ...(((out.metaForSave as any)?.extra?.ctxPack ?? null) as any),
                turns,
                chat: turns,
                history: turns,
              },
              flowDigest: (out.metaForSave as any)?.extra?.flowDigest ?? null,
              flowTape: (out.metaForSave as any)?.extra?.flowTape ?? null,
              turns,
              messages: turns,
              history: turns,
              historyMessages: turns,
              historyText,
              meta: {
                q: (out.metaForSave as any)?.q ?? null,
                depth: (out.metaForSave as any)?.depth ?? null,
                phase: (out.metaForSave as any)?.phase ?? null,
                layer: (out.metaForSave as any)?.intentLayer ?? null,
                renderMode: (out.metaForSave as any)?.renderMode ?? null,
                slotPlanPolicy: String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '').toUpperCase(),
              },
            };
          })(),
          inputKind: (ctx as any)?.inputKind ?? null,
          debug: {
            traceId: (ctx as any)?.traceId ?? null,
            conversationId: _conversationId ?? null,
            userCode: _userCode ?? null,
            renderEngine: true,
            inputKind: (ctx as any)?.inputKind ?? null,
          },
        });

        if (rr && rr.ok) {
          const mx = (rr as any)?.meta?.extra ?? {};
          const blocksCandidate =
            (rr as any)?.rephraseBlocks ??
            mx?.rephraseBlocks ??
            mx?.rephrase?.blocks ??
            null;

          if (Array.isArray(blocksCandidate) && blocksCandidate.length > 0) {
            (out.metaForSave as any).extra.rephraseBlocks = blocksCandidate;
          }

          (out.metaForSave as any).extra.rephraseApplied = true;
          (out.metaForSave as any).extra.rephraseLLMApplied = true;
          (out.metaForSave as any).extra.rephraseReason =
            (out.metaForSave as any).extra.rephraseReason ??
            'rephraseSlotsFinal(emptyLike)';
          (out.metaForSave as any).extra.rephraseAt = new Date().toISOString();
        }
      }
    }
  } catch (e) {
    const errText = String((e as any)?.message ?? e);

    try {
      if (out && typeof out === 'object') {
        (out as any).metaForSave = (out as any).metaForSave ?? {};
        (out as any).metaForSave.extra = (out as any).metaForSave.extra ?? {};
        const ex: any = (out as any).metaForSave.extra;

        ex.rephraseApplied = false;
        ex.rephraseLLMApplied = false;
        ex.rephraseReason = 'rephraseBridge:error';
        ex.rephraseError = errText;
      }
    } catch {}

    console.warn('[IROS/rephraseBridge][ERROR]', {
      conversationId: _conversationId,
      userCode: _userCode,
      err: errText,
    });
  }
}


    // ✅ IT writer（COMMIT のときだけ）
    try {
      const decidedAct =
        (ctx as any)?.speechDecision?.act ??
        (ctx as any)?.speechActDecision?.act ??
        (ctx as any)?.speechAct?.act ??
        (orch as any)?.speechDecision?.act ??
        (orch as any)?.speechActDecision?.act ??
        (out.metaForSave as any)?.speechAct ??
        (out.metaForSave as any)?.speechActDecision?.act ??
        null;

      const allowIT = decidedAct === 'COMMIT';

      if (out.metaForSave?.renderMode === 'IT' && !allowIT) {
        out.metaForSave.renderMode = 'NORMAL';
        out.metaForSave.extra = out.metaForSave.extra ?? {};
        out.metaForSave.extra.renderMode = 'NORMAL';

        (out.metaForSave as any).itActive = false;
        (out.metaForSave as any).tLayerModeActive = false;
        (out.metaForSave as any).tLayerHint = null;

        (out.metaForSave as any).itx_step = null;
        (out.metaForSave as any).itx_reason = null;
        (out.metaForSave as any).itx_anchor_event_type = null;
        (out.metaForSave as any).itx_last_at = null;

        console.log('[IROS/Reply] IT writer skipped (act not COMMIT)', {
          act: decidedAct,
          renderMode: 'IT->NORMAL',
        });
      }

      if (out.metaForSave?.renderMode === 'IT' && allowIT) {
        const it = writeIT(
          {
            userText: text,
            assistantText: out.assistantText,
            metaForSave: out.metaForSave,
            requestedMode: ctx.requestedMode,
            tenantId,
          } as any,
        );

        const itText =
          typeof (it as any)?.text === 'string'
            ? (it as any).text
            : typeof (it as any)?.assistantText === 'string'
              ? (it as any).assistantText
              : typeof (it as any)?.content === 'string'
                ? (it as any).content
                : null;

        if (itText) {
          out.assistantText = itText;
          (out as any).content = itText;
          console.log('[IROS/Reply] IT writer applied', {
            act: decidedAct,
            len: itText.length,
          });
        } else {
          console.warn('[IROS/Reply] IT writer returned no text-like field', {
            act: decidedAct,
            keys: it && typeof it === 'object' ? Object.keys(it as any) : null,
          });
        }
      }
    } catch (e) {
      console.warn('[IROS/Reply] IT writer failed (kept original text)', e);
    }

    // SUN固定保護（最後にも念押し）
    try {
      out.metaForSave = sanitizeIntentAnchorMeta(out.metaForSave);
    } catch {}

/* ---------------------------
   6) Persist (assistant保存はしない)
---------------------------- */

const ts = nowNs();

const metaForSave = out.metaForSave ?? (orch as any)?.meta ?? null;

const t1 = nowNs();
await persistQCodeSnapshotIfAny({
  userCode,
  conversationId,
  requestedMode: ctx.requestedMode,
  metaForSave,
});
t.persist_ms.q_snapshot_ms = msSince(t1);

const t2 = nowNs();
await persistIntentAnchorIfAny({
  supabase,
  userCode,
  metaForSave,
});
t.persist_ms.intent_anchor_ms = msSince(t2);

// =========================================================
// ✅ itTriggered は「boolean のときだけ渡す」
// - 不明(undefined/null)を false に丸めない
// - これで q_counts.it_triggered / it_triggered_true を壊さない
// =========================================================
const itTriggeredForPersist: boolean | undefined =
  typeof (out as any)?.metaForSave?.itTriggered === 'boolean'
    ? (out as any).metaForSave.itTriggered
    : typeof (metaForSave as any)?.itTriggered === 'boolean'
      ? (metaForSave as any).itTriggered
      : typeof (orch as any)?.meta?.itTriggered === 'boolean'
        ? (orch as any).meta.itTriggered
        : undefined;

// ✅ 任意：q_counts も “あるときだけ” 渡す（persist側で最終mergeされる）
const qCountsForPersist: unknown | undefined =
  (metaForSave as any)?.q_counts ??
  (out as any)?.metaForSave?.q_counts ??
  (orch as any)?.meta?.q_counts ??
  undefined;

// =========================================================
// ✅ anchorEntry decision を metaForSave から拾って persist に渡す
// - このスコープには `meta` / `anchorDecision` は無いので使わない
// - metaForSave に載っている anchorEntry / anchorEntry_decision を優先
// =========================================================
const metaAny = metaForSave as any;

const anchorEntryFromMeta =
  metaAny?.anchorEntry ??
  metaAny?.extra?.anchorEntry ??
  null;

const anchorEntryDecisionForPersist =
  anchorEntryFromMeta?.decision ??
  metaAny?.anchorEntry_decision ??
  metaAny?.anchorDecision ??
  undefined;

const t3 = nowNs();
await persistMemoryStateIfAny({
  supabase,
  userCode,
  userText: text,
  metaForSave,
  qCounts: qCountsForPersist,
  itTriggered: itTriggeredForPersist, // ✅ ここが本命

  // ✅ 型エラー回避：persist 側で受ける前提の拡張キー
  anchorEntry_decision: anchorEntryDecisionForPersist,
} as any); // ← ★ここだけ
t.persist_ms.memory_state_ms = msSince(t3);

const t4 = nowNs();
await persistUnifiedAnalysisIfAny({
  supabase,
  userCode,
  tenantId,
  userText: text,
  assistantText: out.assistantText,
  metaForSave,
  conversationId,
});
t.persist_ms.unified_analysis_ms = msSince(t4);

t.persist_ms.total_ms = msSince(ts);


const finalMode =
  typeof (orch as any)?.mode === 'string'
    ? (orch as any).mode
    : (ctx as any).finalMode ?? mode;

t.finished_at = nowIso();
t.total_ms = msSince(t0);

    // ✅ 最後に single-writer stamp を確定（念押し）
    out.metaForSave = stampSingleWriter(out.metaForSave);

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
