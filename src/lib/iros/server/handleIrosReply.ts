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
import {
  loadConversationHistory,
  sanitizeHistoryForTurn,
  buildHistoryForTurn,
} from './handleIrosReply.history';
import {
  isMicroTurn,
  shouldBypassMicroGate,
  shouldBypassMicroGateByHistory,
} from './handleIrosReply.micro';
import { isGoalRecallQ, extractGoalFromHistory } from './handleIrosReply.goalRecall';


import { runGenericRecallGate } from '@/lib/iros/server/gates/genericRecallGate';
import { writeIT } from '@/lib/iros/language/itWriter';
import { resolveRememberBundle } from '@/lib/iros/remember/resolveRememberBundle';
import { logConvEvidence } from '@/lib/iros/conversation/evidenceLog';
import { buildHistoryDigestV1 } from '@/lib/iros/history/historyDigestV1';
import { summarizeTopicLineV1 } from '@/lib/iros/memory/topicSummarizer';
import {
  loadDurableMemoriesForTurnV1,
  buildLongTermMemoryNoteTextV1,
} from '@/lib/iros/memory/longTermMemory.recall';
import { updateMemoryPriorityV1 } from '@/lib/iros/memory/longTermMemory.priority';
import { decayUnusedMemoriesV1 } from '@/lib/iros/memory/longTermMemory.decay';
import { selectLongTermMemoriesV1 } from '@/lib/iros/memory/longTermMemory.selector';
import { loadIrosMemoryState } from '@/lib/iros/memoryState';

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
  canonicalizeIrosMeta,
  applyCanonicalToMetaForSave,
} from './handleIrosReply.meta';

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
const IROS_MODEL = process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5';

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

  // ==== Phase（Inner/Outer：不明なら埋めない）====
  const phaseFromMeta = normalizePhaseIO(m.phase) ?? normalizePhaseIO(m.phaseIO);
  const phaseFromCtx =
    normalizePhaseIO(ctx?.baseMetaForTurn?.phase) ??
    normalizePhaseIO(ctx?.baseMetaForTurn?.phaseIO);

  // ❗️デフォルト Inner は禁止（不明なら null のまま）
  const phaseFinal: PhaseIO | null = phaseFromMeta ?? phaseFromCtx ?? null;

  // phase が取れた時だけ埋める（不明を捏造しない）
  if (!m.phase && phaseFinal) m.phase = phaseFinal;

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
    let messages1: ChatMessage[] = [
      { role: 'system', content: `${baseSystem}\n\n${microWriterConstraints}`.trim() },
      { role: 'user', content: userPrompt },
    ];

    // ✅ HistoryDigest v1（外から渡された場合のみ注入）
    // - micro はここで digest を生成しない（生成元は本線側に固定）
    // - 注入は systemPrompt の直後（systemの2本目）に入る
    const digestMaybe = (args as any).historyDigestV1 ?? null;
    let digestChars: number | null = null;
    let hasDigest = false;
    let hasAnchor = false;

    if (digestMaybe) {
      const { injectHistoryDigestV1 } = await import('@/lib/iros/history/historyDigestV1');
      const inj = injectHistoryDigestV1({ messages: messages1 as any, digest: digestMaybe });
      messages1 = inj.messages as any;
      digestChars = inj.digestChars;
      hasDigest = true;
      hasAnchor = !!digestMaybe?.anchor?.key;
    }

    const callLLM = async (messages: ChatMessage[], temperature: number) => {
      // ✅ microでも “注入されたか” をログで監査できるようにする
      const traceId0 = (args as any).traceId ?? null;
      const conversationId0 = (args as any).conversationId ?? null;
      const userCode0 = (args as any).userCode ?? null;

      // ✅ C対応：allowLLM が false なら micro は絶対に LLM を呼ばない
      // - 上流が out.metaForSave.speechAllowLLM を確定して渡す想定
      // - 無ければ allowLLM / speechAllowLLM を互換で見る（推測せず「存在する boolean」だけ採用）
      const allowLLM_micro =
        typeof (args as any).allowLLM_final === 'boolean'
          ? (args as any).allowLLM_final
          : typeof (args as any).allowLLM === 'boolean'
            ? (args as any).allowLLM
            : typeof (args as any).speechAllowLLM === 'boolean'
              ? (args as any).speechAllowLLM
              : true;

      if (!allowLLM_micro) {
        console.log('[IROS/LLM][CALL_MICRO][SKIP_POLICY]', {
          writer: 'micro',
          traceId: traceId0,
          conversationId: conversationId0,
          userCode: userCode0,
          reason: 'allowLLM_micro=false',
          hasDigest,
          hasAnchor,
          digestChars,
          msgCount: messages.length,
        });
        return '';
      }

      console.log('[IROS/LLM][CALL_MICRO]', {
        writer: 'micro',
        traceId: traceId0,
        conversationId: conversationId0,
        userCode: userCode0,

        hasDigest,
        hasAnchor,
        digestChars,
        msgCount: messages.length,
      });

      const out = await chatComplete({
        purpose: 'writer',
        model: IROS_MODEL,
        messages,
        temperature,
        max_tokens: typeof (args as any).maxTokens === 'number' ? (args as any).maxTokens : 420,
        traceId: traceId0,
        conversationId: conversationId0,
        userCode: userCode0,
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

    const metaCandidate = metaForCandidate ?? null;
    const metaSaved = metaForSave ?? null;

    const candEx: any = metaCandidate?.extra ?? null;
    const saveEx: any = metaSaved?.extra ?? null;

    // ✅ seed の強弱を分離
    // 強い seed: llmRewriteSeed / slotPlanSeed
    // 弱い seed: seed_text / ctxPack.seed_text

    const candidateStrongSeed =
      Boolean(candEx?.llmRewriteSeed && String(candEx.llmRewriteSeed).trim()) ||
      Boolean(candEx?.slotPlanSeed && String(candEx.slotPlanSeed).trim());

    const savedStrongSeed =
      Boolean(saveEx?.llmRewriteSeed && String(saveEx.llmRewriteSeed).trim()) ||
      Boolean(saveEx?.slotPlanSeed && String(saveEx.slotPlanSeed).trim());

    const candidateWeakSeed =
      Boolean((metaCandidate as any)?.seed_text && String((metaCandidate as any).seed_text).trim()) ||
      Boolean(candEx?.ctxPack?.seed_text && String(candEx.ctxPack.seed_text).trim());

    const savedWeakSeed =
      Boolean((metaSaved as any)?.seed_text && String((metaSaved as any).seed_text).trim()) ||
      Boolean(saveEx?.ctxPack?.seed_text && String(saveEx.ctxPack.seed_text).trim());

    const candidateHasSeed = candidateStrongSeed || candidateWeakSeed;
    const savedHasSeed = savedStrongSeed || savedWeakSeed;

    const metaForProbe =
      savedStrongSeed && !candidateStrongSeed
        ? metaSaved
        : candidateStrongSeed && !savedStrongSeed
          ? metaCandidate
          : savedStrongSeed && candidateStrongSeed
            ? (metaSaved ?? metaCandidate ?? null)
            : savedHasSeed && !candidateHasSeed
              ? metaSaved
              : (metaCandidate ?? metaSaved ?? null);

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

    // ✅ fallback: 実体から推定（slotPlan / framePlan.slots の長さ）
    if (!Number.isFinite(slotPlanLen as any) || (slotPlanLen as any) <= 0) {
      slotPlanLen =
        inferSlotPlanLen(metaForProbe) ??
        inferSlotPlanLen(metaForSave) ??
        null;
    }

    // ✅ さらに強い正本: framePlan.slots が配列ならそれを優先
    try {
      const fpSlots = metaForProbe?.framePlan?.slots;
      if (Array.isArray(fpSlots) && fpSlots.length > 0) slotPlanLen = fpSlots.length;
    } catch {}

    const slotPlanPolicy: any =
      metaForProbe?.framePlan?.slotPlanPolicy ??
      metaForProbe?.framePlan?.framePlan?.slotPlanPolicy ??
      metaForProbe?.slotPlan?.slotPlanPolicy ??
      metaForProbe?.slotPlanPolicy ??
      metaForSave?.slotPlanPolicy ??
      metaForSave?.framePlan?.slotPlanPolicy ??
      metaForSave?.extra?.slotPlanPolicy ??
      null;

// ✅ runLlmGate() の中（metaForProbe / slotPlanPolicy を決めた直後あたり）に追加
// --- BLOCK_PLAN を meta.extra に stamp（LLM_GATE / inject が同一turnで見れるようにする）---
try {
  // lazy import（server側で依存増を避ける）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildBlockPlanWithDiag } = require('@/lib/iros/blockPlan/blockPlanEngine');

  const stampOne = (metaAny: any, from: string) => {
    if (!metaAny || typeof metaAny !== 'object') return;

    // extra を必ず object 化
    const ex: any =
      metaAny.extra && typeof metaAny.extra === 'object'
        ? metaAny.extra
        : (metaAny.extra = {});

    // ctxPack を拾う（あるなら正本寄り）
    const cp: any = ex.ctxPack && typeof ex.ctxPack === 'object' ? ex.ctxPack : null;

    // 既に why があるなら “追跡 stamp だけ” 付ける（内容は維持）
    if (ex.blockPlan && typeof ex.blockPlan === 'object' && typeof ex.blockPlan.why === 'string') {
      ex.blockPlan = {
        ...ex.blockPlan,
        stampedBy: from,
        stampedAt: new Date().toISOString(),
      };
      return;
    }

    const replyGoalRaw = cp?.replyGoal ?? ex?.replyGoal ?? metaAny.replyGoal ?? null;
    const replyGoalKind = typeof replyGoalRaw === 'string' ? replyGoalRaw.trim() : String(replyGoalRaw?.kind ?? '').trim();
    const goalKind = String(cp?.goalKind ?? metaAny.goalKind ?? (replyGoalKind === 'permit_density' ? 'forward' : '')).trim() || null;

    const depthStage =
      typeof (cp?.depthStage ?? metaAny.depthStage) === 'string'
        ? String(cp?.depthStage ?? metaAny.depthStage)
        : null;

    const itTriggered = Boolean(cp?.itTriggered ?? metaAny.itTriggered ?? false);

    // EXPLICIT を本当に判定したい場合は “上流で計算した explicitTrigger” をここへ運ぶ必要がある。
    // まずは運搬の可観測性を優先して、存在していれば拾う（無ければ false 扱い）
    const explicitTrigger = ex?.blockPlan?.explicitTrigger === true;

    const exprLane = cp?.exprMeta?.lane ?? ex?.exprMeta?.lane ?? null;

    // userText はここでは渡せない（生文禁止の方針に従う）
    const { plan, diag } = buildBlockPlanWithDiag({
      userText: '',
      goalKind,
      exprLane,
      explicitTrigger,
      depthStage,
      itTriggered,
    });

    ex.blockPlan = {
      // gate/inject が最小で見る項目
      enabled: Boolean(plan),
      mode: plan?.mode ?? null,
      blocksLen: Array.isArray(plan?.blocks) ? plan.blocks.length : 0,
      explicitTrigger,

      // ✅ 最優先：why（確証）
      why: diag?.why ?? 'NONE',
      explicit: Boolean(diag?.explicit ?? false),
      wantsDeeper: Boolean(diag?.wantsDeeper ?? false),
      autoDeepen: Boolean(diag?.autoDeepen ?? false),
      autoCrack: Boolean(diag?.autoCrack ?? false),

      // 状態の根
      goalKind,
      depthStage,
      itTriggered,

      // 追跡
      stampedBy: from,
      stampedAt: new Date().toISOString(),
    };
  };

  // metaForProbe がどれを指しても “その実体” に stamp しておく
  stampOne(metaForProbe, 'handleIrosReply.runLlmGate.metaForProbe');
  stampOne(metaForSave, 'handleIrosReply.runLlmGate.metaForSave');
  stampOne(metaForCandidate, 'handleIrosReply.runLlmGate.metaForCandidate');

  // ✅ 観測性（必要なら有効化）
  // console.log('[IROS/BLOCK_PLAN][stamp]', { conversationId, userCode });
} catch (e) {
  // stamp失敗で処理は止めない（可観測性の補助なので）
  try {
    console.warn('[IROS/BLOCK_PLAN][stamp][FAILED]', {
      conversationId,
      userCode,
      error: String((e as any)?.stack ?? (e as any)?.message ?? e),
    });
  } catch {}
}

const exProbe: any = metaForProbe?.extra ?? null;
const exSave: any = metaForSave?.extra ?? null;

// --- DIAG: LLM_GATE に渡す meta.extra の実態を確定 ---
try {
  const keysProbe = exProbe && typeof exProbe === 'object' ? Object.keys(exProbe) : [];
  const keysSave = exSave && typeof exSave === 'object' ? Object.keys(exSave) : [];

  const pick = (v: any) => (typeof v === 'string' ? v.trim() : v);

  const diag = {
    conversationId,
    userCode,
    slotPlanPolicy_pre: String(
      metaForProbe?.framePlan?.slotPlanPolicy ??
        metaForSave?.framePlan?.slotPlanPolicy ??
        metaForProbe?.slotPlanPolicy ??
        metaForSave?.slotPlanPolicy ??
        '',
    ),
    exProbe_keys: keysProbe,
    exSave_keys: keysSave,

    // seed候補が “あるはず” のキー達
    probe_slotPlanSeedLen: typeof exProbe?.slotPlanSeed === 'string' ? exProbe.slotPlanSeed.trim().length : null,
    probe_llmRewriteSeedLen: typeof exProbe?.llmRewriteSeed === 'string' ? exProbe.llmRewriteSeed.trim().length : null,
    probe_seed_textLen: typeof exProbe?.seed_text === 'string' ? exProbe.seed_text.trim().length : null,
    probe_ctx_seed_textLen:
      typeof exProbe?.ctxPack?.seed_text === 'string' ? exProbe.ctxPack.seed_text.trim().length : null,

    save_slotPlanSeedLen: typeof exSave?.slotPlanSeed === 'string' ? exSave.slotPlanSeed.trim().length : null,
    save_llmRewriteSeedLen: typeof exSave?.llmRewriteSeed === 'string' ? exSave.llmRewriteSeed.trim().length : null,
    save_seed_textLen: typeof exSave?.seed_text === 'string' ? exSave.seed_text.trim().length : null,
    save_ctx_seed_textLen:
      typeof exSave?.ctxPack?.seed_text === 'string' ? exSave.ctxPack.seed_text.trim().length : null,

    // headだけ（漏れ防止のため短く）
    save_llmRewriteSeedHead: String(pick(exSave?.llmRewriteSeed ?? '')).slice(0, 64),
    save_slotPlanSeedHead: String(pick(exSave?.slotPlanSeed ?? '')).slice(0, 64),
    save_seed_textHead: String(pick(exSave?.seed_text ?? '')).slice(0, 64),
    save_ctx_seed_textHead: String(pick(exSave?.ctxPack?.seed_text ?? '')).slice(0, 64),
  };

  console.log('[IROS/LLM_GATE][INPUT_META_EXTRA_DIAG]', diag);
} catch (e) {
  console.warn('[IROS/LLM_GATE][INPUT_META_EXTRA_DIAG][FAILED]', { error: e });
}

// 置換範囲: 764〜769（seedFallbackRaw の定義ブロック）
const seedFallbackRaw =
  // 既存の seed 系（優先）
  exProbe?.slotPlanSeed ??
  exProbe?.llmRewriteSeed ??
  exSave?.slotPlanSeed ??
  exSave?.llmRewriteSeed ??

  // ✅ 追加：seed_text（ctxPack / PP が持ってる “seed only”）
  (metaForProbe as any)?.seed_text ??
  (metaForSave as any)?.seed_text ??

  // ✅ 追加：ctxPack 内に入ってる場合も拾う（PPで stamp 済みの正本）
  (exSave as any)?.ctxPack?.seed_text ??
  (exProbe as any)?.ctxPack?.seed_text ??

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

// ✅ CALL_LLM の “本命” は rewriteSeed
// - probe.decision.rewriteSeed が空でも、seedFallback があればそれを採用して運ぶ
const llmEntryNow = (probe.patch as any)?.llmEntry ?? null;

const rewriteSeedRaw = (probe.decision as any)?.rewriteSeed;
const rewriteSeedFromDecision =
  rewriteSeedRaw != null && String(rewriteSeedRaw).trim().length > 0
    ? String(rewriteSeedRaw).trim()
    : null;

const rewriteSeed =
  rewriteSeedFromDecision ??
  (llmEntryNow === 'CALL_LLM' && seedFallback.length > 0 ? seedFallback : null);

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

// src/lib/iros/server/handleIrosReply.ts
// 置換範囲: 1088〜1100（console.log('[IROS/Reply] handleIrosReply start', ...) のブロック）

console.log('[IROS/Reply] handleIrosReply start', {
  conversationId,
  userCode,
  mode,
  tenantId,
  rememberScope,
  traceId,
  style,
  history_len: Array.isArray(history) ? history.length : null,

  // single-writer 方針メモ：assistant 保存は route.ts 側でのみ行う
  persist_policy: 'route_only',
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

/* =========================================
 * [置換 1] src/lib/iros/server/handleIrosReply.ts
 * 範囲: 1318〜1360 を丸ごと置き換え
 * 目的:
 * - extraLocal 二重宣言（シャドーイング）を除去
 * - GreetingGate の metaForSave.extra を extraLocal に注入
 * - Micro を独立ルートとして先行処理（ただし bypass 可）
 * ========================================= */
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

if (gatedGreeting?.ok) {
  // ✅ gate の metaForSave は root メタ。ここでは extraLocal には metaForSave.extra のみ注入する
  const gateMetaRoot =
    gatedGreeting?.metaForSave && typeof gatedGreeting.metaForSave === 'object'
      ? (gatedGreeting.metaForSave as any)
      : null;

  const gateExtra =
    gateMetaRoot &&
    gateMetaRoot.extra &&
    typeof gateMetaRoot.extra === 'object'
      ? gateMetaRoot.extra
      : null;

  if (gateExtra) {
    const prev = extraLocal && typeof extraLocal === 'object' ? extraLocal : {};
    extraLocal = { ...prev, ...gateExtra };
  }

  // 保険：後段デバッグ用（無くてもOK）
  {
    const prev2 = extraLocal && typeof extraLocal === 'object' ? extraLocal : {};
    extraLocal = {
      ...prev2,
      gatedGreeting: {
        ok: true,
        result: gatedGreeting.result ?? null,
      },
    };
  }

  // ✅ identity gate はここで確定返却する
  // - 後段の rephrase / LLM に流すと「私は iros です。」へ縮退するため
  if (gateMetaRoot?.gate === 'identity') {
    let metaForSaveImmediate: any = {
      ...(gateMetaRoot ?? {}),
    };

    if (extraLocal && typeof extraLocal === 'object') {
      const prevExtra =
        metaForSaveImmediate?.extra && typeof metaForSaveImmediate.extra === 'object'
          ? metaForSaveImmediate.extra
          : {};
      metaForSaveImmediate.extra = {
        ...prevExtra,
        ...extraLocal,
      };
    }

    metaForSaveImmediate = stampSingleWriter(metaForSaveImmediate);

    return {
      ok: true,
      result: gatedGreeting.result ?? '',
      assistantText: String(gatedGreeting.result ?? '').trim(),
      metaForSave: metaForSaveImmediate,
      finalMode: 'auto',
      slots: Array.isArray(metaForSaveImmediate?.slotPlan?.slots)
        ? metaForSaveImmediate.slotPlan.slots
        : [],
      meta: metaForSaveImmediate,
    };
  }

  // greeting は従来どおり下へ続行
}
// ok=false / gate不成立はそのまま下へ

const isMicroNow = isMicroTurn(text);

// micro bypass は helper に一本化（履歴相づち / 想起系）
const bypassMicroRaw =
  shouldBypassMicroGate(String(text ?? '')) ||
  shouldBypassMicroGateByHistory({
    userText: String(text ?? ''),
    history: Array.isArray(history) ? (history as any[]) : null,
  });

// ✅ microOnlyの契約：相づち短文（はい/よし等）で bypass しない
// - ここで bypass すると通常ルートに落ちて rephrase/LLM が走り、重くなる & 質問が付く
const s0 = String(text ?? '').trim();
const isAckLike =
  s0.length > 0 &&
  s0.length <= 4 && // 「はい」「よし」「OK」などを想定
  /^(はい|うん|うむ|よし|了解|りょ|OK|ok|O K|👍|👌|🙆|🙆‍♂️|🙆‍♀️)$/u.test(s0);

const bypassMicro = isMicroNow && isAckLike ? false : bypassMicroRaw;

// ✅ Micro（独立ルート）
// ✅ Micro（独立ルート）
if (!bypassMicro && isMicroNow) {
  // ====== まず “そのターンの座標” を作る（Digest生成のため） ======
  // - micro が先に走る構造なので、ここで history/context を先に確保する
  const historyForTurn = await buildHistoryForTurn({
    supabaseClient: supabase,
    conversationId,
    userCode,
    providedHistory: history ?? null,
    includeCrossConversation: false,
    baseLimit: 30,
  });

  // ✅ microでも「前回snap」を履歴から拾って extra に注入する
  // - Orchestrator/PostProcess を通らないため、ここでやらないと prevSnap が “無い扱い” になる
  const prevSnapFromHistory = (() => {
    try {
      const hs = Array.isArray(historyForTurn) ? (historyForTurn as any[]) : [];
      for (let i = hs.length - 1; i >= 0; i--) {
        const h = hs[i];
        const meta = h?.meta && typeof h.meta === 'object' ? h.meta : null;
        const extra = meta?.extra && typeof meta.extra === 'object' ? meta.extra : null;
        if (!extra) continue;

        // 候補キーを広めに拾う（どれか1つでも入っていれば採用）
        // 候補キーを広めに拾う（どれか1つでも入っていれば採用）
        // ✅ buildHistoryForTurn 側の検知ロジック（ctxPack 経由）と揃える
        const snap =
          (extra as any)?.ctxPack?.viewShiftSnapshot ??
          (meta as any)?.ctxPack?.viewShiftSnapshot ??
          (extra as any).viewShiftSnapshot ??
          (extra as any).viewShiftSnap ??
          (extra as any).snap ??
          (meta as any).viewShiftSnapshot ??
          (meta as any)?.viewShift?.snapshot ??
          (extra as any)?.viewShift?.snapshot ??
          null;

        if (snap) {
          return {
            snap,
            from: {
              id: h?.id ?? null,
              role: h?.role ?? null,
              created_at: h?.created_at ?? null,
              idx: i,
            },
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  })();

  if (prevSnapFromHistory) {
    const prev = extraLocal && typeof extraLocal === 'object' ? extraLocal : {};

    // 互換: 旧 viewShift があれば引き継ぐ（任意）
    const vsLegacy =
      (prev as any).viewShift && typeof (prev as any).viewShift === 'object'
        ? (prev as any).viewShift
        : {};

    // ✅ 正本: viewShiftPrev（prevSnap の注入専用）
    const vsPrev = {
      prevSnap: prevSnapFromHistory.snap,
      prevSnapFrom: prevSnapFromHistory.from,
    };

    extraLocal = {
      ...prev,

      // ✅ 正本（今後はこちらを見る）
      viewShiftPrev: vsPrev,

      // ✅ 互換（既存の参照が残ってても壊さない）
      viewShift: {
        ...vsLegacy,
        ...vsPrev,
      },
    };

    console.log('[IROS/VIEWSHIFT][micro][inject-prevSnap]', {
      hasPrev: true,
      from: prevSnapFromHistory.from,
    });
  } else {
    console.log('[IROS/VIEWSHIFT][micro][inject-prevSnap]', {
      hasPrev: false,
    });
  }

  const tc0 = nowNs();
  const ctx0 = await (buildTurnContext as any)({
    supabase,
    conversationId,
    userCode,
    text,
    mode,
    traceId,
    userProfile,
    requestedStyle: style ?? null,
    history: historyForTurn,
    extra: extraLocal ?? null, // ✅ prevSnap を載せた extraLocal を渡す
  });
  t.context_ms = msSince(tc0);

  // ====== micro 入力整形（既存ロジック維持） ======
  const name = userProfile?.user_call_name || 'あなた';
  const seed = `${conversationId}|${userCode}|${traceId ?? ''}|${Date.now()}`;

  const s0 = String(text ?? '').trim();
  const isSingleToken =
    s0.length > 0 &&
    !/\s/.test(s0) &&
    /^[\p{L}\p{N}ー・]+$/u.test(s0); // 日本語/英数/長音/中点（句読点などは除外）

  // ✅ 新憲法：MicroWriter に「内部指示（演習・メニュー）」を混ぜない
  const microUserText = isSingleToken ? s0 : text;

// ====== HistoryDigest v1 を生成して micro に渡す ======
// buildHistoryDigestV1 はファイル先頭の static import を使う（重複importしない）

// repeatSignal はここでは最小扱い（ctx0 側で持っているならそれを優先）
const repeatSignal =
  !!(ctx0 as any)?.repeatSignalSame || !!(ctx0 as any)?.repeat_signal || false;

// continuity は “必ず” 取る：ctx0 が空なら historyForTurn から拾う
const pickLastCoreFromHistory = (
  history: any[] | null | undefined,
  role: 'user' | 'assistant',
) => {
  const hs = Array.isArray(history) ? history : [];
  for (let i = hs.length - 1; i >= 0; i--) {
    const h = hs[i] as any;
    const r = String(h?.role ?? h?.speaker ?? '').toLowerCase();
    if (r !== role) continue;

    const raw = String(h?.content ?? h?.text ?? h?.message ?? '').trim();
    if (raw) return raw;
  }
  return '';
};

const lastUserCore =
  String(
    (ctx0 as any)?.continuity?.last_user_core ??
      (ctx0 as any)?.lastUserCore ??
      pickLastCoreFromHistory(historyForTurn as any, 'user') ??
      '',
  ).trim() || '';

const lastAssistantCore =
  String(
    (ctx0 as any)?.continuity?.last_assistant_core ??
      (ctx0 as any)?.lastAssistantCore ??
      pickLastCoreFromHistory(historyForTurn as any, 'assistant') ??
      '',
  ).trim() || '';

// ✅ micro は “micro入力専用” ：chat では絶対に走らせない
const inputKindNow = String(
  (ctx0 as any)?.framePlan?.inputKind ??
    (ctx0 as any)?.baseMetaForTurn?.inputKind ??
    (ctx0 as any)?.inputKind ??
    '',
).trim();

const forceMicro =
  !!(ctx0 as any)?.baseMetaForTurn?.extra?.forceMicro ||
  !!(ctx0 as any)?.baseMetaForTurn?.forceMicro ||
  false;

const wantsMicroNow = inputKindNow === 'micro' || forceMicro;

// chat 等なら micro を完全スキップ（この後の micro 呼び出しを止める）
if (!wantsMicroNow) {
  console.log('[IROS/Gate] skip micro gate (not micro inputKind)', {
    conversationId,
    userCode,
    inputKindNow,
    forceMicro,
  });
} else {
  const digestV1 = buildHistoryDigestV1({
    fixedNorth: { key: 'SUN', phrase: '成長 / 進化 / 希望 / 歓喜' },
    metaAnchorKey:
      String((ctx0 as any)?.baseMetaForTurn?.intent_anchor_key ?? '').trim() ||
      null,
    memoryAnchorKey:
      String(
        (ctx0 as any)?.memoryState?.intentAnchor ??
          (ctx0 as any)?.intentAnchor ??
          '',
      ).trim() || null,

    qPrimary: (ctx0 as any)?.memoryState?.qPrimary ?? (ctx0 as any)?.qPrimary ?? 'Q3',
    depthStage:
      (ctx0 as any)?.memoryState?.depthStage ?? (ctx0 as any)?.depthStage ?? 'F1',
    phase: (ctx0 as any)?.memoryState?.phase ?? (ctx0 as any)?.phase ?? 'Inner',

    situationTopic: String((ctx0 as any)?.situationTopic ?? 'その他・ライフ全般'),
    situationSummary: String((ctx0 as any)?.situationSummary ?? '').slice(0, 120),

    lastUserCore: lastUserCore.slice(0, 120),
    lastAssistantCore: lastAssistantCore.slice(0, 120),
    repeatSignal,
  });

  const mw = await runMicroWriter(
    microGenerate,
    {
      name,
      userText: microUserText,
      seed,
      traceId,
      conversationId,
      userCode,

      // ✅ 上流で確定した allowLLM をそのまま渡す（推測しない）
      allowLLM_final:
        typeof (ctx0 as any)?.baseMetaForTurn?.speechAllowLLM === 'boolean'
          ? (ctx0 as any).baseMetaForTurn.speechAllowLLM
          : null,

      // ✅ microGenerate 側で注入する
      historyDigestV1: digestV1,
    } as any,
  );

  // ✅ ここで必ず同一スコープに確保（以降どこでも参照OK）
  const mwReason = (mw as any)?.reason ?? null;
  const mwDetail = (mw as any)?.detail ?? null;

  // ✅ micro 成功 → このブロック内で完結して return（t / metaForSave を漏らさない）
  if (mw.ok) {
    const ctx = ctx0;

    const tc = nowNs(); // 計測だけ維持（差し替え最小化）
    t.context_ms += msSince(tc);

    // ✅ meta は「座標は固定」しつつ、persist が重くならないよう extra を最小化する
    let metaForSaveMicro: any = {
      ...(ctx?.baseMetaForTurn ?? {}),
      style: ctx?.effectiveStyle ?? style ?? (userProfile as any)?.style ?? 'friendly',
      mode: 'light',
      microOnly: true,

      // micro は独立。memory / training を触らない（静止）
      skipMemory: true,
      skipTraining: true,

      nextStep: null,
      next_step: null,
      timing: t,
    };

    // ✅ micro 成功でも single-writer の印を必ず付ける（通常/ fallback と同じ土俵に揃える）
    metaForSaveMicro = stampSingleWriter(mergeExtra(metaForSaveMicro, extraLocal ?? null));

    // ✅ microOnly: renderGW / persist を重くする “長文元” を必ず掃除
    {
      const ex =
        metaForSaveMicro?.extra && typeof metaForSaveMicro.extra === 'object'
          ? metaForSaveMicro.extra
          : (metaForSaveMicro.extra = {});

      // renderGateway が拾う“長文の元”を消す
      delete (ex as any).rephraseBlocks;
      delete (ex as any).rephrase_blocks;
      delete (ex as any).blockPlan;
      delete (ex as any).block_plan;
      delete (ex as any).slots;
      delete (ex as any).slotPlanPolicy;
      delete (ex as any).slot_plan_policy;

      // ctxPack 系（特に重い）
      // ❗️delete ではなく「必要最小限」に剪定する
      if ((ex as any).ctxPack && typeof (ex as any).ctxPack === 'object') {
        const cp: any = (ex as any).ctxPack;
        const keep: any = {};

        // --- 必須（LLM 入力/検証に必要）---
        if (cp.flow) keep.flow = cp.flow;
        if (cp.resonanceState) keep.resonanceState = cp.resonanceState;
        if (typeof cp.seed_text === 'string' && cp.seed_text.trim()) {
          keep.seed_text = cp.seed_text.trim();
        }

        // --- writer / rephrase の入口として残す ---
        if (cp.historyForWriter) keep.historyForWriter = cp.historyForWriter;
        if (cp.historyDigestV1) keep.historyDigestV1 = cp.historyDigestV1;

        // --- 構造メタ（軽いので残す）---
        if (cp.phase) keep.phase = cp.phase;
        if (cp.depthStage) keep.depthStage = cp.depthStage;
        if (cp.qCode) keep.qCode = cp.qCode;
        if (cp.slotPlanPolicy) keep.slotPlanPolicy = cp.slotPlanPolicy;
        if (cp.goalKind) keep.goalKind = cp.goalKind;
        if (cp.exprMeta) keep.exprMeta = cp.exprMeta;
        if (cp.traceId) keep.traceId = cp.traceId;

        (ex as any).ctxPack = keep;
      } else {
        delete (ex as any).ctxPack;
      }

      delete (ex as any).historyForWriter;
      delete (ex as any).historyDigestV1;
      delete (ex as any).turns;
      delete (ex as any).flow;
      delete (ex as any).viewShift;
      delete (ex as any).viewShiftPrev;
      delete (ex as any).viewShiftSnapshot;
      delete (ex as any).topicDigest;
      delete (ex as any).flowDigest;

      // これが “正” だと明示（診断用）— 最後に勝たせる
      (ex as any).finalAssistantText = mw.text;
      (ex as any).finalTextPolicy = 'MICRO';
      (ex as any).finalTextPolicyPickedFrom = 'micro';
    }

    // SUN 固定保護（念のため）
    try {
      metaForSaveMicro = sanitizeIntentAnchorMeta(metaForSaveMicro);
    } catch {}

    // ✅ micro 成功でも slots を必ず返す
    const microSlots = [
      {
        key: 'OBS',
        role: 'assistant',
        style: 'soft',
        content: mw.text,
      },
    ];

    return {
      ok: true as const,
      result: { gate: 'micro_writer' as const },
      assistantText: mw.text,
      metaForSave: metaForSaveMicro,
      finalMode: 'light' as const,
      slots: microSlots,
      meta: metaForSaveMicro,
    };
  }

  // ✅ micro 失敗でも「このターンは micro で完結」させる（Hard Return fallback）
  const fallbackText = buildForwardFallbackText(
    String((ctx0 as any)?.seedText ?? ''),
    String(microUserText ?? ''),
  );

  console.warn('[IROS/MicroWriter] failed -> hard return fallback', {
    reason: mwReason,
    detail: mwDetail,
  });

  let metaForSaveMicroFallback: any = {
    ...(ctx0?.baseMetaForTurn ?? {}),
    style: ctx0?.effectiveStyle ?? style ?? (userProfile as any)?.style ?? 'friendly',
    mode: 'light',
    microOnly: true,
    microFallback: true,

    // micro は独立。memory / training を触らない（静止）
    skipMemory: true,
    skipTraining: true,

    nextStep: null,
    next_step: null,
    timing: t,
  };

  metaForSaveMicroFallback = stampSingleWriter(
    mergeExtra(metaForSaveMicroFallback, extraLocal ?? null),
  );

  // ✅ micro fallback も persist が重くならないよう extra を最小化する
  {
    const ex =
      metaForSaveMicroFallback?.extra &&
      typeof metaForSaveMicroFallback.extra === 'object'
        ? metaForSaveMicroFallback.extra
        : (metaForSaveMicroFallback.extra = {});

    delete (ex as any).rephraseBlocks;
    delete (ex as any).rephrase_blocks;
    delete (ex as any).blockPlan;
    delete (ex as any).block_plan;
    delete (ex as any).slots;
    delete (ex as any).slotPlanPolicy;
    delete (ex as any).slot_plan_policy;

    if ((ex as any).ctxPack && typeof (ex as any).ctxPack === 'object') {
      const cp: any = (ex as any).ctxPack;
      const keep: any = {};

      if (cp.flow) keep.flow = cp.flow;
      if (cp.resonanceState) keep.resonanceState = cp.resonanceState;
      if (typeof cp.seed_text === 'string' && cp.seed_text.trim()) {
        keep.seed_text = cp.seed_text.trim();
      }

      if (cp.historyForWriter) keep.historyForWriter = cp.historyForWriter;
      if (cp.historyDigestV1) keep.historyDigestV1 = cp.historyDigestV1;

        // --- 構造メタ（軽いので残す）---
        if (cp.phase) keep.phase = cp.phase;
        if (cp.depthStage) keep.depthStage = cp.depthStage;
        if (cp.qCode) keep.qCode = cp.qCode;
        if (cp.slotPlanPolicy) keep.slotPlanPolicy = cp.slotPlanPolicy;
        if (cp.goalKind) keep.goalKind = cp.goalKind;
        if (cp.exprMeta) keep.exprMeta = cp.exprMeta;
        if (cp.traceId) keep.traceId = cp.traceId;

      (ex as any).ctxPack = keep;
    } else {
      delete (ex as any).ctxPack;
    }

    delete (ex as any).historyForWriter;
    delete (ex as any).historyDigestV1;
    delete (ex as any).turns;
    delete (ex as any).flow;
    delete (ex as any).viewShift;
    delete (ex as any).viewShiftPrev;
    delete (ex as any).viewShiftSnapshot;
    delete (ex as any).topicDigest;
    delete (ex as any).flowDigest;

    (ex as any).finalAssistantText = fallbackText;
    (ex as any).finalTextPolicy = 'MICRO_FALLBACK';
    (ex as any).finalTextPolicyPickedFrom = 'micro_fallback';
  }

  try {
    metaForSaveMicroFallback = sanitizeIntentAnchorMeta(metaForSaveMicroFallback);
  } catch {}

  const tsPersist2 = nowNs();

  const tQsnap2 = nowNs();
  await persistQCodeSnapshotIfAny({
    userCode,
    conversationId,
    requestedMode: ctx0?.requestedMode ?? mode,
    metaForSave: metaForSaveMicroFallback,
  });
  t.persist_ms.q_snapshot_ms = msSince(tQsnap2);

  t.persist_ms.total_ms = msSince(tsPersist2);
  t.gate_ms = msSince(tg);
  t.finished_at = nowIso();
  t.total_ms = msSince(t0);

  const microFallbackSlots = [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: String(text ?? '').trim() || '（短文）',
    },
    {
      key: 'TASK',
      role: 'assistant',
      style: 'soft',
      content: 'micro_reply_fallback',
    },
    {
      key: 'CONSTRAINTS',
      role: 'assistant',
      style: 'soft',
      content: 'micro:fallback;no_menu;no_analysis;emoji:🪔(<=1)',
    },
    {
      key: 'DRAFT',
      role: 'assistant',
      style: 'soft',
      content: fallbackText,
    },
  ];

  return {
    ok: true,
    result: { gate: 'micro_writer_fallback', reason: mwReason, detail: mwDetail },
    assistantText: fallbackText,
    metaForSave: metaForSaveMicroFallback,
    finalMode: 'light',
    slots: microFallbackSlots,
    meta: metaForSaveMicroFallback,
  };
}
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

// ✅ Generic Recall 用：安全な文字列抽出（stringify しない）
function normForRecall(v: any): string {
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
          if (typeof (p as any).message === 'string') return (p as any).message;
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
            const s = normForRecall(m?.content ?? m?.text ?? (m as any)?.message ?? '');
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

    // ✅ GreetingGate の slotPlan を “root” に持ち上げる（extra 側だけだと拾われない経路がある）
    // - runGreetingGate は metaForSave.extra に framePlan/slotPlan/slotPlanPolicy/slotPlanLen を入れている
    // - ここで baseMetaMergedForTurn へコピーして、Orchestrator が確実に拾えるようにする
    if ((extraLocal as any)?.gatedGreeting?.ok) {
      if (!(baseMetaMergedForTurn as any).framePlan && (extraLocal as any)?.framePlan) {
        (baseMetaMergedForTurn as any).framePlan = (extraLocal as any).framePlan;
      }
      if (!(baseMetaMergedForTurn as any).slotPlan && (extraLocal as any)?.slotPlan) {
        (baseMetaMergedForTurn as any).slotPlan = (extraLocal as any).slotPlan;
      }
      if (!(baseMetaMergedForTurn as any).slotPlanPolicy && (extraLocal as any)?.slotPlanPolicy) {
        (baseMetaMergedForTurn as any).slotPlanPolicy = (extraLocal as any).slotPlanPolicy;
      }
      if (!(baseMetaMergedForTurn as any).slotPlanLen && (extraLocal as any)?.slotPlanLen) {
        (baseMetaMergedForTurn as any).slotPlanLen = (extraLocal as any).slotPlanLen;
      }
    }

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

    const gateApplied =
      prevDepthStage?.startsWith('R') &&
      typeof requestedDepthFinal === 'string' &&
      requestedDepthFinal.startsWith('I') &&
      (ctx.requestedDepth ?? '').trim().length > 0;

    console.log('[IROS][DepthGate] check', {
      prevDepthStage,
      requestedDepth_in: ctx.requestedDepth ?? null,
      requestedDepth_out: requestedDepthFinal ?? null,
      gateApplied,
    });
    // ---------------------------------------------------------
    // ✅ ViewShift / earlyResolvedAsk: Orchestrator 前に baseMetaMergedForTurn へ注入
    // - normalChat / orchestrator が参照できるのはこの時点の baseMetaForTurn
    // - capability_reask は後段 stamp では遅いので、ここで早期注入する
    // ---------------------------------------------------------
    try {
      const pickSnapFromMsg = (m: any) =>
        m?.meta?.extra?.ctxPack?.viewShiftSnapshot ??
        m?.meta?.ctxPack?.viewShiftSnapshot ??
        m?.meta?.extra?.viewShiftSnapshot ??
        m?.meta?.viewShiftSnapshot ??
        null;

      const currentUserText = String(text ?? '').trim();
      const currentUserTextLc = currentUserText.toLowerCase();

      const hasAnyInUser = (...needles: string[]) =>
        needles.some((n) => currentUserText.includes(n) || currentUserTextLc.includes(n.toLowerCase()));

      const hasCapabilityAsk =
        /何ができる|なにができる|できること|何をしてくれる|なにをしてくれる|どう役立つ|何がわかる|なにがわかる/u.test(
          currentUserText,
        );

      const hasRepairCue =
        hasAnyInUser(
          'ちがう',
          '違う',
          'それじゃない',
          'それじゃなくて',
          'それではなく',
          'そこじゃない',
          'そこではない',
          'そこじゃなくて',
          'さっき',
          '前に',
          '聞いた',
          '聞いたんだよ',
          'って聞いた',
          '答えて',
          'ちゃんと答えて',
          '一文で',
          'はぐらかさず',
          '元の質問',
          '元の問い',
        ) ||
        /さっき聞いた|前に聞いた|って聞いたんだよ|何ができるの[？?]って聞いた/u.test(currentUserText);

        const resolvedAskEarly =
        hasCapabilityAsk
          ? {
              topic: 'Irosで何ができるのか',
              askType: 'capability_reask',
              replyMode: 'reanswer_prior_question',
              sourceUserText: currentUserText,
            }
          : null;

      let snap: any =
        (baseMetaMergedForTurn as any)?.extra?.ctxPack?.viewShiftSnapshot ??
        (baseMetaMergedForTurn as any)?.ctxPack?.viewShiftSnapshot ??
        (baseMetaMergedForTurn as any)?.extra?.viewShiftSnapshot ??
        (baseMetaMergedForTurn as any)?.viewShiftSnapshot ??
        null;

      if (!snap && Array.isArray(historyForTurn)) {
        for (let i = historyForTurn.length - 1; i >= 0; i--) {
          const found = pickSnapFromMsg(historyForTurn[i]);
          if (found && typeof found === 'object') {
            snap = found;
            break;
          }
        }
      }

      (baseMetaMergedForTurn as any).extra =
        (baseMetaMergedForTurn as any).extra &&
        typeof (baseMetaMergedForTurn as any).extra === 'object'
          ? (baseMetaMergedForTurn as any).extra
          : {};

      (baseMetaMergedForTurn as any).extra.ctxPack =
        (baseMetaMergedForTurn as any).extra.ctxPack &&
        typeof (baseMetaMergedForTurn as any).extra.ctxPack === 'object'
          ? (baseMetaMergedForTurn as any).extra.ctxPack
          : {};

      if (snap && typeof snap === 'object') {
        (baseMetaMergedForTurn as any).extra.ctxPack.viewShiftSnapshot = snap;
      }

      if (resolvedAskEarly) {
        (baseMetaMergedForTurn as any).extra.ctxPack.resolvedAsk = resolvedAskEarly;
      }

      console.log('[IROS/VIEWSHIFT][pre-orch][inject]', {
        hasSnap: Boolean(snap),
        snapKeys: snap && typeof snap === 'object' ? Object.keys(snap).slice(0, 20) : null,
        earlyResolvedAskType: resolvedAskEarly?.askType ?? '',
      });
    } catch (e) {
      console.log('[IROS/VIEWSHIFT][pre-orch][inject][ERR]', { err: String(e ?? '') });
    }

    // ✅ Orchestrator（V2: 判断のみ。本文生成はしない）
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
// - postprocess が確定した値（uiCue/ctxPack 等）を潰さない
out.metaForSave.extra = out.metaForSave.extra ?? {};
if (extra && typeof extra === 'object') {
  const prev = out.metaForSave.extra ?? {};
  const next: any = { ...prev };

  for (const [k, v] of Object.entries(extra as any)) {
    // ✅ null/undefined は無視（既存を守る）
    if (v === undefined || v === null) continue;

    // ✅ postprocess が作る確定値は絶対に上書きしない
    if (k === 'uiCue') continue;

    // ✅ 既に値があるなら、extra では潰さない（postprocess優先）
    if (next[k] !== undefined && next[k] !== null) continue;

    next[k] = v;
  }
  out.metaForSave.extra = next;
}


    // ✅ single-writer stamp（最後に確定）
    out.metaForSave = stampSingleWriter(out.metaForSave);

    if (process.env.IROS_DEBUG_EXTRA === '1') {
      console.log('[IROS/Reply][extra-merged]', (out.metaForSave as any)?.extra);
    }

    // =========================================================
    // ✅ SpeechAct single-source stamp (ALWAYS write to metaForSave.extra)
    // =========================================================
    try {
      out.metaForSave = out.metaForSave ?? {};
      (out.metaForSave as any).extra = (out.metaForSave as any).extra ?? {};
      const ex: any = (out.metaForSave as any).extra;

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
        const cur = String(out.assistantText ?? (out as any).content ?? '').trim();
        ex.rawTextFromModel = cur.length ? cur : '…';
      }

      if (ex.extractedTextFromModel === undefined) ex.extractedTextFromModel = '';
    } catch (e) {
      console.warn('[IROS/Reply] SpeechAct stamp failed', e);
    }


// =========================================================
// ✅ FlowTape / FlowDigest（LLM-facing tiny continuity）
// - “禁止/縛り” は入れない（ログとして素直に刻むだけ）
// - metaForSave.extra に正本一本化（route.ts が拾える）
// =========================================================
// ✅ writer入力用の “このターン確定データ” を meta.extra に刻む（route.ts が拾う）
try {
  out.metaForSave = out.metaForSave ?? {};
  (out.metaForSave as any).extra = (out.metaForSave as any).extra ?? {};
  const exAny: any = (out.metaForSave as any).extra;

  // ---------------------------------------------------------
  // ✅ historyForWriter は「最後の数件」だけに制限する（token削減の要）
  // - DBの baseLimit=30 は保持してOK（state復元等のため）
  // - writer に渡す履歴だけを “短くする”
  // ---------------------------------------------------------
  const maxMsgsRaw =
  Number(process.env.IROS_REPHRASE_LAST_TURNS_MAX) ||
  Number(process.env.IROS_WRITER_HISTORY_MAX) ||
  2; // デフォルトは2（= 直近1往復ぶん）

const maxMsgs = Math.max(1, Math.min(2, Math.floor(maxMsgsRaw || 2)));

  // roleバランスを崩さず末尾から取る（user/assistantが片寄らないように）
  const shouldDropAssistantHistory = (role: string | null, content: string) => {
    if (role !== 'assistant') return false;

    const s = String(content ?? '').trim();
    if (!s) return true;

    return /(?:^|[\s「『（(])入力なし(?:[\s」』）):,，。.!！?？]|$)|（入力なし）/.test(s);
  };

  const stripAssistantTailQuestion = (text: string) => {
    const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!t) return '';

    const lines = t
      .split('\n')
      .map((ln) => String(ln ?? '').trim())
      .filter((ln, i, arr) => !(ln === '' && (i === 0 || i === arr.length - 1)));

    if (lines.length === 0) return '';

    const isQuestionLikeLine = (ln: string) => {
      const s = String(ln ?? '').trim();
      if (!s) return false;
      if (/[?？]\s*$/.test(s)) return true;
      if (/(ですか|ますか|でしょうか|ませんか|ないですか|たいですか)\s*$/.test(s)) return true;
      return false;
    };

    const isDanglingLeadLine = (ln: string) => {
      const s = String(ln ?? '').trim();
      if (!s) return false;

      if (/(が|は|を|に|へ|と|で|から|まで|より|だけ|ほど|くらい|ぐらい|とか|など)$/.test(s)) return true;
      if (/(なに|何|どれ|どの|どこ|誰|いつ|どう|なぜ)$/.test(s)) return true;
      if (/(いま|今|たとえば|例えば)$/.test(s)) return true;
      if (/(一番|もっとも|強く|近く|直後|途中|最後|先)$/.test(s)) return true;
      if (/[、，,:：]\s*$/.test(s)) return true;
      if (/のは\s*$/.test(s)) return true;
      if (/とは\s*$/.test(s)) return true;
      if (/なら\s*$/.test(s)) return true;
      if (/いちばん\s*$/.test(s)) return true;
      return false;
    };

    const last = String(lines[lines.length - 1] ?? '').trim();

    if (!isQuestionLikeLine(last) && !isDanglingLeadLine(last)) {
      return lines.join('\n').trim();
    }

    if (lines.length >= 2) {
      const prev = String(lines[lines.length - 2] ?? '').trim();

      const prevLooksDanglingLead =
        isDanglingLeadLine(prev) ||
        /(?:どの身体反応が|どの感覚に|あなたは|いま、あなたは|ざわつきが一番強くなるのは)$/.test(prev);

      const dropCount = prevLooksDanglingLead ? 2 : 1;
      const trimmed = lines.slice(0, -dropCount).join('\n').trim();
      return trimmed;
    }

    return '';
  };

  // historyForWriter は「履歴のみ」を保存する
  // - latest user の正本は writer 実行時の userText に一本化済み
  // - ここでは current user を再注入しない
  const pickHistoryOnlyTail = (arr: any[], n: number) => {
    const need = Math.max(1, n);
    const src = Array.isArray(arr) ? arr : [];

    const normalized = src
      .map((m) => {
        const role =
          m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;

        let content =
          typeof (m?.text ?? m?.content) === 'string'
            ? String(m.text ?? m.content).trim()
            : '';

        if (role === 'assistant') {
          content = stripAssistantTailQuestion(content);
        }

        if (!role || !content) return null;
        if (shouldDropAssistantHistory(role, content)) return null;

        return { role, content };
      })
      .filter(Boolean) as Array<{ role: 'user' | 'assistant'; content: string }>;

    if (normalized.length === 0) return [];

    // current turn の latest user は writer 実行時の userText に一本化済みなので落とす
    const historyOnly =
      normalized.length > 0 && normalized[normalized.length - 1].role === 'user'
        ? normalized.slice(0, -1)
        : normalized;

    if (historyOnly.length === 0) return [];

    // ✅ 末尾から見て、同一 role 連続は「最新1件だけ」残す
    const collapsedFromTail: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let lastRole: 'user' | 'assistant' | null = null;

    for (let i = historyOnly.length - 1; i >= 0; i--) {
      const row = historyOnly[i];
      if (!row?.role || !row?.content) continue;
      if (row.role === lastRole) continue;
      collapsedFromTail.push(row);
      lastRole = row.role;
      if (collapsedFromTail.length >= Math.max(need, 2)) break;
    }

    const collapsed = collapsedFromTail.reverse();

    if (collapsed.length === 0) return [];

    if (need <= 1) {
      return [collapsed[collapsed.length - 1]];
    }

    if (collapsed.length >= 2) {
      return collapsed.slice(-2);
    }

    return collapsed.slice(-1);
  };
  const hs = Array.isArray(historyForTurn) ? (historyForTurn as any[]) : [];
  console.log('[IROS/HFW_RAW_SOURCE_BEFORE_PICK]', {
    len: Array.isArray(historyForTurn) ? historyForTurn.length : null,
    tail: Array.isArray(historyForTurn)
      ? historyForTurn.slice(-6).map((m: any) => ({
          role: m?.role ?? null,
          head: String(m?.content ?? m?.text ?? '').slice(0, 80),
        }))
      : null,
  });
  let tail: Array<{ role: 'user' | 'assistant'; content: string }> = pickHistoryOnlyTail(hs, maxMsgs)
    .map((m) => {
      const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
      const content =
        typeof m?.content === 'string' ? String(m.content).trim() : '';
      if (!role || !content) return null;
      return { role, content };
    })
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => Boolean(m));

  const finalAssistantContent = (() => {
    const ex = exAny as any;

    const candidates = [
      ex?.finalAssistantText,
      ex?.resolvedText,
      out?.assistantText,
      (out as any)?.content,
      ex?.persistedAssistantMessage?.text,
    ];

    for (const v of candidates) {
      if (typeof v === 'string' && v.trim().length > 0) {
        return v.trim();
      }
    }

    return '';
  })();

  // STEP1:
  // historyForWriter へ finalAssistantContent を再注入しない
  // - writer は current turn の assistant 本文に引っ張られず、
  //   Seed + current user を主参照にする
  // - 直前 assistant の参照が必要な処理は、historyForWriter ではなく
  //   専用の軽量メタ側で扱う

  // 最大件数に再調整
  tail = tail.slice(-Math.max(1, maxMsgs));

  console.log('[IROS/HFW_PICKED_TAIL]', {
    len: Array.isArray(tail) ? tail.length : null,
    items: Array.isArray(tail)
      ? tail.map((m) => ({
          role: m.role,
          head: String(m.content ?? '').slice(0, 80),
        }))
      : null,
    finalAssistantHead: finalAssistantContent.slice(0, 80),
  });


  const slotPlanArr =
    Array.isArray((out.metaForSave as any)?.slotPlan)
      ? (out.metaForSave as any).slotPlan
      : Array.isArray((out.metaForSave as any)?.framePlan?.slotPlan)
        ? (out.metaForSave as any).framePlan.slotPlan
        : Array.isArray((out.metaForSave as any)?.framePlan?.slotPlan?.slots)
          ? (out.metaForSave as any).framePlan.slotPlan.slots
          : [];

  const shiftSlot = slotPlanArr.find(
    (s: any) => String(s?.key ?? s?.id ?? '').toUpperCase() === 'SHIFT',
  );

  const shiftText = String(
    shiftSlot?.content ?? shiftSlot?.text ?? '',
  ).trim();

  const isTopicRecallTurn =
    shiftText.includes('"meaning_kind":"topic_recall"');

  if (!isTopicRecallTurn) {
    // ✅ 最小形（role/content のみ）で保存：metaは持たない（太るので）
    exAny.historyForWriter = tail;
    exAny.rememberTextForIros = typeof rememberTextForIros === 'string' ? rememberTextForIros : null;
    exAny.historyForWriterAt = new Date().toISOString();
  }
  // =========================================================
  // ✅ FlowTape / FlowDigest（LLM-facing tiny continuity）
  // - “禁止/縛り” は入れない（ログとして素直に刻むだけ）
  // - metaForSave.extra に正本一本化（route.ts が拾える）
  // =========================================================
  try {
    const { appendFlowTape } = await import('../flow/flowTape');
    const { buildFlowDigest } = await import('../flow/flowDigest');

    const prevTape = typeof exAny.flowTape === 'string' ? exAny.flowTape : null;

    // ※この下は「あなたの既存の coord 構築 & append/build」をそのまま残してOK
    // exAny.flowTape = appendFlowTape(prevTape, coord, ...);
    // exAny.flowDigest = buildFlowDigest(exAny.flowTape);

} catch (e) {
  console.warn('[IROS/Reply] failed to stamp history/remember for writer', e);
}
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
        (out.metaForSave as any)?.depth_stage ??
        (out.metaForSave as any)?.depth ??
        (out.metaForSave as any)?.unified?.depth?.stage ??
        (out.metaForSave as any)?.depthStage ??
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

    // 既存：flow
    (mf.extra as any).flowTape = tape ?? null;
    (mf.extra as any).flowDigest = exAny.flowDigest ?? null;

// ✅ 追加：historyDigestV1（無ければこの場で作って保存）
// - 生成ポイントを “ここ1箇所” に固定（重複生成しない）
// - 既に入ってるなら触らない
if (true) {
  try {
    // const { buildHistoryDigestV1 } = await import('@/lib/iros/history/historyDigestV1');

    const lastUserCore =
      String((ctx as any)?.continuity?.last_user_core ?? (ctx as any)?.lastUserCore ?? '').trim() || '';
    const lastAssistantCore =
      String((ctx as any)?.continuity?.last_assistant_core ?? (ctx as any)?.lastAssistantCore ?? '').trim() || '';

      const repeatSignal = !!(ctx as any)?.repeatSignalSame || !!(ctx as any)?.repeat_signal || false;

      // ✅ 最新 user を最優先
      const latestSummary = lastUserCore.slice(0, 120);
      const fallbackSummary = String((ctx as any)?.situationSummary ?? '').trim().slice(0, 120);
      const situationSummaryForDigest = latestSummary || fallbackSummary;

      // ✅ topic を雑に「その他・ライフ全般」へ潰さない
      // - rawTopic が具体的ならそれを残す
      // - rawTopic が空 / 汎用ラベルなら latestSummary から短く起こす
      const rawTopic = String((ctx as any)?.situationTopic ?? '').trim();

      const isGenericTopic =
        !rawTopic ||
        rawTopic === 'その他・ライフ全般' ||
        rawTopic === 'その他ライフ全般' ||
        rawTopic === 'ライフ全般' ||
        rawTopic === 'その他';

      const summaryTopicSeed =
        latestSummary ||
        fallbackSummary ||
        String((ctx as any)?.latestUserText ?? '').trim() ||
        '';

      const situationTopicForDigest = (
        isGenericTopic
          ? (summaryTopicSeed.slice(0, 32) || 'その他・ライフ全般')
          : rawTopic
      ).slice(0, 40);

      (mf.extra as any).historyDigestV1 = buildHistoryDigestV1({
        fixedNorth: { key: 'SUN', phrase: '成長 / 進化 / 希望 / 歓喜' },
        metaAnchorKey: String((ctx as any)?.baseMetaForTurn?.intent_anchor_key ?? '').trim() || null,
        memoryAnchorKey: String((ctx as any)?.memoryState?.intentAnchor ?? (ctx as any)?.intentAnchor ?? '').trim() || null,

        qPrimary: (ctx as any)?.memoryState?.qPrimary ?? (ctx as any)?.qPrimary ?? 'Q3',
        depthStage: (ctx as any)?.memoryState?.depthStage ?? (ctx as any)?.depthStage ?? 'F1',
        phase: (ctx as any)?.memoryState?.phase ?? (ctx as any)?.phase ?? 'Inner',

        situationTopic: situationTopicForDigest,
        situationSummary: situationSummaryForDigest,

        lastUserCore: lastUserCore.slice(0, 120),
        lastAssistantCore: lastAssistantCore.slice(0, 120),
        repeatSignal,
    });
  } catch {
    // keep silent
  }
}}}


// ---- ctxPack.flow (minimal, with prev from history) ----
// 方針：
// - 依存/重い処理は増やさない
// - “前回の flow.at” と “前回の returnStreak” だけ history から拾って prevAtIso / ageSec / prevRs を埋める
// - sessionBreak はここでは決めない（false 固定。閾値設計は後で）
// - ✅ flowDelta / returnStreak を ctxPack.flow の正本として毎ターン stamp する
const nowIso2 = new Date().toISOString();

// ✅ ctxPack を必ず用意（exAny という名前は使わない＝既存と衝突回避）
const mf2: any = (out as any)?.metaForSave ?? null;
if (!mf2 || typeof mf2 !== 'object') {
  throw new Error('CTXPACK stamp: metaForSave missing');
}
if (!mf2.extra || typeof mf2.extra !== 'object') {
  mf2.extra = {};
}
const extra2: any = mf2.extra;
if (!extra2.ctxPack || typeof extra2.ctxPack !== 'object') {
  extra2.ctxPack = {};
}

// ---- stingLevel (state-derived; minimal) ----
// 方針：
// - depthStage / repeatSignal / intensity / returnStreak だけで決める
// - ここでは軽量計算のみ
// - 正本は extra.stingLevel / extra.ctxPack.stingLevel
const normalizeDepthBandForSting = (depthRaw: any): 'F' | 'S' | 'R' | 'C' | 'I' | 'T' => {
  const s = String(depthRaw ?? '').trim().toUpperCase();
  const head = s.charAt(0);
  if (head === 'F' || head === 'S' || head === 'R' || head === 'C' || head === 'I' || head === 'T') {
    return head as 'F' | 'S' | 'R' | 'C' | 'I' | 'T';
  }
  return 'F';
};

const bumpStingLevel = (v: 'LOW' | 'MID' | 'HIGH'): 'LOW' | 'MID' | 'HIGH' => {
  if (v === 'LOW') return 'MID';
  if (v === 'MID') return 'HIGH';
  return 'HIGH';
};

const pickNumberForSting = (...vals: any[]): number | null => {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

const depthStageForSting =
  (extra2.ctxPack as any)?.depthStage ??
  (mf2 as any)?.depthStage ??
  (ctx as any)?.memoryState?.depthStage ??
  (ctx as any)?.depthStage ??
  'F1';

const repeatSignalForSting =
  !!(ctx as any)?.repeatSignalSame ||
  !!(ctx as any)?.repeat_signal ||
  !!(extra2.ctxPack as any)?.repeatSignal ||
  false;

const returnStreakForSting = (() => {
  const n = pickNumberForSting(
    (extra2.ctxPack as any)?.flow?.returnStreak,
    (extra2 as any)?.flow?.returnStreak,
    (mf2 as any)?.flow?.returnStreak,
    (ctx as any)?.instant?.flow?.returnStreak,
    (ctx as any)?.flow?.returnStreak,
  );
  return n ?? 0;
})();

const intensityForSting = (() => {
  const n = pickNumberForSting(
    (ctx as any)?.mirror?.intensity,
    (ctx as any)?.extra?.mirror?.intensity,
    (ctx as any)?.extra?.mirrorFlowV1?.mirror?.intensity,
    (mf2 as any)?.mirror?.intensity,
    (extra2 as any)?.mirror?.intensity,
    (extra2 as any)?.mirrorFlowV1?.mirror?.intensity,
    (extra2.ctxPack as any)?.resonanceState?.instant?.mirror?.intensity,
  );
  return n ?? 0;
})();

let stingLevel2: 'LOW' | 'MID' | 'HIGH' = 'LOW';

const depthBandForSting = normalizeDepthBandForSting(depthStageForSting);
if (depthBandForSting === 'C' || depthBandForSting === 'I' || depthBandForSting === 'T') {
  stingLevel2 = 'HIGH';
}
if (returnStreakForSting >= 3) stingLevel2 = bumpStingLevel(stingLevel2);
if (repeatSignalForSting) stingLevel2 = bumpStingLevel(stingLevel2);
if (intensityForSting > 0.6) stingLevel2 = bumpStingLevel(stingLevel2);

(extra2 as any).stingLevel = stingLevel2;
(extra2.ctxPack as any).stingLevel = stingLevel2;

// ---- ctxPack restore (minimal; from history) ----
// 目的：前ターン assistant.meta.extra.ctxPack を「今回の ctxPack 初期値」として復元する。
// 注意：重いキーや演出系は継続禁止。最小キーだけ戻す。
const restoreCtxPackFromHistory = (historyForTurn: any[]): any | null => {
  const hft = Array.isArray(historyForTurn) ? (historyForTurn as any[]) : [];
  for (let i = hft.length - 1; i >= 0; i--) {
    const m = hft[i];
    if ((m as any)?.role !== 'assistant') continue;

    const ctx =
      (m as any)?.meta?.extra?.ctxPack ??
      (m as any)?.meta?.ctxPack ??
      null;

    if (!ctx || typeof ctx !== 'object') continue;

    const restoredDepthHistoryLite =
      Array.isArray((ctx as any).depthHistoryLite)
        ? (ctx as any).depthHistoryLite
            .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
            .filter((v: string) => /^[SFRCIT][123]$/.test(v))
            .slice(-5)
        : [];

    const restored: any = {
      qCode: typeof ctx.qCode === 'string' ? ctx.qCode : null,
      depthStage: typeof ctx.depthStage === 'string' ? ctx.depthStage : null,
      phase: typeof ctx.phase === 'string' ? ctx.phase : null,
      conversationLine: typeof ctx.conversationLine === 'string' ? ctx.conversationLine : null,
      stingLevel: typeof ctx.stingLevel === 'string' ? ctx.stingLevel : null,
      depthHistoryLite: restoredDepthHistoryLite,
    };

    if (
      restored.qCode ||
      restored.depthStage ||
      restored.phase ||
      restored.conversationLine ||
      restored.stingLevel ||
      restoredDepthHistoryLite.length > 0
    ) {
      return restored;
    }
  }
  return null;
};

// ✅ 復元→合流（現ターン優先）
const restored = restoreCtxPackFromHistory(historyForTurn);
if (restored) {
  extra2.ctxPack = {
    ...restored,
    ...(extra2.ctxPack as any),
  };
}

// history から「直近の ctxPack.flow.at / returnStreak」を拾う
let prevAtIso: string | null = null;
let prevReturnStreak: number | null = null;

const hft = Array.isArray(historyForTurn) ? (historyForTurn as any[]) : [];
for (let i = hft.length - 1; i >= 0; i--) {
  const m = hft[i];

  // まず “flow object” 候補を拾う（複数経路に対応）
  const flowObj =
    (m as any)?.meta?.extra?.ctxPack?.flow ??
    (m as any)?.meta?.ctxPack?.flow ??
    (m as any)?.meta?.extra?.flow ??
    (m as any)?.meta?.flow ??
    null;

  // at
  const flowAt = flowObj?.at ?? null;
  if (!prevAtIso && typeof flowAt === 'string' && flowAt.trim().length > 0) {
    prevAtIso = flowAt.trim();
  }

  // returnStreak（flowObj に無いケースがあるので候補を増やす）
  const rsCandidates = [
    flowObj?.returnStreak,
    flowObj?.return_streak,
    (m as any)?.meta?.extra?.ctxPack?.returnStreak,
    (m as any)?.meta?.ctxPack?.returnStreak,
    (m as any)?.meta?.extra?.returnStreak,
    (m as any)?.meta?.returnStreak,
  ];

  if (prevReturnStreak == null) {
    for (const rsRaw of rsCandidates) {
      if (typeof rsRaw === 'number' && Number.isFinite(rsRaw)) {
        prevReturnStreak = rsRaw;
        break;
      }
      if (typeof rsRaw === 'string' && rsRaw.trim() && Number.isFinite(Number(rsRaw))) {
        prevReturnStreak = Number(rsRaw);
        break;
      }
    }
  }

  if (prevAtIso && prevReturnStreak != null) break;
}

let ageSec: number | null = null;
if (prevAtIso) {
  const prevMs = Date.parse(prevAtIso);
  const nowMs = Date.parse(nowIso2);
  if (!Number.isNaN(prevMs) && !Number.isNaN(nowMs)) {
    const d = Math.floor((nowMs - prevMs) / 1000);
    ageSec = d >= 0 ? d : 0;
  }
}

// ✅ ここで「今回の returnStreak」を確定させる
// 方針：
// - まず current 正本（extra.flow.returnStreak）を最優先
// - 無いときだけ history(prev) から再計算
{
  const deltaNow =
    (out as any)?.metaForSave?.extra?.flow?.delta ??
    (out as any)?.metaForSave?.extra?.flow?.flowDelta ??
    (extra2 as any)?.flow?.delta ??
    (extra2 as any)?.flow?.flowDelta ??
    (extra2.ctxPack as any)?.flow?.delta ??
    (extra2.ctxPack as any)?.flow?.flowDelta ??
    null;

  const pickNum = (...vals: any[]): number | null => {
    for (const v of vals) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  const currentRs = pickNum(
    (out as any)?.metaForSave?.extra?.flow?.returnStreak,
    (out as any)?.metaForSave?.extra?.flow?.return_streak,
    (extra2 as any)?.flow?.returnStreak,
    (extra2 as any)?.flow?.return_streak,
    (out as any)?.metaForSave?.extra?.mirrorFlowV1?.flow?.returnStreak,
    (out as any)?.metaForSave?.extra?.flowMirror?.returnStreak,
    (out as any)?.metaForSave?.extra?.resonanceState?.flow_returnStreak,
  );

  const prevRs =
    typeof prevReturnStreak === 'number' && Number.isFinite(prevReturnStreak)
      ? prevReturnStreak
      : 0;

  const fallbackRs =
    String(deltaNow || '').toUpperCase() === 'RETURN'
      ? prevRs + 1
      : 0;

  const rsNow = currentRs ?? fallbackRs;

  // ctxPack.flow は current 正本に揃えて stamp
  (extra2.ctxPack as any).flow = {
    ...((extra2.ctxPack as any).flow ?? {}),
    at: nowIso2,
    prevAt: prevAtIso,
    ageSec,
    delta: deltaNow ?? null,
    flowDelta: deltaNow ?? null, // 互換
    returnStreak: rsNow,
    sessionBreak: false,
  };
}

// ---- conversationLine v2 (semantic summarizer) ----
// 目的：戻す（復帰）に必要な「話題1行」を ctxPack に保存する
// 方針：既存の単語頻度圧縮ではなく、topicSummarizer で意味ラベル化する
{
  const current = String(text ?? '').trim();

  const existing = String((extra2.ctxPack as any).conversationLine ?? '').trim();
  const looksLikeDebugLine =
    !!existing &&
    (/^Q:/.test(existing) ||
      existing.includes('Q:') ||
      existing.includes('D:') ||
      existing.includes('P:') ||
      existing.includes('流れ:') ||
      existing.includes('戻り:'));

  if (!existing || looksLikeDebugLine) {
    const topic = summarizeTopicLineV1({
      userText: current,
      historyForWriter: hft,
      historyDigestV1: ((extra2.ctxPack as any)?.historyDigestV1 ?? null) as any,
      situationSummary:
        String((extra2.ctxPack as any)?.situationSummary ?? '').trim() || null,
      situationTopic:
        String((extra2.ctxPack as any)?.situationTopic ?? '').trim() || null,
    });

    const line = topic?.conversationLine ?? null;
    const digest = topic?.topicDigest ?? line ?? null;
    const digestV2 =
      topic?.topicDigestV2 && typeof topic.topicDigestV2 === 'object'
        ? topic.topicDigestV2
        : null;

    (extra2.ctxPack as any).conversationLine = line;
    (extra2.ctxPack as any).topicDigest = digest;
    (extra2.ctxPack as any).topicDigestV2 = digestV2;

    if (Array.isArray(topic?.keywords) && topic.keywords.length > 0) {
      (extra2.ctxPack as any).topicKeywords = topic.keywords;
    }
  }
}
// ✅ flowDelta をこの場で算出
// 方針：
// 1) すでに out/metaForSave 側に flow があるなら「それを正本」として採用（上書きしない）
// 2) 無い場合だけ observeFlow で算出
const userObs2 = String(text ?? '').trim();

// lastUserTextForFlow は「直前の user」を拾う（同文でもOK）
// - 同一文が末尾に重複しているケースで「別文を探す」方式だと lastUserText を失い、flow がズレるため
let lastUserTextForFlow: string | null = null;
for (let i = hft.length - 1; i >= 0; i--) {
  const m = hft[i];
  const role = String((m as any)?.role ?? '').toLowerCase();
  if (role !== 'user') continue;

  const c = String((m as any)?.content ?? (m as any)?.text ?? '').trim();
  if (!c) continue;

  lastUserTextForFlow = c;
  break;
}

let flowDelta: string | null = null;
let flowConfidence: number | null = null;

// ✅ まず「既に計算済みの flow」を探す（上書き防止）
// - ここはプロジェクト内で散らばっている可能性があるので “拾えるだけ拾う”
const preDeltaRaw =
  (mf2 as any)?.flow?.delta ??
  (mf2 as any)?.extra?.flow?.delta ??
  (mf2 as any)?.extra?.ctxPack?.flow?.delta ??
  (mf2 as any)?.ctxPack?.flow?.delta ??
  (mf2 as any)?.extra?.ctxPack?.flow?.flowDelta ??
  (mf2 as any)?.ctxPack?.flow?.flowDelta ??
  null;

const preConfRaw =
  (mf2 as any)?.flow?.confidence ??
  (mf2 as any)?.extra?.flow?.confidence ??
  (mf2 as any)?.extra?.ctxPack?.flow?.confidence ??
  (mf2 as any)?.ctxPack?.flow?.confidence ??
  (mf2 as any)?.extra?.ctxPack?.flow?.flowConfidence ??
  (mf2 as any)?.ctxPack?.flow?.flowConfidence ??
  null;

if (typeof preDeltaRaw === 'string' && preDeltaRaw.trim().length > 0) {
  flowDelta = preDeltaRaw.trim();
  flowConfidence = typeof preConfRaw === 'number' && Number.isFinite(preConfRaw) ? preConfRaw : null;
} else {
  try {
    // import 衝突回避のため動的 import
    const { observeFlow } = await import('../input/flowObserver');
    const flow = observeFlow({
      currentText: userObs2,
      lastUserText: lastUserTextForFlow ?? undefined,
    }) as any;

    const d = flow?.delta ? String(flow.delta) : null;
    flowDelta = d && d.trim().length > 0 ? d.trim() : null;

    const conf = typeof flow?.confidence === 'number' ? flow.confidence : null;
    flowConfidence = typeof conf === 'number' && Number.isFinite(conf) ? conf : null;
  } catch {
    flowDelta = null;
    flowConfidence = null;
  }
}

// 正規化（比較と stamp を揃える）
const flowDeltaNorm = flowDelta ? String(flowDelta).toUpperCase().trim() : null;

// ✅ returnStreak は「current 正本を最優先」として採用し、無い時だけ prev+delta で算出
const pickNumeric = (...vals: any[]): number | null => {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
};

const preReturnStreakRaw = pickNumeric(
  // 1) current 正本を最優先
  (mf2 as any)?.extra?.flow?.returnStreak,
  (mf2 as any)?.extra?.flow?.return_streak,

  // 2) ctxPack 側
  (mf2 as any)?.extra?.ctxPack?.flow?.returnStreak,
  (mf2 as any)?.extra?.ctxPack?.flow?.return_streak,
  (mf2 as any)?.ctxPack?.flow?.returnStreak,
  (mf2 as any)?.ctxPack?.flow?.return_streak,

  // 3) 互換の最後
  (mf2 as any)?.flow?.returnStreak,
  (mf2 as any)?.flow?.return_streak,
);

let returnStreak: number = 0;

if (preReturnStreakRaw != null) {
  returnStreak = preReturnStreakRaw;
} else {
  const prevRs =
    typeof prevReturnStreak === 'number' && Number.isFinite(prevReturnStreak) ? prevReturnStreak : 0;
  returnStreak = flowDeltaNorm === 'RETURN' ? prevRs + 1 : 0;
}

// ✅ ctxPack.flow を毎ターン stamp（正本）
(extra2.ctxPack as any).flow = {
  at: nowIso2,
  ageSec: ageSec ?? null,
  // delta を正本に（互換で flowDelta も併記）
  delta: flowDeltaNorm ?? null,
  flowDelta: flowDeltaNorm ?? null,
  confidence: flowConfidence ?? null,
  flowConfidence: flowConfidence ?? null,
  returnStreak,
  sessionBreak: false,
};

// 互換：extra.flow にも薄く示す（既存が参照している可能性があるため）
if (!extra2.flow || typeof extra2.flow !== 'object') extra2.flow = {};
(extra2.flow as any).delta = (extra2.flow as any).delta ?? flowDeltaNorm ?? null;
(extra2.flow as any).confidence = (extra2.flow as any).confidence ?? flowConfidence ?? null;
(extra2.flow as any).returnStreak = (extra2.flow as any).returnStreak ?? returnStreak;
(extra2.flow as any).sessionBreak = (extra2.flow as any).sessionBreak ?? false;
// ctxPack にも historyForWriter を同期（循環参照を避ける最小形）
const hfwCandidates = [
  (out.metaForSave as any)?.extra?.historyForWriter,
  (out.extraForHandle as any)?.historyForWriter,
  (out.extraForHandle as any)?.ctxPack?.historyForWriter,
  (extra2.ctxPack as any)?.historyForWriter,
];

const hfw = hfwCandidates.find(
  (v) => Array.isArray(v) && v.length > 0,
) ?? [];

const normalizedHfw = Array.isArray(hfw)
  ? (hfw as any[])
      .map((m) => ({
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        content: String((m as any)?.content ?? '').trim(),
      }))
      .filter((m) => m.content.length > 0)
  : [];

// ✅ 重要：空でない historyForWriter が見つかったら、ctxPack 正本へ必ず同期
if (normalizedHfw.length > 0) {
  (extra2.ctxPack as any).historyForWriter = normalizedHfw;
}

// ✅ historyForWriterAt も同様に同期
const hfwAt =
  (out.metaForSave as any)?.extra?.historyForWriterAt ??
  (out.extraForHandle as any)?.historyForWriterAt ??
  (out.extraForHandle as any)?.ctxPack?.historyForWriterAt ??
  (extra2.ctxPack as any)?.historyForWriterAt ??
  null;

if (hfwAt != null) {
  (extra2.ctxPack as any).historyForWriterAt = hfwAt;
}

// ✅ ctxPack にも historyDigestV1 を同期（存在しているものだけ）
const digestV1Raw =
  (out.metaForSave as any)?.extra?.historyDigestV1 ??
  (out.extraForHandle as any)?.historyDigestV1 ??
  (out.extraForHandle as any)?.ctxPack?.historyDigestV1 ??
  (extra2 as any)?.historyDigestV1 ??
  null;

if (digestV1Raw) {
  (extra2.ctxPack as any).historyDigestV1 = digestV1Raw;
}
// ✅ Phase 2-1: personal SHIFT 用の軽量推定を ctxPack 正本へ stamp
// - 断定診断ではなく "hint" として保持
// - relation / temperature / shiftKind をまず先に入れる
{
  const cp: any = (extra2.ctxPack as any);

  const shift2_pickText = (...vals: any[]): string => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const shift2_norm = (s: any): string => String(s ?? '').trim();

  const shift2_srcText = shift2_pickText(
    cp?.latestUserText,
    cp?.userText,
    cp?.conversationLine,
    cp?.topicDigest,
    (out.metaForSave as any)?.input,
    ''
  );

  const shift2_text = shift2_norm(shift2_srcText);
  const shift2_textLc = shift2_text.toLowerCase();

  const shift2_flowDelta = shift2_norm(
    cp?.flow?.delta ??
      cp?.flow?.flowDelta ??
      (extra2 as any)?.flow?.delta ??
      (extra2 as any)?.flow?.flowDelta ??
      flowDelta ??
      ''
  ).toUpperCase();

  const shift2_returnStreak = (() => {
    const raw =
      cp?.flow?.returnStreak ??
      (extra2 as any)?.flow?.returnStreak ??
      returnStreak ??
      0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  })();

  const shift2_stingLevel = String(
    cp?.stingLevel ??
      (extra2 as any)?.stingLevel ??
      ''
  )
    .trim()
    .toUpperCase();

  const shift2_goalKind = String(
    cp?.goalKind ??
      (out.metaForSave as any)?.targetKind ??
      (out.metaForSave as any)?.target_kind ??
      ''
  ).trim();

  const shift2_repeatSignal = String(cp?.repeatSignal ?? '').trim();

  const hasAny = (...needles: string[]) =>
    needles.some((n) => shift2_text.includes(n) || shift2_textLc.includes(n.toLowerCase()));

  // -----------------------------
  // relationFocus（軽量）
  // -----------------------------
  const relationFocus = (() => {
    // ✅ relation 判定は「現在の userText」を最優先に見る
    // - seed / shift text / 補助文に混ざった人間関係語で誤発火させない
    const currentUserText = String(text ?? '').trim();
    const currentUserTextLc = currentUserText.toLowerCase();

    const hasAnyInUser = (...needles: string[]) =>
      needles.some((n) => currentUserText.includes(n) || currentUserTextLc.includes(n.toLowerCase()));

    const looksRelation = hasAnyInUser(
      '相手',
      '恋愛',
      '関係',
      '連絡',
      '既読',
      '未読',
      '距離',
      '気持ち',
      '追いかけ',
      '避け',
      '好き',
      '別れ',
      '会いたい'
    );

    if (!looksRelation) return null;

    let selfPosition: string | null = null;
    let otherPosition: string | null = null;
    let powerBalance: 'weaker' | 'balanced' | 'stronger' | 'unknown' | null = 'unknown';
    let distanceLevel: 'too_close' | 'close' | 'unstable' | 'far' | 'unknown' | null = 'unknown';
    let certaintyLevel: 'low' | 'mid' | 'high' | 'unknown' | null = 'unknown';

    if (hasAny('自分でもわからない', 'どうしたいかわからない', '続けたいのかわからない')) {
      selfPosition = 'unclear';
    } else if (hasAny('続けたい', '会いたい', '連絡したい')) {
      selfPosition = 'approach';
    } else if (hasAny('距離を置きたい', '離れたい', 'もう無理')) {
      selfPosition = 'withdraw';
    }

    if (hasAny('相手の気持ちがわからない', '相手が何を考えてるかわからない', 'どう思ってるかわからない')) {
      otherPosition = 'unreadable';
      certaintyLevel = 'low';
    } else if (hasAny('脈あり', '好かれてる', '向こうから来る')) {
      otherPosition = 'approaching';
      if (certaintyLevel === 'unknown') certaintyLevel = 'mid';
    } else if (hasAny('距離を置かれてる', '避けられてる', '冷たい', '返信が来ない')) {
      otherPosition = 'distancing';
      certaintyLevel = 'low';
    }

    if (hasAny('立場が弱い', '相手次第', '振り回される', '追いかけてしまう')) {
      powerBalance = 'weaker';
    } else if (hasAny('主導している', '自分が決めている')) {
      powerBalance = 'stronger';
    } else if (looksRelation) {
      powerBalance = 'balanced';
    }

    if (hasAny('近すぎて苦しい', '重い', 'しんどい', '息苦しい')) {
      distanceLevel = 'too_close';
    } else if (hasAny('距離を置かれてる', '離れてる', '遠い', '会えない')) {
      distanceLevel = 'far';
    } else if (hasAny('近づいたり離れたり', '不安定', '揺れる', '曖昧')) {
      distanceLevel = 'unstable';
    } else if (looksRelation) {
      distanceLevel = 'close';
    }

    if (certaintyLevel === 'unknown') {
      if (hasAny('迷ってる', 'わからない', '不安')) certaintyLevel = 'low';
      else certaintyLevel = 'mid';
    }

    return {
      selfPosition,
      otherPosition,
      powerBalance,
      distanceLevel,
      certaintyLevel,
    };
  })();

  // -----------------------------
  // emotionalTemperature（軽量）
  // -----------------------------
  const emotionalTemperature = (() => {
    const volatileHit =
      hasAny('わからない', '揺れる', 'ぐるぐる', '混乱', 'まとまらない') &&
      (shift2_returnStreak >= 2 || shift2_repeatSignal === 'same_phrase');

    if (volatileHit) return 'volatile' as const;

    if (
      shift2_stingLevel === 'HIGH' ||
      shift2_returnStreak >= 3 ||
      hasAny('苦しい', 'つらい', '怖い', 'しんどい', '限界')
    ) {
      return 'high' as const;
    }

    if (
      shift2_stingLevel === 'MID' ||
      hasAny('迷う', '不安', '止まる', '動けない', 'どうしよう')
    ) {
      return 'mid' as const;
    }

    return 'low' as const;
  })();

  // -----------------------------
  // shiftKind（第二段の主ルーティング）
  // -----------------------------
  const shiftKind = (() => {
    const currentUserText = String(text ?? '').trim();
    const currentUserTextLc = currentUserText.toLowerCase();

    const hasAnyInUser = (...needles: string[]) =>
      needles.some((n) => currentUserText.includes(n) || currentUserTextLc.includes(n.toLowerCase()));

    const resolvedAskEarly = (() => {
      const hasTruthLike =
        hasAnyInUser('真実', '事実', '本当') ||
        /真実|事実|本当/u.test(currentUserText);

      const hasStructureLike =
        hasAnyInUser('構造的', '構造', '並び', '当てる', '当てはめる', '置き換える', '解釈') ||
        /構造的|構造|並び|当てる|当てはめる|置き換える|解釈/u.test(currentUserText);

      const hasHumanCreationLike =
        /地球外生命体.*人間.*(作った|創った)/u.test(currentUserText) ||
        /人間.*地球外生命体.*(作った|創った)/u.test(currentUserText) ||
        /宇宙人.*人間.*(作った|創った)/u.test(currentUserText) ||
        /人間.*宇宙人.*(作った|創った)/u.test(currentUserText);

      const hasAlienTopicLike =
        hasAnyInUser('地球外生命体', '宇宙人') ||
        /地球外生命体|宇宙人/u.test(currentUserText);

      const hasCapabilityAsk =
        /何ができる|なにができる|できること|何をしてくれる|なにをしてくれる|どう役立つ|何がわかる|なにがわかる/u.test(
          currentUserText,
        );

      const hasRepairCue =
        hasAnyInUser(
          'ちがう',
          '違う',
          'それじゃない',
          'それじゃなくて',
          'それではなく',
          'そこじゃない',
          'そこではない',
          'そこじゃなくて',
          'さっき',
          '前に',
          '聞いた',
          '聞いたんだよ',
          'って聞いた',
          '答えて',
          'ちゃんと答えて',
          '一文で',
          'はぐらかさず',
          '元の質問',
          '元の問い',
        ) ||
        /さっき聞いた|前に聞いた|って聞いたんだよ|何ができるの[？?]って聞いた/u.test(currentUserText);

      if (hasCapabilityAsk && hasRepairCue) {
        return {
          topic: 'Irosで何ができるのか',
          askType: 'capability_reask',
          replyMode: 'reanswer_prior_question',
          sourceUserText: currentUserText,
        } as const;
      }

      if (
        (hasHumanCreationLike && (hasTruthLike || hasStructureLike)) ||
        (hasAlienTopicLike && hasStructureLike)
      ) {
        return {
          topic: hasHumanCreationLike ? '地球外生命体が人間を作ったのか' : '地球外生命体',
          askType: 'truth_structure',
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserText,
        } as const;
      }

      return null;
    })();

    if (resolvedAskEarly?.askType === 'truth_structure') {
      return 'clarify_shift' as const;
    }
    if (hasAnyInUser('答え', '結論', '要するに', '結局', '真実が知りたい', '本当のことが知りたい', 'そろそろ結論', '今の未来', '未来だよ')) {
      return 'decide_shift' as const;
    }
    const topicCorrection =
      /(.+?)の話ですよ/u.test(currentUserText) ||
      /(.+?)のことです/u.test(currentUserText) ||
      /(その話です|そのことです|その件です)/u.test(currentUserText) ||
      /(さっきから言ってるのは.+です)/u.test(currentUserText);

    if (topicCorrection) {
      return 'clarify_shift' as const;
    }

    if (hasAny('って何', 'とは', '意味', '違い', '定義')) return 'clarify_shift' as const;

    if (relationFocus) {
      if (
        relationFocus.distanceLevel === 'far' ||
        relationFocus.distanceLevel === 'too_close' ||
        relationFocus.distanceLevel === 'unstable'
      ) {
        return 'distance_shift' as const;
      }

      if (hasAny('仲直り', '修復', '戻りたい', 'やり直したい')) {
        return 'repair_shift' as const;
      }
    }

    if (hasAny('決められない', '行くべきか', 'やめるべきか', '迷ってる', '選べない')) {
      return 'decide_shift' as const;
    }

    if (
      hasAny('何から', 'わからない', '焦点', '整理したい', '何が不安かわからない') &&
      shift2_goalKind !== 'clarify'
    ) {
      return 'narrow_shift' as const;
    }

    if (
      shift2_flowDelta === 'RETURN' ||
      emotionalTemperature === 'high' ||
      emotionalTemperature === 'volatile' ||
      hasAny('戻ってきた', '動けない', '止まる', 'しんどい')
    ) {
      return 'stabilize_shift' as const;
    }

    return 'narrow_shift' as const;
  })();

  // ctxPack 正本へ stamp
  if (cp.relationFocus == null) cp.relationFocus = relationFocus;
  if (cp.emotionalTemperature == null) cp.emotionalTemperature = emotionalTemperature;
  if (cp.shiftKind == null) cp.shiftKind = shiftKind;

  const resolvedAskDecision = (() => {
    const currentUserText = String(text ?? '').trim();
    const currentUserTextLc = currentUserText.toLowerCase();

    const hasAnyInUser = (...needles: string[]) =>
      needles.some((n) => currentUserText.includes(n) || currentUserTextLc.includes(n.toLowerCase()));

    const prev = (cp as any)?.resolvedAsk ?? null;

    const topicCorrectionOnly =
      /(.+?)の話ですよ/u.test(currentUserText) ||
      /(.+?)のことです/u.test(currentUserText) ||
      /(その話です|そのことです|その件です)/u.test(currentUserText) ||
      /(さっきから言ってるのは.+です)/u.test(currentUserText);

    const explicitAlienHumanCreate =
      /地球外生命体.*人間.*作/u.test(currentUserText) ||
      /人間.*地球外生命体.*作/u.test(currentUserText) ||
      /宇宙人.*人間.*作/u.test(currentUserText) ||
      /人間.*宇宙人.*作/u.test(currentUserText);

    const explicitTruthStructure =
      (hasAnyInUser('真実', '構造的') && hasAnyInUser('地球外生命体', '宇宙人', '人間')) ||
      explicitAlienHumanCreate;

    const structureFollowOnAlienTopic =
      hasAnyInUser('地球外生命体', '宇宙人') &&
      hasAnyInUser('並び', '構造', '当てる', '当てはめる', '置き換える', '解釈');

    const hasCapabilityAsk =
      /何ができる|なにができる|何が出来る|なにが出来る|できること|何をしてくれる|なにをしてくれる|どう役立つ|何がわかる|なにがわかる/u.test(
        currentUserText,
      );

    const hasRepairCue =
      hasAnyInUser(
        'ちがう',
        '違う',
        'それじゃない',
        'それじゃなくて',
        'それではなく',
        'そこじゃない',
        'そこではない',
        'そこじゃなくて',
        'さっき',
        '前に',
        '聞いた',
        '聞いたんだよ',
        'って聞いた',
        '答えて',
        'ちゃんと答えて',
        '一文で',
        'はぐらかさず',
        '元の質問',
        '元の問い',
      ) ||
      /さっき聞いた|前に聞いた|って聞いたんだよ|何ができるの[？?]って聞いた/u.test(currentUserText);

    // ✅ capability の言い直しは最優先
    if (hasCapabilityAsk && hasRepairCue) {
      return {
        next: {
          topic: 'Irosで何ができるのか',
          askType: 'capability_reask',
          replyMode: 'reanswer_prior_question',
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    // ✅ capability_reask 継続
    if (
      prev &&
      typeof prev === 'object' &&
      String((prev as any).askType ?? '').trim() === 'capability_reask' &&
      (hasCapabilityAsk || hasRepairCue)
    ) {
      return {
        next: {
          ...prev,
          replyMode: 'reanswer_prior_question',
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    // ✅ truth_structure 明示
    if (explicitTruthStructure) {
      return {
        next: {
          topic: '地球外生命体が人間を作ったのか',
          askType: 'truth_structure',
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    // ✅ truth_structure のフォローオン
    if (
      structureFollowOnAlienTopic &&
      prev &&
      typeof prev === 'object' &&
      String((prev as any).askType ?? '').trim() === 'truth_structure'
    ) {
      return {
        next: {
          ...prev,
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    // ✅ 話題訂正だけなら前回文脈を維持
    if (topicCorrectionOnly && prev && typeof prev === 'object') {
      return {
        next: {
          ...prev,
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    if (structureFollowOnAlienTopic) {
      return {
        next: {
          topic: '地球外生命体が人間を作ったのか',
          askType: 'truth_structure',
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserText,
        },
        clear: false,
      } as const;
    }

    // ✅ ここが重要：
    // 今回の入力が「一般的な capability / structure 質問」で、
    // 特定トピック resolvedAsk を作れない場合は、前ターンの resolvedAsk を残さない
    if (hasCapabilityAsk) {
      return { next: null, clear: true } as const;
    }

    if (
      !hasAnyInUser('地球外生命体', '宇宙人', '人間') &&
      /何が|なにが|どういう|どう|とは|意味|構造|出来ますか|できますか/u.test(currentUserText)
    ) {
      return { next: null, clear: true } as const;
    }

    return { next: null, clear: false } as const;
  })();

  const resolvedAskNow = resolvedAskDecision.next;
  const shouldClearResolvedAskNow = resolvedAskDecision.clear === true;

  if (resolvedAskNow) {
    (cp as any).resolvedAsk = resolvedAskNow;
  } else if (shouldClearResolvedAskNow) {
    delete (cp as any).resolvedAsk;
  }

}

// 既存の flow 同期はそのまま（ただし returnStreak/flowDelta は meta.extra.flow を正本にする）
const flowFromMeta: any =
  (out.metaForSave as any)?.extra?.ctxPack?.flow ??
  (out.metaForSave as any)?.extra?.flow ??
  null;

const flowDelta_forCtx =
  (flowFromMeta && typeof flowFromMeta.flowDelta === 'string' && flowFromMeta.flowDelta.trim())
    ? flowFromMeta.flowDelta.trim()
    : (flowDelta ?? null);

const returnStreak_forCtx =
  (flowFromMeta && typeof flowFromMeta.returnStreak === 'number')
    ? flowFromMeta.returnStreak
    : (typeof returnStreak === 'number' ? returnStreak : null);

const flowConfidence_forCtx =
  (flowFromMeta && typeof flowFromMeta.flowConfidence === 'number')
    ? flowFromMeta.flowConfidence
    : (typeof flowConfidence === 'number' ? flowConfidence : null);

(extra2.ctxPack as any).flow = {
  at: nowIso2,
  prevAtIso,
  ageSec,

  // ✅ 正本優先
  flowDelta: flowDelta_forCtx,
  flowConfidence: flowConfidence_forCtx,
  returnStreak: returnStreak_forCtx,

  // minimal: ここでは固定
  sessionBreak: false,
  fresh: true,

  traceId: traceId ?? null,
};

(extra2.ctxPack as any).exprMeta = (out.metaForSave as any)?.extra?.exprMeta ?? null;

// ✅ RESONANCE_STATE を ctxPack 正本へ同期（rephraseEngine が拾う入口）
{
  const exOut: any = (out.metaForSave as any)?.extra ?? {};
  const rs: any =
    exOut?.resonanceState ??
    exOut?.ctxPack?.resonanceState ??
    null;

  if ((extra2.ctxPack as any).resonanceState == null && rs && typeof rs === 'object') {
    (extra2.ctxPack as any).resonanceState = rs;
  }

  // NOTE(vNext):
  // - 互換 seed_text の ctxPack 同期は廃止する。
  // - seed_text は「保存/互換」用途で meta.extra 側に残り得るが、
  //   ctxPack に入れると rephraseEngine / llmGate の拾い口が生き続けるため。
}
if (extra2.ctxPack && typeof extra2.ctxPack === 'object') {
  const unifiedObservedForStamp =
    ((out.metaForSave as any)?.unified?.observed ??
      (out.metaForSave as any)?.extra?.unified?.observed ??
      null) as any;

  const currentCardForStamp: any =
    ((extra2.ctxPack as any)?.cards?.currentCard ??
      (out.metaForSave as any)?.extra?.ctxPack?.cards?.currentCard ??
      null) as any;

  const observedStageForStamp =
    (typeof (extra2.ctxPack as any)?.observedStage === 'string' && (extra2.ctxPack as any).observedStage.trim()
      ? (extra2.ctxPack as any).observedStage.trim()
      : typeof unifiedObservedForStamp?.observedStage === 'string' && unifiedObservedForStamp.observedStage.trim()
        ? unifiedObservedForStamp.observedStage.trim()
        : typeof currentCardForStamp?.observedStage === 'string' && currentCardForStamp.observedStage.trim()
          ? currentCardForStamp.observedStage.trim()
          : typeof currentCardForStamp?.stage === 'string' && currentCardForStamp.stage.trim()
            ? currentCardForStamp.stage.trim()
            : null);

  const primaryStageForStamp =
    (typeof (extra2.ctxPack as any)?.primaryStage === 'string' && (extra2.ctxPack as any).primaryStage.trim()
      ? (extra2.ctxPack as any).primaryStage.trim()
      : typeof unifiedObservedForStamp?.primaryStage === 'string' && unifiedObservedForStamp.primaryStage.trim()
        ? unifiedObservedForStamp.primaryStage.trim()
        : observedStageForStamp);

  const secondaryStageForStamp =
    (typeof (extra2.ctxPack as any)?.secondaryStage === 'string' && (extra2.ctxPack as any).secondaryStage.trim()
      ? (extra2.ctxPack as any).secondaryStage.trim()
      : typeof unifiedObservedForStamp?.secondaryStage === 'string' && unifiedObservedForStamp.secondaryStage.trim()
        ? unifiedObservedForStamp.secondaryStage.trim()
        : null);

  const depthStageForStamp =
    typeof (extra2.ctxPack as any)?.depthStage === 'string' && (extra2.ctxPack as any).depthStage.trim()
      ? (extra2.ctxPack as any).depthStage.trim()
      : null;

  const prevDepthHistoryLiteForStamp = Array.isArray((extra2.ctxPack as any)?.depthHistoryLite)
    ? (extra2.ctxPack as any).depthHistoryLite
        .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v: string) => /^[SFRCIT][123]$/.test(v))
        .slice(-5)
    : [];

  const nextDepthHistoryLiteForStamp =
    depthStageForStamp
      ? [...prevDepthHistoryLiteForStamp, depthStageForStamp].slice(-5)
      : prevDepthHistoryLiteForStamp;

  (extra2.ctxPack as any).observedStage = observedStageForStamp;
  (extra2.ctxPack as any).primaryStage = primaryStageForStamp;
  (extra2.ctxPack as any).secondaryStage = secondaryStageForStamp;
  (extra2.ctxPack as any).depthHistoryLite = nextDepthHistoryLiteForStamp;
}
// digestChars は “注入対象の文字数” を見るため（JSON stringify）
let digestChars: number | null = null;
try {
  const d = (extra2.ctxPack as any)?.historyDigestV1 ?? null;
  digestChars = d ? JSON.stringify(d).length : null;
} catch {
  digestChars = null;
}

console.log('[IROS][CTXPACK] stamped', {
  traceId: traceId ?? null,
  conversationId,
  userCode,

  hasCtxPack: !!extra2.ctxPack,
  prevAtIso: prevAtIso ?? null,
  ageSec: ageSec ?? null,
  flowAt: (extra2.ctxPack as any)?.flow?.at ?? null,

  // ✅ Downshift観測点
  flowDelta: (extra2.ctxPack as any)?.flow?.flowDelta ?? null,
  returnStreak: (extra2.ctxPack as any)?.flow?.returnStreak ?? null,

  // ✅ MirrorFlow SEED Step1/2 観測
  observedStage: (extra2.ctxPack as any)?.observedStage ?? null,
  primaryStage: (extra2.ctxPack as any)?.primaryStage ?? null,
  secondaryStage: (extra2.ctxPack as any)?.secondaryStage ?? null,
  observedBasedOn: (extra2.ctxPack as any)?.observedBasedOn ?? null,
  depthHistoryLite: Array.isArray((extra2.ctxPack as any)?.depthHistoryLite)
    ? (extra2.ctxPack as any).depthHistoryLite
    : null,

  ctxPackKeys: extra2.ctxPack ? Object.keys(extra2.ctxPack as any) : null,

  hfw_len: Array.isArray((extra2.ctxPack as any)?.historyForWriter)
    ? (extra2.ctxPack as any).historyForWriter.length
    : 0,
  hasDigestV1: Boolean((extra2.ctxPack as any)?.historyDigestV1),
  digestChars,
  hfw_src_len: Array.isArray((out.metaForSave as any)?.extra?.historyForWriter)
    ? (out.metaForSave as any).extra.historyForWriter.length
    : 0,
});
// ✅ PDF用の最小構造パック（毎ターン正本）
{
  const ctxPackPdf: any =
    extra2.ctxPack && typeof extra2.ctxPack === 'object'
      ? extra2.ctxPack
      : {};

  const flowMeaningCanon =
    typeof (extra2 as any)?.flowMeaning === 'string' && (extra2 as any).flowMeaning.trim()
      ? (extra2 as any).flowMeaning.trim()
      : typeof (extra2 as any)?.flowDigest === 'string' && (extra2 as any).flowDigest.trim()
        ? (extra2 as any).flowDigest.trim()
        : typeof (out.metaForSave as any)?.extra?.flowDigest === 'string' &&
            (out.metaForSave as any).extra.flowDigest.trim()
          ? (out.metaForSave as any).extra.flowDigest.trim()
          : null;

  const conversationLineCanon =
    typeof ctxPackPdf.conversationLine === 'string' && ctxPackPdf.conversationLine.trim()
      ? ctxPackPdf.conversationLine.trim()
      : null;

  const topicDigestCanon =
    typeof ctxPackPdf.topicDigest === 'string' && ctxPackPdf.topicDigest.trim()
      ? ctxPackPdf.topicDigest.trim()
      : typeof (extra2 as any)?.topicDigest === 'string' && (extra2 as any).topicDigest.trim()
        ? (extra2 as any).topicDigest.trim()
        : null;

  (extra2 as any).pdfPack = {
    depthStage:
      typeof ctxPackPdf.depthStage === 'string' && ctxPackPdf.depthStage.trim()
        ? ctxPackPdf.depthStage.trim()
        : null,
    phase:
      typeof ctxPackPdf.phase === 'string' && ctxPackPdf.phase.trim()
        ? ctxPackPdf.phase.trim()
        : null,
    qCode:
      typeof ctxPackPdf.qCode === 'string' && ctxPackPdf.qCode.trim()
        ? ctxPackPdf.qCode.trim()
        : null,

    primaryStage:
      typeof ctxPackPdf.primaryStage === 'string' && ctxPackPdf.primaryStage.trim()
        ? ctxPackPdf.primaryStage.trim()
        : null,
    secondaryStage:
      typeof ctxPackPdf.secondaryStage === 'string' && ctxPackPdf.secondaryStage.trim()
        ? ctxPackPdf.secondaryStage.trim()
        : null,
    observedStage:
      typeof ctxPackPdf.observedStage === 'string' && ctxPackPdf.observedStage.trim()
        ? ctxPackPdf.observedStage.trim()
        : null,
    observedBasedOn:
      typeof ctxPackPdf.observedBasedOn === 'string' && ctxPackPdf.observedBasedOn.trim()
        ? ctxPackPdf.observedBasedOn.trim()
        : null,

    depthHistoryLite: Array.isArray(ctxPackPdf.depthHistoryLite)
      ? ctxPackPdf.depthHistoryLite
          .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v: string) => /^[SFRCIT][123]$/.test(v))
          .slice(-5)
      : [],

    flowMeaning: flowMeaningCanon,
    conversationLine: conversationLineCanon,
    topicDigest: topicDigestCanon,
  };
}

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

// --- FIX: slotPlan を framePlan.slots（枠）に合わせて補完する（SAFE欠け対策） ---
// ✅ ここで out.metaForSave.slotPlan を正規化して「LLM_GATE が見る meta」に反映させる
try {
  const fp0 = (out.metaForSave as any)?.framePlan ?? null;
  const sp0 = (out.metaForSave as any)?.slotPlan ?? null;

  // framePlan.slots: [{id, hint, ...}, ...]
  const fpSlots: any[] = Array.isArray(fp0?.slots) ? fp0.slots : [];
  const wantIds = fpSlots.map((s: any) => String(s?.id ?? '').trim()).filter(Boolean);

  const spArrRaw: any[] = Array.isArray(sp0) ? sp0 : [];

  // ------------------------------------------------------------
  // ✅ slotPlan の実体を { key, text } に寄せる
  // - legacy: {key,text}
  // - new:    {key,content,slotId,role,style} → text = content を採用
  // ------------------------------------------------------------
  const normalizeItemToKeyText = (x: any) => {
    if (!x || typeof x !== 'object') return null;

    const k =
      String(x?.key ?? '').trim() ||
      String(x?.slotId ?? '').trim() ||
      null;

    const t =
      (typeof x?.text === 'string' ? x.text : null) ??
      (typeof x?.content === 'string' ? x.content : null) ??
      null;

    if (!k || !t) return null;
    return { key: k, text: String(t) };
  };

  // spArrKeyText: 変換できたものだけ
  const spArrKeyText: any[] = spArrRaw.map(normalizeItemToKeyText).filter(Boolean);

  // 1) 想定している slotPlan 形（{key,text} or {key,content}）
  const looksLikeKeyText =
    spArrRaw.length === 0 ||
    spArrRaw.every(
      (x: any) =>
        x &&
        typeof x === 'object' &&
        ('key' in x || 'slotId' in x) &&
        ('text' in x || 'content' in x),
    );

  // 2) “間違って入ってきがち” な形：framePlan のスロット定義配列（{id,required,hint}）
  const looksLikeFrameDefs =
    spArrRaw.length > 0 &&
    spArrRaw.every(
      (x: any) =>
        x &&
        typeof x === 'object' &&
        'id' in x &&
        'required' in x &&
        'hint' in x &&
        !('key' in x) &&
        !('text' in x) &&
        !('content' in x),
    );

  // frameDefs の場合は “本文スロットは無い” とみなす
  const spArrUse: any[] = looksLikeFrameDefs ? [] : spArrKeyText;

  let slotPlanNormalized: any = sp0;

  if (wantIds.length > 0 && Array.isArray(sp0) && (looksLikeKeyText || looksLikeFrameDefs)) {
    const byKey = new Map<string, any>();
    for (const x of spArrUse) {
      const k = String(x?.key ?? '').trim();
      if (k) byKey.set(k, x);
    }

    const normalized: any[] = [];
    const missing: string[] = [];

    for (const id of wantIds) {
      const hit = byKey.get(id);
      if (hit) {
        normalized.push(hit);
        continue;
      }

      // 欠けスロット（特に SAFE）を最小プレースホルダで補完
      const hint = fpSlots.find((s: any) => String(s?.id ?? '').trim() === id)?.hint ?? null;

      missing.push(id);
      normalized.push({
        key: id,
        text: `@${id} ${JSON.stringify(
          { kind: 'auto_fill', hint: hint ? String(hint) : null },
          null,
          0,
        )}`,
      });
    }

    slotPlanNormalized = normalized;

    console.log('[IROS/rephraseBridge][SLOT_NORM]', {
      wantIds,
      had: spArrUse.map((x: any) => String(x?.key ?? '').trim()).filter(Boolean),
      missing,
      len_before: spArrRaw.length,
      len_after: normalized.length,
      fromFrameDefs: looksLikeFrameDefs,
    });
  }

  // ✅ ここが最重要：LLM_GATE が見る metaForSave.slotPlan を {key,text} に統一
  (out.metaForSave as any).slotPlan = Array.isArray(slotPlanNormalized) ? slotPlanNormalized : spArrUse;
} catch (e) {
  console.warn('[IROS/rephraseBridge][SLOT_NORM] failed (non-fatal)', e);
}
    // --- /FIX ---

    // slotPlanLen が未設定のときだけ infer（上で確定していればここはスキップされる）
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

  // ✅ seed の単一ソース
  // - CALL_LLM：rewriteSeed のみを seed として運ぶ（resolvedText は本文採用/seed専用の別物なので混ぜない）
  // - SKIP系：本文採用（out.content）で完結するため seed 注入はしない
  const rewriteSeedRaw = String((gate as any)?.rewriteSeed ?? '').trim();
  const resolvedTextRaw = String((gate as any)?.resolvedText ?? '').trim();

  // ✅ CALL_LLM で seed があるなら、FINAL/SCAFFOLD問わず “必ず” 運ぶ
  if (gate?.llmEntry === 'CALL_LLM' && rewriteSeedRaw.length > 0) {
    if (ex.llmRewriteSeed == null || String(ex.llmRewriteSeed).trim().length === 0) {
      ex.llmRewriteSeed = rewriteSeedRaw;
      ex.llmRewriteSeedFrom = 'llmGate(rewriteSeed)';
      ex.llmRewriteSeedAt = new Date().toISOString();
    }
  }

  // （任意：デバッグ用メタ。露出はしない前提。必要なければ削除OK）
  if (gate?.llmEntry === 'CALL_LLM' && rewriteSeedRaw.length === 0 && resolvedTextRaw.length > 0) {
    ex.llmGateResolvedTextLen = resolvedTextRaw.length;
    ex.llmGateResolvedTextNote = 'CALL_LLM has resolvedText but rewriteSeed empty (not injected as seed)';
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

// ✅ canonical stamp（MIRROR_FLOW / downstream が q_code を確実に拾えるようにする）
try {
  const userTextForCanon =
    (typeof (ctx as any)?.userText === 'string' ? (ctx as any).userText : null) ??
    (typeof (ctx as any)?.inputText === 'string' ? (ctx as any).inputText : null) ??
    null;

  const canonical = canonicalizeIrosMeta({
    metaForSave: out.metaForSave,
    userText: userTextForCanon,
  });

  out.metaForSave = applyCanonicalToMetaForSave(out.metaForSave, canonical);

  // 監査ログ（必要なら消してOK）
  const conversationIdForLog =
    (ctx as any)?.conversationIdUuid ??
    (ctx as any)?.conversationId ??
    (ctx as any)?.conversation_id ??
    null;

  const userCodeForLog =
    (ctx as any)?.userCode ??
    (ctx as any)?.user_code ??
    (ctx as any)?.user?.code ??
    null;

  console.log('[IROS/CANON][STAMP]', {
    conversationId: conversationIdForLog,
    userCode: userCodeForLog,
    q_code: (out.metaForSave as any)?.q_code ?? null,
    depth_stage: (out.metaForSave as any)?.depth_stage ?? null,
    phase: (out.metaForSave as any)?.phase ?? null,
  });
} catch (e) {
  console.warn('[IROS/CANON][STAMP] failed', e);
}

// ✅ FINAL: rotation bridge / canonical stamp 後に ctxPack.willRotation を再stamp
try {
  const exAnyFinal = ((out.metaForSave as any)?.extra ?? {}) as any;
  if (!exAnyFinal.ctxPack || typeof exAnyFinal.ctxPack !== 'object') exAnyFinal.ctxPack = {};
  const ctxPackFinal = exAnyFinal.ctxPack as any;

  const rotationStateFinal =
    ((out.metaForSave as any)?.rotationState ??
      (out.metaForSave as any)?.rotation ??
      null) as any;

  const willRotationReasonFinal =
    typeof rotationStateFinal?.reason === 'string' && rotationStateFinal.reason.trim().length > 0
      ? rotationStateFinal.reason.trim()
      : null;

  const willRotationSuggestedStageFinal =
    typeof rotationStateFinal?.depth === 'string' && rotationStateFinal.depth.trim().length > 0
      ? rotationStateFinal.depth.trim()
      : null;

  const willRotationSpinLoopFinal =
    typeof rotationStateFinal?.spinLoop === 'string' && rotationStateFinal.spinLoop.trim().length > 0
      ? rotationStateFinal.spinLoop.trim()
      : ((out.metaForSave as any)?.spinLoop ?? null);

  const willRotationDescentGateFinal =
    typeof rotationStateFinal?.descentGate === 'string' && rotationStateFinal.descentGate.trim().length > 0
      ? rotationStateFinal.descentGate.trim()
      : ((out.metaForSave as any)?.descentGate ?? null);

  const willRotationStamped = {
    ...(ctxPackFinal.willRotation && typeof ctxPackFinal.willRotation === 'object'
      ? ctxPackFinal.willRotation
      : {}),
    axis: null,
    kind: null,
    reason: willRotationReasonFinal,
    suggestedStage: willRotationSuggestedStageFinal,
    spinLoop: willRotationSpinLoopFinal,
    descentGate: willRotationDescentGateFinal,
  };

  ctxPackFinal.willRotation = willRotationStamped;

  // ✅ result.meta.extra.ctxPack にも同じ正本を反映する
  if (!(out as any).meta || typeof (out as any).meta !== 'object') {
    (out as any).meta = {};
  }
  if (!(out as any).meta.extra || typeof (out as any).meta.extra !== 'object') {
    (out as any).meta.extra = {};
  }
  if (!(out as any).meta.extra.ctxPack || typeof (out as any).meta.extra.ctxPack !== 'object') {
    (out as any).meta.extra.ctxPack = {};
  }
  (out as any).meta.extra.ctxPack.willRotation = willRotationStamped;

  if (!(out as any).result || typeof (out as any).result !== 'object') {
    (out as any).result = {};
  }
  if (!(out as any).result.meta || typeof (out as any).result.meta !== 'object') {
    (out as any).result.meta = {};
  }
  if (!(out as any).result.meta.extra || typeof (out as any).result.meta.extra !== 'object') {
    (out as any).result.meta.extra = {};
  }
  if (
    !(out as any).result.meta.extra.ctxPack ||
    typeof (out as any).result.meta.extra.ctxPack !== 'object'
  ) {
    (out as any).result.meta.extra.ctxPack = {};
  }
  (out as any).result.meta.extra.ctxPack.willRotation = willRotationStamped;

  console.log('[IROS/Reply][FINAL_META_CTXPACK_WILLROTATION_RESTAMP]', {
    conversationId: (ctx as any)?.conversationId ?? null,
    userCode:
      (ctx as any)?.userCode ??
      (ctx as any)?.user_code ??
      (ctx as any)?.headersUserCode ??
      null,
    traceId: ((ctx as any)?.traceId ?? (ctx as any)?.extra?.traceId ?? null) as any,
    rotationState: rotationStateFinal
      ? {
          spinLoop: rotationStateFinal.spinLoop ?? null,
          descentGate: rotationStateFinal.descentGate ?? null,
          depth: rotationStateFinal.depth ?? null,
          reason: rotationStateFinal.reason ?? null,
        }
      : null,
    ctxPack_willRotation: ctxPackFinal.willRotation ?? null,
    result_meta_extra_ctxPack_willRotation:
      (out as any)?.result?.meta?.extra?.ctxPack?.willRotation ?? null,
  });
} catch (e) {
  console.warn('[IROS/Reply][FINAL_META_CTXPACK_WILLROTATION_RESTAMP] failed', e);
}

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

// 現時点の本文
// - assistantText/content が空でも、本文候補として既にある seed / final text を拾う
// - マイクロ入力で本文マスク扱いにならないよう、広めに SoT を参照する
const pickFirstNonBlank = (...xs: any[]) => {
  for (const x of xs) {
    const s = String(x ?? '').trim();
    if (s) return s;
  }
  return '';
};

// 現時点の本文
// - null/undefined だけでなく空文字も飛ばす
// - マイクロ入力で seed / final text を本文候補として使えるようにする
const bodyNow = pickFirstNonBlank(
  out.assistantText,
  (out as any)?.content,
  (out.metaForSave as any)?.extra?.finalAssistantText,
  (out.metaForSave as any)?.extra?.finalAssistantTextCandidate,
  (out.metaForSave as any)?.extra?.slotPlanSeed,
  (out.metaForSave as any)?.extra?.llmRewriteSeed,
);

// ✅ traceId をこの場で一回だけ正規化（alreadyHasBlocks 判定にも使う）
const traceIdNow: string | null = (() => {
  const v =
    (ctx as any)?.traceId ??
    (out.metaForSave as any)?.extra?.traceId ??
    (out.metaForSave as any)?.extra?.ctxPack?.traceId ??
    (out.metaForSave as any)?.traceId ??
    null;

  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
})();

// ✅ 既存 blocks の trace（無ければ “古い残り” と見なす）
const existingBlocksTraceId: string | null = (() => {
  const v = (ex as any)?.rephraseBlocksTraceId ?? (ex as any)?.rephraseTraceId ?? null;
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
})();

// ✅ blocks が残っていても「同一 traceId のときだけ」already 扱い
const hasBlocksNow = Array.isArray((ex as any)?.rephraseBlocks) && (ex as any).rephraseBlocks.length > 0;
const blocksTraceMatch =
  !!traceIdNow && !!existingBlocksTraceId && traceIdNow === existingBlocksTraceId;

let alreadyHasBlocks = hasBlocksNow && blocksTraceMatch;

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

const hasSlotsLocal =
  Array.isArray((out.metaForSave as any)?.slotPlan) &&
  (out.metaForSave as any).slotPlan.length > 0;

const internalMarkersOnly =
  Number.isFinite(slotTextCleanedLen) &&
  Number.isFinite(slotTextRawLen) &&
  slotTextRawLen > 0 &&
  slotTextCleanedLen === 0;

const hasSeedText = Number.isFinite(slotTextCleanedLen) && slotTextCleanedLen > 0;

const bodyEmptyLike = !bodyNow || isDotsOnly(bodyNow) || internalMarkersOnly;

// ✅ 緊急(emptyLike) と seed-only(本文未生成) を分離
const seedOnlyNow = bodyEmptyLike && hasSeedText;
const emptyLikeNow = bodyEmptyLike && !hasSeedText;

// ✅ ここが止血の本丸：空っぽ系のときに “古い blocks” が残ってたら消す（trace 不一致 or trace無し）
if ((policy === 'SCAFFOLD' || policy === 'FINAL') && (seedOnlyNow || emptyLikeNow) && hasBlocksNow && !blocksTraceMatch) {
  console.warn('[IROS/rephraseBridge][STALE_BLOCKS_CLEARED]', {
    conversationId: _conversationId,
    userCode: _userCode,
    policy,
    traceIdNow,
    existingBlocksTraceId,
    rbLen: Array.isArray((ex as any)?.rephraseBlocks) ? (ex as any).rephraseBlocks.length : 0,
  });

  // renderGateway の復旧素材にもならないように “実体” を落とす
  delete (ex as any).rephraseBlocks;
  delete (ex as any).rephraseBlocksTraceId;
  (ex as any).rephraseBlocksCleared = true;
  (ex as any).rephraseBlocksClearedReason = 'trace_mismatch_or_missing';
  (ex as any).rephraseBlocksClearedAt = new Date().toISOString();

  alreadyHasBlocks = false;
}

// ✅ /reply では RenderEngine 側（src/app/api/agent/iros/reply/_impl/rephrase.ts）に writer を一本化する
// - handleIrosReply 側の rephraseBridge が LLM を叩くと「二重呼び」になるため、ここで抑止
// - ただし seedOnly / emptyLike の「空っぽ系」は RenderEngine が writer を打たない瞬間があるため、bridge を許可する
const disableRephraseBridgeWriterBase =
  (out.metaForSave as any)?.extra?.renderEngineGate === true ||
  (out.metaForSave as any)?.extra?.renderEngine === true ||
  (out.metaForSave as any)?.extra?.persistedByRoute === true ||
  (out.metaForSave as any)?.extra?.persistAssistantMessage === false;

// ✅ /reply では通常は _impl/rephrase.ts 側に writer を一本化する
// - ただし seedOnly / emptyLike の「空っぽ系」は bridge 側の writer を許可する
// - 二重呼び防止は維持しつつ、短い入力の fallback 落ちを防ぐ
const disableRephraseBridgeWriter =
  disableRephraseBridgeWriterBase && !(seedOnlyNow || emptyLikeNow);

console.log('[IROS/rephraseBridge][DISABLE_DBG_V1]', {
  disableRephraseBridgeWriterBase,
  seedOnlyNow,
  emptyLikeNow,
  orValue: (seedOnlyNow || emptyLikeNow),
  notOrValue: !(seedOnlyNow || emptyLikeNow),
  computed: disableRephraseBridgeWriterBase && !(seedOnlyNow || emptyLikeNow),
  computed2: disableRephraseBridgeWriter,
  types: {
    base: typeof disableRephraseBridgeWriterBase,
    seedOnlyNow: typeof seedOnlyNow,
    emptyLikeNow: typeof emptyLikeNow,
    computed2: typeof disableRephraseBridgeWriter,
  },
});

const effectivePolicy =
  String(
    policy ||
      (out.metaForSave as any)?.extra?.slotPlanPolicy_detected ||
      (out.metaForSave as any)?.extra?.slotPlanPolicy ||
      (out.metaForSave as any)?.slotPlanPolicy ||
      ''
  ).trim();

const shouldRunWriter =
  (policy === 'SCAFFOLD' || policy === 'FINAL') &&
  (seedOnlyNow || emptyLikeNow) &&
  !alreadyHasBlocks &&
  allowLLM_final_local !== false &&
  !disableRephraseBridgeWriter;

if (seedOnlyNow || emptyLikeNow) {
  console.log('[IROS/rephraseBridge][ENTER]', {
    conversationId: _conversationId,
    userCode: _userCode,
    policy: effectivePolicy,
    seedOnlyNow,
    emptyLikeNow,
    allowLLM_final: allowLLM_final_local,
    alreadyHasBlocks,
    slotTextCleanedLen: Number((out.metaForSave as any)?.extra?.slotTextCleanedLen ?? null),
    slotTextRawLen: Number((out.metaForSave as any)?.extra?.slotTextRawLen ?? null),
    bodyNowLen: bodyNow.length,
    bodyNowHead: bodyNow.slice(0, 40),
    shouldRunWriter,
    hasSlotsLocal,
    disableRephraseBridgeWriter,
  });

  // ✅ writer を抑止したことを meta に刻む（後でログ追跡しやすい）
  if (!alreadyHasBlocks && disableRephraseBridgeWriter) {
    try {
      (out.metaForSave as any).extra.rephraseBridgeSkipped = true;
      (out.metaForSave as any).extra.rephraseBridgeSkipReason =
        (out.metaForSave as any).extra.rephraseBridgeSkipReason ??
        'DISABLED_BY_RENDER_ENGINE_SINGLE_WRITER';
      (out.metaForSave as any).extra.rephraseBridgeSkipAt = new Date().toISOString();
    } catch {}
  }
}
// --- /DEBUG ---

if (shouldRunWriter) {
  // ✅ extra が無いと extractSlotsForRephrase が落ちるので保険
  out.metaForSave = out.metaForSave ?? ({} as any);
  out.metaForSave.extra = out.metaForSave.extra ?? ({} as any);

  const fp0 = (out.metaForSave as any)?.framePlan ?? null;
  const sp0 = (out.metaForSave as any)?.slotPlan ?? null;

  // ------------------------------------------------------------
  // ctxPack bridge (handleIrosReply → rephrase)
  // 目的：
  // - rephrase の opts.userContext.ctxPack へ確実に渡す
  // - TOPIC_DIGEST が (none) にならないよう最低限埋める
  // - ✅ q/depth/phase を “正本” として ctxPack に stamp（pickedPhase のブレ止め）
  // ------------------------------------------------------------
  {
    const exAny = (out.metaForSave as any).extra;

    // ctxPack の器を保証
    if (!exAny.ctxPack || typeof exAny.ctxPack !== 'object') exAny.ctxPack = {};
    const ctxPack = exAny.ctxPack as any;
    try {
      const exAny0 = (out.metaForSave as any)?.extra ?? {};
      const ctxp0 = exAny0?.ctxPack ?? null;

      // ✅ traceIdCanon はこの時点では未定義なので、その場で安全に作る
      const traceIdTmp: string | null = (() => {
        const v =
          (ctx as any)?.traceId ??
          (out.metaForSave as any)?.extra?.traceId ??
          (out.metaForSave as any)?.extra?.ctxPack?.traceId ??
          (out.metaForSave as any)?.traceId ??
          null;

        const s = typeof v === 'string' ? v.trim() : '';
        return s ? s : null;
      })();

      console.log('[IROS/REPHRASE_OPTS_PHASE_TRACE]', {
        traceId: traceIdTmp,

        // opts 直指定（最優先で拾われる）
        // ※ここは「渡してない」なら常に null のままでOK
        willPass_opts_phase: null,

        // userContext 側（ctxPack）
        ctxPack_phase: ctxp0?.phase ?? null,

        // metaForSave 側（正本）
        meta_phase: (out.metaForSave as any)?.phase ?? null,
      });
    } catch {}
    // ✅ 重要：rephraseEngine.full.ts が最優先で拾う経路（opts.userContext.ctxPack.*）に
    // q/depth/phase を毎回 stamp して「Inner 混入」を止める
    try {
      const qCanon =
        (out.metaForSave as any)?.qCode ??
        (out.metaForSave as any)?.q ??
        ctxPack.qCode ??
        null;

        const depthCanon =
        (out.metaForSave as any)?.depth_stage ??
        (out.metaForSave as any)?.depth ??
        (out.metaForSave as any)?.unified?.depth?.stage ??
        ctxPack.depthStage ??
        null;

      const phaseCanon =
        (out.metaForSave as any)?.phase ??
        ctxPack.phase ??
        null;

      const unifiedObserved =
        ((out.metaForSave as any)?.unified?.observed ??
          (out.metaForSave as any)?.extra?.unified?.observed ??
          null) as any;

          const primaryStageCanon =
          (out.metaForSave as any)?.primaryStage ??
          unifiedObserved?.primaryStage ??
          ctxPack.primaryStage ??
          null;

        const secondaryStageCanon =
          (out.metaForSave as any)?.secondaryStage ??
          unifiedObserved?.secondaryStage ??
          ctxPack.secondaryStage ??
          null;

        const observedStageCanon =
          (out.metaForSave as any)?.observedStage ??
          unifiedObserved?.observedStage ??
          ctxPack.observedStage ??
          null;

        const primaryBandCanon =
          (out.metaForSave as any)?.primaryBand ??
          unifiedObserved?.primaryBand ??
          ctxPack.primaryBand ??
          null;

        const secondaryBandCanon =
          (out.metaForSave as any)?.secondaryBand ??
          unifiedObserved?.secondaryBand ??
          ctxPack.secondaryBand ??
          null;

        const primaryDepthCanon =
          (out.metaForSave as any)?.primaryDepth ??
          unifiedObserved?.primaryDepth ??
          ctxPack.primaryDepth ??
          null;

        const secondaryDepthCanon =
          (out.metaForSave as any)?.secondaryDepth ??
          unifiedObserved?.secondaryDepth ??
          ctxPack.secondaryDepth ??
          null;

        const observedBasedOnCanon =
          (out.metaForSave as any)?.observedBasedOn ??
          unifiedObserved?.basedOn ??
          ctxPack.observedBasedOn ??
          null;

        const cardsCanon: any =
          ((out.metaForSave as any)?.extra?.ctxPack as any)?.cards ??
          ctxPack.cards ??
          null;

        const currentCardCanon: any =
          cardsCanon?.currentCard ??
          null;

        const observedStageCanonFixed =
          observedStageCanon ??
          (typeof currentCardCanon?.observedStage === 'string' && currentCardCanon.observedStage.trim()
            ? currentCardCanon.observedStage.trim()
            : typeof currentCardCanon?.stage === 'string' && currentCardCanon.stage.trim()
              ? currentCardCanon.stage.trim()
              : null);

        const primaryStageCanonFixed =
          primaryStageCanon ??
          observedStageCanonFixed ??
          null;

        const mirrorCanon: any =
          ((out.metaForSave as any)?.extra?.mirror ??
            (out.metaForSave as any)?.mirror ??
            null) as any;

        const polarityCanonFixed =
          (typeof mirrorCanon?.polarity_out === 'string' && mirrorCanon.polarity_out.trim()
            ? mirrorCanon.polarity_out.trim()
            : typeof mirrorCanon?.polarity === 'string' && mirrorCanon.polarity.trim()
              ? mirrorCanon.polarity.trim()
              : typeof currentCardCanon?.polarity === 'string' && currentCardCanon.polarity.trim()
                ? currentCardCanon.polarity.trim()
                : typeof (ctxPack as any)?.polarity === 'string' && (ctxPack as any).polarity.trim()
                  ? (ctxPack as any).polarity.trim()
                  : null);

        const normalizeStageList = (src: any): string[] => {
          if (!Array.isArray(src)) return [];
          return src
            .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
            .filter((v: string) => /^[SFRCIT][123]$/.test(v))
            .slice(-5);
        };

        const prevDepthHistoryLite = normalizeStageList(ctxPack.depthHistoryLite);

        const depthStageForHistory =
          typeof depthCanon === 'string' && /^[SFRCIT][123]$/.test(depthCanon.trim())
            ? depthCanon.trim()
            : null;

        const nextDepthHistoryLite =
          depthStageForHistory
            ? [...prevDepthHistoryLite, depthStageForHistory].slice(-5)
            : prevDepthHistoryLite;

        const depthStageBefore =
          prevDepthHistoryLite.length > 0 ? prevDepthHistoryLite[prevDepthHistoryLite.length - 1] : null;

        ctxPack.qCode = qCanon;
        ctxPack.depthStage = depthCanon;
        ctxPack.phase = phaseCanon;

        ctxPack.primaryStage = primaryStageCanonFixed;
        ctxPack.secondaryStage = secondaryStageCanon;
        ctxPack.observedStage = observedStageCanonFixed;

        ctxPack.primaryBand = primaryBandCanon;
        ctxPack.secondaryBand = secondaryBandCanon;

        ctxPack.primaryDepth = primaryDepthCanon;
        ctxPack.secondaryDepth = secondaryDepthCanon;

        ctxPack.observedBasedOn = observedBasedOnCanon;
        ctxPack.depthHistoryLite = nextDepthHistoryLite;
        (ctxPack as any).polarity = polarityCanonFixed;

        console.log('[IROS][CTXPACK][AFTER_CANON]', {
          traceId: traceId ?? null,
          conversationId,
          userCode,
          qCode: ctxPack.qCode ?? null,
          depthStage_before: depthStageBefore,
          observedStage: ctxPack.observedStage ?? null,
          depthStage_after: ctxPack.depthStage ?? null,
          phase: ctxPack.phase ?? null,
          primaryStage: ctxPack.primaryStage ?? null,
          secondaryStage: ctxPack.secondaryStage ?? null,
          primaryBand: ctxPack.primaryBand ?? null,
          secondaryBand: ctxPack.secondaryBand ?? null,
          primaryDepth: ctxPack.primaryDepth ?? null,
          secondaryDepth: ctxPack.secondaryDepth ?? null,
          observedBasedOn: ctxPack.observedBasedOn ?? null,
          depthHistoryLite: Array.isArray(ctxPack.depthHistoryLite)
            ? ctxPack.depthHistoryLite
            : null,
          polarity: (ctxPack as any).polarity ?? null,
        });
        const rotationStateCanon =
        ((out.metaForSave as any)?.rotationState ??
          (out.metaForSave as any)?.rotation ??
          null) as any;

      const willRotationReason =
        (typeof rotationStateCanon?.reason === 'string' && rotationStateCanon.reason.trim()
          ? rotationStateCanon.reason.trim()
          : typeof ctxPack.willRotation?.reason === 'string' && ctxPack.willRotation.reason.trim()
            ? ctxPack.willRotation.reason.trim()
            : null);

            const willRotationSuggestedStage =
            (rotationStateCanon?.shouldRotate === true &&
            typeof rotationStateCanon?.depth === 'string' &&
            rotationStateCanon.depth.trim()
              ? rotationStateCanon.depth.trim()
              : typeof ctxPack.willRotation?.suggestedStage === 'string' &&
                  ctxPack.willRotation.suggestedStage.trim()
                ? ctxPack.willRotation.suggestedStage.trim()
                : null);

      const willRotationSpinLoop =
        (typeof rotationStateCanon?.spinLoop === 'string' && rotationStateCanon.spinLoop.trim()
          ? rotationStateCanon.spinLoop.trim()
          : typeof ctxPack.willRotation?.spinLoop === 'string' && ctxPack.willRotation.spinLoop.trim()
            ? ctxPack.willRotation.spinLoop.trim()
            : null);

      const willRotationDescentGate =
        (typeof rotationStateCanon?.descentGate === 'string' && rotationStateCanon.descentGate.trim()
          ? rotationStateCanon.descentGate.trim()
          : typeof ctxPack.willRotation?.descentGate === 'string' &&
              ctxPack.willRotation.descentGate.trim()
            ? ctxPack.willRotation.descentGate.trim()
            : null);

      ctxPack.willRotation = {
        ...(ctxPack.willRotation && typeof ctxPack.willRotation === 'object' ? ctxPack.willRotation : {}),
        reason: willRotationReason,
        suggestedStage: willRotationSuggestedStage,
        spinLoop: willRotationSpinLoop,
        descentGate: willRotationDescentGate,
      };
    } catch {}
    // ✅ topicDigest を最低限確保（重い処理なし）
    // - conversationLine があるなら topicDigest にも入れる
    if (!ctxPack.topicDigest && ctxPack.conversationLine) {
      ctxPack.topicDigest = String(ctxPack.conversationLine);
    }

    // ✅ rephraseEngine.full.ts が拾いやすい経路にも示す
    if (!exAny.topicDigest && (ctxPack.topicDigest || ctxPack.conversationLine)) {
      exAny.topicDigest = String(ctxPack.topicDigest ?? ctxPack.conversationLine);
    }
    // ✅ PDF用の最小構造パック
    // - まだPDF生成はしない
    // - このターンで確定した構造だけを extra.pdfPack にまとめる
    const flowMeaningCanon =
      typeof exAny.flowMeaning === 'string' && exAny.flowMeaning.trim()
        ? exAny.flowMeaning.trim()
        : typeof exAny.flowDigest === 'string' && exAny.flowDigest.trim()
          ? exAny.flowDigest.trim()
          : null;

    const conversationLineCanon =
      typeof ctxPack.conversationLine === 'string' && ctxPack.conversationLine.trim()
        ? ctxPack.conversationLine.trim()
        : null;

    const topicDigestCanon =
      typeof ctxPack.topicDigest === 'string' && ctxPack.topicDigest.trim()
        ? ctxPack.topicDigest.trim()
        : typeof exAny.topicDigest === 'string' && exAny.topicDigest.trim()
          ? exAny.topicDigest.trim()
          : null;

    exAny.pdfPack = {
      depthStage:
        typeof ctxPack.depthStage === 'string' && ctxPack.depthStage.trim()
          ? ctxPack.depthStage.trim()
          : null,
      phase:
        typeof ctxPack.phase === 'string' && ctxPack.phase.trim()
          ? ctxPack.phase.trim()
          : null,
      qCode:
        typeof ctxPack.qCode === 'string' && ctxPack.qCode.trim()
          ? ctxPack.qCode.trim()
          : null,

      primaryStage:
        typeof ctxPack.primaryStage === 'string' && ctxPack.primaryStage.trim()
          ? ctxPack.primaryStage.trim()
          : null,
      secondaryStage:
        typeof ctxPack.secondaryStage === 'string' && ctxPack.secondaryStage.trim()
          ? ctxPack.secondaryStage.trim()
          : null,
      observedStage:
        typeof ctxPack.observedStage === 'string' && ctxPack.observedStage.trim()
          ? ctxPack.observedStage.trim()
          : null,
      observedBasedOn:
        typeof ctxPack.observedBasedOn === 'string' && ctxPack.observedBasedOn.trim()
          ? ctxPack.observedBasedOn.trim()
          : null,

      depthHistoryLite: Array.isArray(ctxPack.depthHistoryLite)
        ? ctxPack.depthHistoryLite
            .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
            .filter((v: string) => /^[SFRCIT][123]$/.test(v))
            .slice(-5)
        : [],

      flowMeaning: flowMeaningCanon,
      conversationLine: conversationLineCanon,
      topicDigest: topicDigestCanon,
    };

  }
  // --- TOPIC DIGEST TRACE (temporary) ---
  try {
    const exAny = (out.metaForSave as any)?.extra ?? {};
    const ctxp = exAny?.ctxPack ?? null;

    console.log('[IROS/TOPIC_TRACE][before_rephrase]', {
      conversationId: _conversationId ?? null,
      userCode: _userCode ?? null,
      hasExtra: !!exAny,
      ctxPackKeys: ctxp && typeof ctxp === 'object' ? Object.keys(ctxp).slice(0, 30) : null,
      conversationLine: typeof ctxp?.conversationLine === 'string' ? ctxp.conversationLine : null,
      topicDigest_extra: typeof exAny?.topicDigest === 'string' ? exAny.topicDigest : null,
      topicDigest_ctxPack: typeof ctxp?.topicDigest === 'string' ? ctxp.topicDigest : null,

      // ✅ 追加：phase ブレの観測（pickedPhase の原因特定）
      phase_ctxPack: typeof (ctxp as any)?.phase === 'string' ? (ctxp as any).phase : null,
      phase_metaForSave: (out.metaForSave as any)?.phase ?? null,
    });
  } catch {}
  // --- /TOPIC DIGEST TRACE ---
// --- /FIX ---

  const extracted = extractSlotsForRephrase({
    meta: out.metaForSave,
    framePlan: fp0,
    slotPlan: sp0,
    assistantText: out.assistantText ?? null,
    content: (out as any)?.content ?? null,
    text: (out as any)?.text ?? null,
    extra: out.metaForSave.extra,
    orch: { framePlan: fp0 },
  });

  const model = String(
    process.env.IROS_REPHRASE_FINAL_MODEL ?? process.env.IROS_MODEL ?? 'gpt-5',
  ).trim();

  const slotPlanPolicy =
    String((out.metaForSave as any)?.framePlan?.slotPlanPolicy ?? '')
      .trim()
      .toUpperCase() || null;

  // ✅ exprMeta（正本）は metaForSave.extra.exprMeta
  // - postprocess で決めるのが理想だが、ここでは「渡す」だけ（進行は変えない）
  const exprMetaCanon =
    ((out.metaForSave as any)?.extra?.exprMeta &&
      typeof (out.metaForSave as any).extra.exprMeta === 'object')
      ? (out.metaForSave as any).extra.exprMeta
      : null;

  // 検索しやすいログ（供給側）
  console.log('[IROS/EXPR_META][chosen]', {
    source: 'rephraseBridge',
    traceId: (ctx as any)?.traceId ?? (out.metaForSave as any)?.traceId ?? null,
    conversationId: _conversationId ?? null,
    userCode: _userCode ?? null,
    hasExprMeta: Boolean(exprMetaCanon),
    metaphor: exprMetaCanon ? String((exprMetaCanon as any).metaphor ?? '') : null,
  });

  // ✅ traceId をこの場で一回だけ正規化（以降はこれのみ使う）
  const traceIdCanon: string | null = (() => {
    const v =
      (ctx as any)?.traceId ??
      (out.metaForSave as any)?.extra?.traceId ??
      (out.metaForSave as any)?.extra?.ctxPack?.traceId ??
      (out.metaForSave as any)?.traceId ??
      null;

    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s : null;
  })();

  // ✅ inputKind をこの場で一回だけ正規化（rephraseEngine.full.ts の CARD_SEEDIN 判定は opts.inputKind を見る）
  const inputKindCanon: string | null = (() => {
    const raw =
      // まず “カード/診断系” の手掛かりになり得るものを優先
      (out.metaForSave as any)?.inputKind_classified ??
      (out.metaForSave as any)?.framePlan?.inputKind ??
      (out.metaForSave as any)?.extra?.ctxPack?.inputKind ??
      (out.metaForSave as any)?.extra?.inputKind ??
      null;

    const s0 = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (s0) return s0;

    // ctx.inputKind が "chat" しかない場合は、カードseedinのためには役に立たないので採用しない
    const ctxKind =
      typeof (ctx as any)?.inputKind === 'string' ? (ctx as any).inputKind.trim().toLowerCase() : '';
    if (ctxKind && ctxKind !== 'chat') return ctxKind;

    // ✅ 最後の確定：カード要求（日本語/英語）＋引く系を拾う
    const ut = typeof text === 'string' ? text.trim() : '';
    if (ut) {
      const hasCardWord = /カード|card/i.test(ut);
      const hasDrawWord =
        /引(?:い|き|く|け)|ひ(?:い|き|く|け)|引き直|引きなお|引き直し|引きなおし|引き直して|引きなおして/.test(
          ut,
        );

      // 初回：カード語があれば card
      if (hasCardWord) return 'card';

      // 継続：引く系だけでも card（ここで落とすと継続が死ぬ）
      if (hasDrawWord) return 'card';
    }

    return ctxKind || null;
  })();

  console.log('[IROS/GOALKIND_BRIDGE][BEFORE_REPHRASE_CALL]', {
    traceId: traceIdCanon,
    conversationId: _conversationId ?? null,
    userCode: _userCode ?? null,

    top_goalKind:
      (out.metaForSave as any)?.targetKind ??
      (out.metaForSave as any)?.target_kind ??
      null,

    userContext_goalKind: null,

    userContext_ctxPack_goalKind:
      ((out.metaForSave as any)?.extra?.ctxPack as any)?.goalKind ??
      (out.metaForSave as any)?.targetKind ??
      (out.metaForSave as any)?.target_kind ??
      null,

    userContext_ctxPack_replyGoal:
      ((out.metaForSave as any)?.extra?.ctxPack as any)?.replyGoal ?? null,
  });

  const rr = await rephraseSlotsFinal(
    extracted,
    {
      model,
      temperature: 0.7,

      // ✅ ここが本丸：rephraseEngine.full.ts の CARD_SEEDIN 判定は opts.inputKind を参照する
      inputKind: inputKindCanon,

      maxLinesHint: (() => {
        const exAny = (out.metaForSave as any)?.extra ?? {};

        // ✅ BlockPlan の“重い/内部用”だけ落とす
        // - blockPlan 本体（enabled/why/mode/blocks 等）は同一turnの最終 meta 確認に必要なので残す
        // - system 注入文そのものや内部メタだけ削除する
        try {
          if (exAny && typeof exAny === 'object') {
            delete (exAny as any).blockPlanText;
            delete (exAny as any).blockPlanEnabled;
            delete (exAny as any).blockPlanMeta;
          }
        } catch {}

        const rbLen = Array.isArray((exAny as any)?.rephraseBlocks)
          ? (exAny as any)?.rephraseBlocks.length
          : 0;

        const slotLen = Array.isArray((extracted as any)?.keys) ? (extracted as any)?.keys.length : 0;

        const basis = rbLen > 0 ? rbLen : slotLen > 0 ? slotLen : 4;
        const budget = Math.max(12, basis * 8);
        return Math.min(80, budget);
      })(),

      userText: typeof text === 'string' ? text : null,
      goalKind:
        ((out.metaForSave as any)?.extra?.ctxPack as any)?.goalKind ??
        (out.metaForSave as any)?.targetKind ??
        (out.metaForSave as any)?.target_kind ??
        null,

      extra: {
        ...(((out.metaForSave as any)?.extra ?? {}) as any),
        llmGate:
          (((out.metaForSave as any)?.extra?.llmGate &&
            typeof (out.metaForSave as any).extra.llmGate === 'object')
            ? (out.metaForSave as any).extra.llmGate
            : null) ??
          {
            contractObj:
              (((out.metaForSave as any)?.extra?.llmGate as any)?.contractObj &&
                typeof ((out.metaForSave as any)?.extra?.llmGate as any).contractObj === 'object')
                ? ((out.metaForSave as any).extra.llmGate as any).contractObj
                : null,
          },
        llmRewriteSeed:
          typeof (out.metaForSave as any)?.extra?.llmRewriteSeed === 'string'
            ? (out.metaForSave as any).extra.llmRewriteSeed
            : null,
        llmRewriteSeedRaw:
          typeof (out.metaForSave as any)?.extra?.llmRewriteSeedRaw === 'string'
            ? (out.metaForSave as any).extra.llmRewriteSeedRaw
            : null,
      },

      debug: {
        traceId: traceIdCanon,
        conversationId: _conversationId ?? null,
        userCode: _userCode ?? null,
        slotPlanPolicy,
        renderEngine: true,
        inputKind: inputKindCanon,
      } as any,

      userContext: await (async () => {
        console.log('[IROS/USER_CONTEXT][ENTER]', {
          traceId: traceIdCanon,
          conversationId: _conversationId ?? null,
          userCode: _userCode ?? null,
          hasHistoryForWriter: Array.isArray((out.metaForSave as any)?.extra?.historyForWriter),
        });

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

        const metaRoot = (out.metaForSave as any)?.meta ?? null;

        // ✅ ctxPack の継続値を受けるが、BlockPlan 系は“絶対に継続しない”
        const ctxPackPrevRaw: any = ((out.metaForSave as any)?.extra?.ctxPack ?? null) as any;
        try {
          console.log('[IROS/Reply][CTXPACK_REBUILD_INPUTS]', {
            traceId: traceIdCanon,
            conversationId: _conversationId ?? null,
            userCode: _userCode ?? null,

            out_meta_extra_ctxPack_willRotation:
              (out.metaForSave as any)?.extra?.ctxPack &&
              typeof (out.metaForSave as any).extra.ctxPack === 'object'
                ? ((out.metaForSave as any).extra.ctxPack as any).willRotation ?? null
                : null,

            ctxPackPrevRaw_willRotation:
              ctxPackPrevRaw && typeof ctxPackPrevRaw === 'object'
                ? (ctxPackPrevRaw as any).willRotation ?? null
                : null,
          });
        } catch {}
        const ctxPackPrev: any =
          ctxPackPrevRaw && typeof ctxPackPrevRaw === 'object' ? { ...ctxPackPrevRaw } : {};

        try {
          delete ctxPackPrev.blockPlan;
          delete ctxPackPrev.blockPlanText;
          delete ctxPackPrev.blockPlanEnabled;
          delete ctxPackPrev.blockPlanMeta;
          delete ctxPackPrev.blockPlanTrigger;
          delete ctxPackPrev.blockPlanTriggerText;
        } catch {}

        console.log('[IROS/LTM][PRE_ENTER]', {
          traceId: traceIdCanon,
          conversationId: _conversationId ?? null,
          userCode: _userCode ?? null,
          hasText: typeof text === 'string' && text.trim().length > 0,
          ctxPackKeys:
            out?.metaForSave?.extra?.ctxPack && typeof out.metaForSave.extra.ctxPack === 'object'
              ? Object.keys(out.metaForSave.extra.ctxPack)
              : [],
          extraKeys:
            out?.metaForSave?.extra && typeof out.metaForSave.extra === 'object'
              ? Object.keys(out.metaForSave.extra)
              : [],
        });

        const loadedMemoryState =
          typeof _userCode === 'string' && _userCode.trim().length > 0
            ? await loadIrosMemoryState(supabase as any, _userCode)
            : null;

        const memoryStateSnapshot = loadedMemoryState
          ? {
              intentAnchor: loadedMemoryState.intentAnchor ?? null,
              qPrimary: loadedMemoryState.qPrimary ?? null,
              depthStage: loadedMemoryState.depthStage ?? null,
              phase: loadedMemoryState.phase ?? null,
              selfAcceptance: loadedMemoryState.selfAcceptance ?? null,
              intentLayer: loadedMemoryState.intentLayer ?? null,
              intentConfidence: loadedMemoryState.intentConfidence ?? null,
              yLevel: loadedMemoryState.yLevel ?? null,
              hLevel: loadedMemoryState.hLevel ?? null,
              spinLoop: loadedMemoryState.spinLoop ?? null,
              spinStep: loadedMemoryState.spinStep ?? null,
              descentGate: loadedMemoryState.descentGate ?? null,
              itxStep: loadedMemoryState.itxStep ?? null,
              itxAnchorEventType: loadedMemoryState.itxAnchorEventType ?? null,
              itxReason: loadedMemoryState.itxReason ?? null,
              itxLastAt: loadedMemoryState.itxLastAt ?? null,
              summary: loadedMemoryState.summary ?? null,
              sentimentLevel: loadedMemoryState.sentimentLevel ?? null,
              situationSummary: loadedMemoryState.situationSummary ?? null,
              situationTopic: loadedMemoryState.situationTopic ?? null,
              updatedAt: loadedMemoryState.updatedAt ?? null,
            }
          : null;

        const memoryStateNoteText = memoryStateSnapshot
          ? [
              'MEMORY_STATE:',
              memoryStateSnapshot.summary
                ? `- summary: ${String(memoryStateSnapshot.summary).slice(0, 180)}`
                : null,
              memoryStateSnapshot.situationSummary
                ? `- situation_summary: ${String(memoryStateSnapshot.situationSummary).slice(0, 180)}`
                : null,
              memoryStateSnapshot.situationTopic
                ? `- situation_topic: ${String(memoryStateSnapshot.situationTopic).slice(0, 120)}`
                : null,
              memoryStateSnapshot.qPrimary
                ? `- q_primary: ${memoryStateSnapshot.qPrimary}`
                : null,
              memoryStateSnapshot.depthStage
                ? `- depth_stage: ${memoryStateSnapshot.depthStage}`
                : null,
              memoryStateSnapshot.phase
                ? `- phase: ${memoryStateSnapshot.phase}`
                : null,
              memoryStateSnapshot.intentLayer
                ? `- intent_layer: ${memoryStateSnapshot.intentLayer}`
                : null,
              memoryStateSnapshot.sentimentLevel
                ? `- sentiment_level: ${memoryStateSnapshot.sentimentLevel}`
                : null,
            ]
              .filter((v) => typeof v === 'string' && v.trim().length > 0)
              .join('\n')
          : null;
            console.log('[IROS/LTM][LOAD_ENTER]', {
              traceId: traceIdCanon,
              userCode: _userCode ?? null,
              hasText: typeof text === 'string' && text.trim().length > 0,
            });
        const longTermRows =
          typeof _userCode === 'string' && _userCode.trim().length > 0
            ? await loadDurableMemoriesForTurnV1({
                userCode: _userCode,
                limit: 12,
              })
            : [];

        const selectedLongTermRows = selectLongTermMemoriesV1({
          rows: longTermRows,
          userText: typeof text === 'string' ? text : '',
          maxItems: 4,
        });

        console.log('[IROS/LTM][BEFORE_BUILD]', {
          selectedCount: selectedLongTermRows?.length ?? 0,
          totalCount: longTermRows?.length ?? 0,
          selectedKeys: (selectedLongTermRows ?? []).map((r) => r.key),
        });

        const longTermBuilt = buildLongTermMemoryNoteTextV1({
          rows: selectedLongTermRows,
          maxItems: 4,
        });

        console.log('[IROS/LTM][AFTER_BUILD]', {
          pickedCount: longTermBuilt?.picked?.length ?? 0,
          pickedIds: (longTermBuilt?.picked ?? []).map((r) => r.id),
          noteTextLen:
            typeof longTermBuilt?.noteText === 'string'
              ? longTermBuilt.noteText.length
              : 0,
        });

        console.log('[IROS/LTM][BEFORE_PRIORITY]', {
          pickedCount: longTermBuilt?.picked?.length ?? 0,
        });

        await updateMemoryPriorityV1({
          rows: longTermBuilt.picked,
        });

        console.log('[IROS/LTM][AFTER_PRIORITY]', {
          pickedCount: longTermBuilt?.picked?.length ?? 0,
        });

        console.log('[IROS/LTM][BEFORE_DECAY]', {
          totalCount: longTermRows?.length ?? 0,
          usedRowIds: longTermBuilt.picked.map((r) => r.id),
        });

        await decayUnusedMemoriesV1({
          allRows: longTermRows,
          usedRowIds: longTermBuilt.picked.map((r) => r.id),
        });

        console.log('[IROS/LTM][AFTER_DECAY]', {
          totalCount: longTermRows?.length ?? 0,
          usedRowIds: longTermBuilt.picked.map((r) => r.id),
        });

        const longTermMemoryNoteText =
          typeof longTermBuilt.noteText === 'string' && longTermBuilt.noteText.trim().length > 0
            ? longTermBuilt.noteText
            : null;

        console.log('[IROS/LTM][SELECTED]', {
          count: selectedLongTermRows?.length ?? 0,
          keys: (selectedLongTermRows ?? []).map((r) => r.key),
          clusters: (selectedLongTermRows ?? []).map((r) => r.cluster_key),
          types: (selectedLongTermRows ?? []).map((r) => r.memory_type),
        });
        // ✅ LTM / MemoryState を route 側へ渡す正本
        out.metaForSave = out.metaForSave ?? {};
        (out.metaForSave as any).extra = (out.metaForSave as any).extra ?? {};

        const exAny: any = (out.metaForSave as any).extra;

        exAny.longTermMemoryNoteText = longTermMemoryNoteText;
        exAny.memoryStateNoteText = memoryStateNoteText;
        exAny.memoryStateSnapshot = memoryStateSnapshot;

        exAny.ctxPack = exAny.ctxPack && typeof exAny.ctxPack === 'object' ? exAny.ctxPack : {};
        exAny.ctxPack.longTermMemoryNoteText = longTermMemoryNoteText;
        exAny.ctxPack.memoryStateNoteText = memoryStateNoteText;
        exAny.ctxPack.memoryStateSnapshot = memoryStateSnapshot;

        console.log('[IROS/LTM][STAMPED_FOR_ROUTE]', {
          traceId: traceIdCanon,
          conversationId: _conversationId ?? null,
          userCode: _userCode ?? null,
          longTermMemoryNoteTextLen:
            typeof longTermMemoryNoteText === 'string' ? longTermMemoryNoteText.length : 0,
          memoryStateNoteTextLen:
            typeof memoryStateNoteText === 'string' ? memoryStateNoteText.length : 0,
          hasMemoryStateSnapshot: Boolean(memoryStateSnapshot),
          ctxPackKeys: Object.keys(exAny.ctxPack ?? {}),
        });
        console.log('[IROS/STATE][CTX_ATTACHED]', {
          userCode: _userCode ?? null,
          hasMemoryState: Boolean(memoryStateSnapshot),
          qPrimary: memoryStateSnapshot?.qPrimary ?? null,
          depthStage: memoryStateSnapshot?.depthStage ?? null,
          phase: memoryStateSnapshot?.phase ?? null,
          summaryHead:
            typeof memoryStateSnapshot?.summary === 'string'
              ? String(memoryStateSnapshot.summary).slice(0, 80)
              : null,
          selfAcceptance: memoryStateSnapshot?.selfAcceptance ?? null,
          intentLayer: memoryStateSnapshot?.intentLayer ?? null,
          sentimentLevel: memoryStateSnapshot?.sentimentLevel ?? null,
          situationSummaryHead:
            typeof memoryStateSnapshot?.situationSummary === 'string'
              ? String(memoryStateSnapshot.situationSummary).slice(0, 80)
              : null,
          situationTopic: memoryStateSnapshot?.situationTopic ?? null,
          hasMemoryStateNoteText: Boolean(memoryStateNoteText),
        });

        const shiftKindNow =
          String((out.metaForSave as any)?.extra?.ctxPack?.shiftKind ?? '').trim() || null;

        const pastStateTriggerKindNow =
          typeof (out.metaForSave as any)?.extra?.pastStateTriggerKind === 'string'
            ? String((out.metaForSave as any).extra.pastStateTriggerKind).trim()
            : null;

            const shouldHideHistoryForResponse =
            shiftKindNow === 'narrow_shift' ||
            shiftKindNow === 'stabilize_shift' ||
            pastStateTriggerKindNow === 'none';

          // UI表示用と、次ターン内部保持用を分離する
          const historyForWriterInternal =
            Array.isArray((out.metaForSave as any)?.extra?.historyForWriter)
              ? (out.metaForSave as any).extra.historyForWriter
              : Array.isArray((out.metaForSave as any)?.extra?.ctxPack?.historyForWriter)
                ? (out.metaForSave as any).extra.ctxPack.historyForWriter
                : Array.isArray(turns)
                  ? turns
                  : [];

                  const historyForWriterForResponse = shouldHideHistoryForResponse
                  ? []
                  : historyForWriterInternal;

                const historyForWriterAtInternal =
                  (out.metaForSave as any)?.extra?.historyForWriterAt ??
                  ((out.metaForSave as any)?.extra?.ctxPack as any)?.historyForWriterAt ??
                  (ctxPackPrev as any)?.historyForWriterAt ??
                  null;
                console.log('[IROS/USER_CONTEXT][EXIT_READY]', {
                  traceId: traceIdCanon,
                  conversationId: _conversationId ?? null,
                  userCode: _userCode ?? null,
                  hasMemoryStateNoteText: Boolean(memoryStateNoteText),
                  hasLongTermMemoryNoteText: Boolean(longTermMemoryNoteText),
                  selectedLongTermCount: selectedLongTermRows?.length ?? 0,
                });
                const historyDigestV1Internal =
                  (out.metaForSave as any)?.extra?.historyDigestV1 ??
                  ((out.metaForSave as any)?.extra?.ctxPack as any)?.historyDigestV1 ??
                  (ctxPackPrev as any)?.historyDigestV1 ??
                  null;

                return {
                  conversationId: _conversationId ?? null,
                  userCode: _userCode ?? null,
                  traceId: traceIdCanon,
                  inputKind: inputKindCanon,

                  exprMeta: exprMetaCanon,

                  pastStateNoteText:
                    typeof (out.metaForSave as any)?.extra?.pastStateNoteText === 'string'
                      ? (out.metaForSave as any).extra.pastStateNoteText
                      : null,

                  pastStateTriggerKind:
                    typeof (out.metaForSave as any)?.extra?.pastStateTriggerKind === 'string'
                      ? (out.metaForSave as any).extra.pastStateTriggerKind
                      : null,

                  pastStateKeyword:
                    typeof (out.metaForSave as any)?.extra?.pastStateKeyword === 'string'
                      ? (out.metaForSave as any).extra.pastStateKeyword
                      : null,

                  longTermMemoryNoteText,
                  memoryStateSnapshot,
                  memoryStateNoteText,

                  // ここは UI 向けだけ隠す
                  historyForWriter: historyForWriterForResponse,

                  ctxPack: {
                    ...(ctxPackPrev as any),
                    ...(((out.metaForSave as any)?.extra?.ctxPack ?? {}) as any),

                    qCode:
                      (out.metaForSave as any)?.q ??
                      (out.metaForSave as any)?.qCode ??
                      memoryStateSnapshot?.qPrimary ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.qCode ??
                      (ctxPackPrev as any)?.qCode ??
                      null,

                      depthStage:
                      (out.metaForSave as any)?.depth_stage ??
                      (out.metaForSave as any)?.depth ??
                      (out.metaForSave as any)?.unified?.depth?.stage ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.depthStage ??
                      (ctxPackPrev as any)?.depthStage ??
                      memoryStateSnapshot?.depthStage ??
                      null,
                    phase:
                      (out.metaForSave as any)?.phase ??
                      memoryStateSnapshot?.phase ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.phase ??
                      (ctxPackPrev as any)?.phase ??
                      null,

                    primaryStage:
                      (out.metaForSave as any)?.primaryStage ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryStage ??
                      (ctxPackPrev as any)?.primaryStage ??
                      null,

                    secondaryStage:
                      (out.metaForSave as any)?.secondaryStage ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryStage ??
                      (ctxPackPrev as any)?.secondaryStage ??
                      null,

                      observedStage:
                      (out.metaForSave as any)?.observedStage ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.observedStage ??
                      (((out.metaForSave as any)?.extra?.ctxPack as any)?.cards?.currentCard as any)?.observedStage ??
                      (((out.metaForSave as any)?.extra?.ctxPack as any)?.cards?.currentCard as any)?.stage ??
                      ((ctxPackPrev as any)?.cards?.currentCard as any)?.observedStage ??
                      ((ctxPackPrev as any)?.cards?.currentCard as any)?.stage ??
                      (ctxPackPrev as any)?.observedStage ??
                      null,

                    primaryBand:
                      (out.metaForSave as any)?.primaryBand ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryBand ??
                      (ctxPackPrev as any)?.primaryBand ??
                      null,

                    secondaryBand:
                      (out.metaForSave as any)?.secondaryBand ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryBand ??
                      (ctxPackPrev as any)?.secondaryBand ??
                      null,

                      goalKind:
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.goalKind ??
                      (out.metaForSave as any)?.targetKind ??
                      (out.metaForSave as any)?.target_kind ??
                      (ctxPackPrev as any)?.goalKind ??
                      null,

                    primaryDepth:
                      (out.metaForSave as any)?.primaryDepth ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryDepth ??
                      (ctxPackPrev as any)?.primaryDepth ??
                      null,

                    secondaryDepth:
                      (out.metaForSave as any)?.secondaryDepth ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryDepth ??
                      (ctxPackPrev as any)?.secondaryDepth ??
                      null,

                    observedBasedOn:
                      (out.metaForSave as any)?.observedBasedOn ??
                      ((out.metaForSave as any)?.extra?.ctxPack as any)?.observedBasedOn ??
                      (ctxPackPrev as any)?.observedBasedOn ??
                      null,

                      depthHistoryLite:
                      Array.isArray(((out.metaForSave as any)?.extra?.ctxPack as any)?.depthHistoryLite)
                        ? ((out.metaForSave as any).extra.ctxPack as any).depthHistoryLite
                        : Array.isArray((ctxPackPrev as any)?.depthHistoryLite)
                          ? (ctxPackPrev as any).depthHistoryLite
                          : ((
                              (out.metaForSave as any)?.depth_stage ??
                              (out.metaForSave as any)?.depth ??
                              (out.metaForSave as any)?.unified?.depth?.stage ??
                              ((out.metaForSave as any)?.extra?.ctxPack as any)?.depthStage ??
                              (ctxPackPrev as any)?.depthStage ??
                              memoryStateSnapshot?.depthStage ??
                              null
                            ) &&
                            /^[SFRCIT][123]$/.test(
                              String(
                                (out.metaForSave as any)?.depth_stage ??
                                (out.metaForSave as any)?.depth ??
                                (out.metaForSave as any)?.unified?.depth?.stage ??
                                ((out.metaForSave as any)?.extra?.ctxPack as any)?.depthStage ??
                                (ctxPackPrev as any)?.depthStage ??
                                memoryStateSnapshot?.depthStage ??
                                ''
                              ).trim()
                            ))
                          ? [
                              String(
                                (out.metaForSave as any)?.depth_stage ??
                                (out.metaForSave as any)?.depth ??
                                (out.metaForSave as any)?.unified?.depth?.stage ??
                                ((out.metaForSave as any)?.extra?.ctxPack as any)?.depthStage ??
                                (ctxPackPrev as any)?.depthStage ??
                                memoryStateSnapshot?.depthStage
                              ).trim(),
                            ]
                          : [],
                          e_turn:
                          (out.metaForSave as any)?.extra?.e_turn ??
                          ((out.metaForSave as any)?.extra?.mirror as any)?.e_turn ??
                          ((out.metaForSave as any)?.extra?.ctxPack as any)?.e_turn ??
                          ((ctxPackPrev as any)?.mirror as any)?.e_turn ??
                          (ctxPackPrev as any)?.e_turn ??
                          null,

                        polarity:
                          ((out.metaForSave as any)?.extra?.mirror as any)?.polarity_out ??
                          ((out.metaForSave as any)?.extra?.mirror as any)?.polarity ??
                          ((out.metaForSave as any)?.mirror as any)?.polarity_out ??
                          ((out.metaForSave as any)?.mirror as any)?.polarity ??
                          ((out.metaForSave as any)?.extra?.polarity as any) ??
                          ((out.metaForSave as any)?.extra?.ctxPack as any)?.polarity ??
                          (((out.metaForSave as any)?.extra?.ctxPack as any)?.cards?.currentCard as any)?.polarity ??
                          ((ctxPackPrev as any)?.cards?.currentCard as any)?.polarity ??
                          ((ctxPackPrev as any)?.mirror as any)?.polarity ??
                          (ctxPackPrev as any)?.polarity ??
                          null,

                        mirror: {
                          ...((((ctxPackPrev as any)?.mirror &&
                            typeof (ctxPackPrev as any).mirror === 'object')
                            ? (ctxPackPrev as any).mirror
                            : {}) as any),
                          ...((((out.metaForSave as any)?.extra?.mirror &&
                            typeof (out.metaForSave as any).extra.mirror === 'object')
                            ? (out.metaForSave as any).extra.mirror
                            : {}) as any),
                          e_turn:
                            (out.metaForSave as any)?.extra?.e_turn ??
                            ((out.metaForSave as any)?.extra?.mirror as any)?.e_turn ??
                            ((out.metaForSave as any)?.extra?.ctxPack as any)?.e_turn ??
                            ((ctxPackPrev as any)?.mirror as any)?.e_turn ??
                            (ctxPackPrev as any)?.e_turn ??
                            null,
                          polarity:
                            ((out.metaForSave as any)?.extra?.mirror as any)?.polarity_out ??
                            ((out.metaForSave as any)?.extra?.mirror as any)?.polarity ??
                            ((out.metaForSave as any)?.mirror as any)?.polarity_out ??
                            ((out.metaForSave as any)?.mirror as any)?.polarity ??
                            ((out.metaForSave as any)?.extra?.polarity as any) ??
                            ((out.metaForSave as any)?.extra?.ctxPack as any)?.polarity ??
                            ((ctxPackPrev as any)?.mirror as any)?.polarity ??
                            (ctxPackPrev as any)?.polarity ??
                            null,
                        },

                    willRotation:
                      (((out.metaForSave as any)?.extra?.ctxPack as any)?.willRotation &&
                      typeof ((out.metaForSave as any)?.extra?.ctxPack as any).willRotation === 'object')
                        ? ((out.metaForSave as any).extra.ctxPack as any).willRotation
                        : ((ctxPackPrev as any)?.willRotation &&
                            typeof (ctxPackPrev as any).willRotation === 'object')
                          ? (ctxPackPrev as any).willRotation
                          : null,

                          traceId: traceIdCanon,
                          inputKind: inputKindCanon,

                          // UIでは隠しても、次ターン内部用は保持する
                          historyForWriter: historyForWriterInternal,
                          historyForWriterAt: historyForWriterAtInternal,
                          historyDigestV1: historyDigestV1Internal,

                          slotPlanPolicy,
                          exprMeta: exprMetaCanon,
                          longTermMemoryNoteText,
                          memoryStateNoteText,

                          memoryStateSnapshot,
                          memoryStateSummary: memoryStateSnapshot?.summary ?? null,
                          memoryStateSituationSummary: memoryStateSnapshot?.situationSummary ?? null,
                          memoryStateSituationTopic: memoryStateSnapshot?.situationTopic ?? null,

                          // ✅ LLM_GATE / rewriteSeed を rephrase 側へ橋渡しする正本
                          llmGate:
                            ((out.metaForSave as any)?.extra?.llmGate &&
                            typeof (out.metaForSave as any).extra.llmGate === 'object')
                              ? ((out.metaForSave as any).extra.llmGate as any)
                              : ((ctxPackPrev as any)?.llmGate &&
                                  typeof (ctxPackPrev as any).llmGate === 'object')
                                ? ((ctxPackPrev as any).llmGate as any)
                                : null,

                          llmRewriteSeedRaw:
                            typeof (out.metaForSave as any)?.extra?.llmRewriteSeedRaw === 'string'
                              ? (out.metaForSave as any).extra.llmRewriteSeedRaw
                              : typeof ((out.metaForSave as any)?.extra?.ctxPack as any)?.llmRewriteSeedRaw === 'string'
                                ? ((out.metaForSave as any).extra.ctxPack as any).llmRewriteSeedRaw
                                : typeof (ctxPackPrev as any)?.llmRewriteSeedRaw === 'string'
                                  ? (ctxPackPrev as any).llmRewriteSeedRaw
                                  : null,

                          llmRewriteSeed:
                            typeof (out.metaForSave as any)?.extra?.llmRewriteSeed === 'string'
                              ? (out.metaForSave as any).extra.llmRewriteSeed
                              : typeof ((out.metaForSave as any)?.extra?.ctxPack as any)?.llmRewriteSeed === 'string'
                                ? ((out.metaForSave as any).extra.ctxPack as any).llmRewriteSeed
                                : typeof (ctxPackPrev as any)?.llmRewriteSeed === 'string'
                                  ? (ctxPackPrev as any).llmRewriteSeed
                                  : null,
                        },
                  slotPlanPolicy,

                  flowDigest: (out.metaForSave as any)?.extra?.flowDigest ?? null,
                  flowTape: (out.metaForSave as any)?.extra?.flowTape ?? null,

                  meta: {
                    q: (out.metaForSave as any)?.q ?? metaRoot?.q ?? null,
                    depth: (out.metaForSave as any)?.depth ?? metaRoot?.depth ?? null,
                    phase: (out.metaForSave as any)?.phase ?? metaRoot?.phase ?? null,
                    layer: (out.metaForSave as any)?.intentLayer ?? metaRoot?.intentLayer ?? null,
                    renderMode: (out.metaForSave as any)?.renderMode ?? metaRoot?.renderMode ?? null,
                    slotPlanPolicy,
                    extra: {
                      ...((((out.metaForSave as any)?.extra &&
                        typeof (out.metaForSave as any).extra === 'object')
                        ? (out.metaForSave as any).extra
                        : {})),
                      llmGate:
                        ((out.metaForSave as any)?.extra?.llmGate &&
                        typeof (out.metaForSave as any).extra.llmGate === 'object')
                          ? ((out.metaForSave as any).extra.llmGate as any)
                          : ((ctxPackPrev as any)?.llmGate &&
                              typeof (ctxPackPrev as any).llmGate === 'object')
                            ? ((ctxPackPrev as any).llmGate as any)
                            : null,
                      llmRewriteSeed:
                        typeof (out.metaForSave as any)?.extra?.llmRewriteSeed === 'string'
                          ? (out.metaForSave as any).extra.llmRewriteSeed
                          : typeof ((out.metaForSave as any)?.extra?.ctxPack as any)?.llmRewriteSeed === 'string'
                            ? ((out.metaForSave as any).extra.ctxPack as any).llmRewriteSeed
                            : typeof (ctxPackPrev as any)?.llmRewriteSeed === 'string'
                              ? (ctxPackPrev as any).llmRewriteSeed
                              : null,
                      llmRewriteSeedRaw:
                        typeof (out.metaForSave as any)?.extra?.llmRewriteSeedRaw === 'string'
                          ? (out.metaForSave as any).extra.llmRewriteSeedRaw
                          : typeof ((out.metaForSave as any)?.extra?.ctxPack as any)?.llmRewriteSeedRaw === 'string'
                            ? ((out.metaForSave as any).extra.ctxPack as any).llmRewriteSeedRaw
                            : typeof (ctxPackPrev as any)?.llmRewriteSeedRaw === 'string'
                              ? (ctxPackPrev as any).llmRewriteSeedRaw
                              : null,
                      slotPlanSeed:
                        typeof (out.metaForSave as any)?.extra?.slotPlanSeed === 'string'
                          ? (out.metaForSave as any).extra.slotPlanSeed
                          : typeof ((out.metaForSave as any)?.extra?.ctxPack as any)?.slotPlanSeed === 'string'
                            ? ((out.metaForSave as any).extra.ctxPack as any).slotPlanSeed
                            : typeof (ctxPackPrev as any)?.slotPlanSeed === 'string'
                              ? (ctxPackPrev as any).slotPlanSeed
                              : null,
                      finalTextPolicy:
                        typeof (out.metaForSave as any)?.extra?.finalTextPolicy === 'string'
                          ? (out.metaForSave as any).extra.finalTextPolicy
                          : null,
                    },
                    ctxPack: {
                      ...(ctxPackPrev as any),
                      ...(((out.metaForSave as any)?.extra?.ctxPack ?? {}) as any),

                      qCode:
                        (out.metaForSave as any)?.q ??
                        (out.metaForSave as any)?.qCode ??
                        memoryStateSnapshot?.qPrimary ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.qCode ??
                        (ctxPackPrev as any)?.qCode ??
                        null,

                        depthStage:
                        (out.metaForSave as any)?.depth_stage ??
                        (out.metaForSave as any)?.depth ??
                        (out.metaForSave as any)?.unified?.depth?.stage ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.depthStage ??
                        (ctxPackPrev as any)?.depthStage ??
                        memoryStateSnapshot?.depthStage ??
                        null,

                      phase:
                        (out.metaForSave as any)?.phase ??
                        memoryStateSnapshot?.phase ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.phase ??
                        (ctxPackPrev as any)?.phase ??
                        null,

                      primaryStage:
                        (out.metaForSave as any)?.primaryStage ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryStage ??
                        (ctxPackPrev as any)?.primaryStage ??
                        null,

                      secondaryStage:
                        (out.metaForSave as any)?.secondaryStage ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryStage ??
                        (ctxPackPrev as any)?.secondaryStage ??
                        null,

                      observedStage:
                        (out.metaForSave as any)?.observedStage ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.observedStage ??
                        (ctxPackPrev as any)?.observedStage ??
                        null,

                      primaryBand:
                        (out.metaForSave as any)?.primaryBand ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryBand ??
                        (ctxPackPrev as any)?.primaryBand ??
                        null,

                      secondaryBand:
                        (out.metaForSave as any)?.secondaryBand ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryBand ??
                        (ctxPackPrev as any)?.secondaryBand ??
                        null,

                        goalKind:
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.goalKind ??
                        (out.metaForSave as any)?.targetKind ??
                        (out.metaForSave as any)?.target_kind ??
                        (ctxPackPrev as any)?.goalKind ??
                        null,

                      primaryDepth:
                        (out.metaForSave as any)?.primaryDepth ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.primaryDepth ??
                        (ctxPackPrev as any)?.primaryDepth ??
                        null,

                      secondaryDepth:
                        (out.metaForSave as any)?.secondaryDepth ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.secondaryDepth ??
                        (ctxPackPrev as any)?.secondaryDepth ??
                        null,

                      observedBasedOn:
                        (out.metaForSave as any)?.observedBasedOn ??
                        ((out.metaForSave as any)?.extra?.ctxPack as any)?.observedBasedOn ??
                        (ctxPackPrev as any)?.observedBasedOn ??
                        null,

                      depthHistoryLite:
                        Array.isArray(((out.metaForSave as any)?.extra?.ctxPack as any)?.depthHistoryLite)
                          ? ((out.metaForSave as any).extra.ctxPack as any).depthHistoryLite
                          : Array.isArray((ctxPackPrev as any)?.depthHistoryLite)
                            ? (ctxPackPrev as any).depthHistoryLite
                            : [],

                      willRotation:
                        (((out.metaForSave as any)?.extra?.ctxPack as any)?.willRotation &&
                        typeof ((out.metaForSave as any)?.extra?.ctxPack as any).willRotation === 'object')
                          ? ((out.metaForSave as any).extra.ctxPack as any).willRotation
                          : ((ctxPackPrev as any)?.willRotation &&
                              typeof (ctxPackPrev as any).willRotation === 'object')
                            ? (ctxPackPrev as any).willRotation
                            : null,

                      traceId: traceIdCanon,
                      inputKind: inputKindCanon,
                      historyForWriter: historyForWriterInternal,
                      historyForWriterAt: historyForWriterAtInternal,
                      historyDigestV1: historyDigestV1Internal,
                      slotPlanPolicy,
                      exprMeta: exprMetaCanon,
                      longTermMemoryNoteText,
                      memoryStateNoteText,
                      memoryStateSnapshot,
                      memoryStateSummary: memoryStateSnapshot?.summary ?? null,
                      memoryStateSituationSummary: memoryStateSnapshot?.situationSummary ?? null,
                      memoryStateSituationTopic: memoryStateSnapshot?.situationTopic ?? null,
                    },
                  },
                };
              })(),
          } as any,
        );
          if (rr && rr.ok) {
            const mx = (rr as any)?.meta?.extra ?? {};
            const blocksCandidate =
              (rr as any)?.rephraseBlocks ?? mx?.rephraseBlocks ?? mx?.rephrase?.blocks ?? null;
            // ✅ rephrase 後の blockPlan を正本として metaForSave.extra に戻す
            if (mx?.blockPlan && typeof mx.blockPlan === 'object') {
              (out.metaForSave as any).extra.blockPlan = {
                ...mx.blockPlan,
                bridgedBy: 'handleIrosReply.rephraseBridge',
                bridgedAt: new Date().toISOString(),
              };
            }
            try {
              console.log('[IROS/rephraseBridge][RR_KEYS]', {
                rr_keys: rr && typeof rr === 'object' ? Object.keys(rr as any) : [],
                rr_meta_keys:
                  (rr as any)?.meta && typeof (rr as any).meta === 'object'
                    ? Object.keys((rr as any).meta)
                    : [],
                rr_meta_extra_keys:
                  (rr as any)?.meta?.extra && typeof (rr as any).meta.extra === 'object'
                    ? Object.keys((rr as any).meta.extra)
                    : [],
                rr_metaForSave_extra_keys:
                  (rr as any)?.metaForSave?.extra && typeof (rr as any).metaForSave.extra === 'object'
                    ? Object.keys((rr as any).metaForSave.extra)
                    : [],
                has_blockPlan_in_meta_extra: Boolean((rr as any)?.meta?.extra?.blockPlan),
                has_blockPlan_in_metaForSave_extra: Boolean((rr as any)?.metaForSave?.extra?.blockPlan),
              });
            } catch {}
            if (mx?.blockPlanMode != null && (out.metaForSave as any).extra.blockPlanMode == null) {
              (out.metaForSave as any).extra.blockPlanMode = mx.blockPlanMode;
            }
            // ✅ Expression preface を rephraseBlocks にも反映して、UI/保存のズレを消す
            const pickPreface = (): string => {
              const raw =
                (ex as any)?.expr?.prefaceLine ??
                (ex as any)?.expr?.prefaceHead ??
                (ex as any)?.expression?.prefaceLine ??
                (ex as any)?.expressionDecision?.prefaceLine ??
                (ex as any)?.exprPrefaceLine ??
                null;

              const s = String(raw ?? '').replace(/\r\n/g, '\n').trim();
              if (!s) return '';
              // 1行化（rephraseBlocks は block 意図を持つが、preface は必ず1行にする）
              return s.split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
            };

            const preface = pickPreface();

            if (Array.isArray(blocksCandidate) && blocksCandidate.length > 0) {
              // 先頭ブロックと同文なら二重付与しない
              const firstText = String((blocksCandidate[0] as any)?.text ?? '')
                .replace(/\r\n/g, '\n')
                .trim();
              const sameAsFirst = preface && firstText && firstText === preface;

              const mergedBlocks =
                preface && !sameAsFirst
                  ? [{ text: preface, kind: 'p' }, ...blocksCandidate]
                  : blocksCandidate;

              (out.metaForSave as any).extra.rephraseBlocks = mergedBlocks;
              // ✅ traceId を刻む（次ターンで stale 判定に使う）
              (out.metaForSave as any).extra.rephraseBlocksTraceId = traceIdCanon;
            } else if (preface) {
              // blocks が空でも preface だけは渡せる（安全側）
              (out.metaForSave as any).extra.rephraseBlocks = [{ text: preface, kind: 'p' }];
              // ✅ traceId を刻む（次ターンで stale 判定に使う）
              (out.metaForSave as any).extra.rephraseBlocksTraceId = traceIdCanon;
            }

            (out.metaForSave as any).extra.rephraseApplied = true;
            (out.metaForSave as any).extra.rephraseLLMApplied = true;
            (out.metaForSave as any).extra.rephraseReason =
              (out.metaForSave as any).extra.rephraseReason ?? 'rephraseSlotsFinal(emptyLike)';
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
  // ✅ route.ts から渡される extra（SoT）を metaForSave に反映（IT/renderMode系）
  // - 既存を不用意に上書きしない（未設定のみ埋める）
  // - root(renderMode) と extra.renderMode のズレを最終的に揃える
  try {
    const exIn: any =
      (typeof (extra as any) === 'object' && extra) ||
      ((ctx as any)?.extra && typeof (ctx as any).extra === 'object' ? (ctx as any).extra : null);

    if (exIn) {
      out.metaForSave = out.metaForSave ?? {};
      (out.metaForSave as any).extra = (out.metaForSave as any).extra ?? {};

      const dst: any = (out.metaForSave as any).extra;

      // 1) extra の IT系ヒント（未設定のみ埋める）
      const copyIfUnset = (k: string) => {
        if (dst[k] == null && exIn[k] != null) dst[k] = exIn[k];
      };

      copyIfUnset('forceIT');
      copyIfUnset('itDensity');
      copyIfUnset('itNaturalReason');
      copyIfUnset('itNaturalNotes');
      copyIfUnset('itReason');
      copyIfUnset('itEvidence');

      // renderMode は root と extra の両方に存在しうるので両面で扱う
      if (dst.renderMode == null && typeof exIn.renderMode === 'string') dst.renderMode = exIn.renderMode;
      if ((out.metaForSave as any).renderMode == null && typeof exIn.renderMode === 'string') {
        (out.metaForSave as any).renderMode = exIn.renderMode;
      }

      // 2) 最終整合：root(renderMode) と extra.renderMode を揃える
      const rootRM = (out.metaForSave as any).renderMode;
      const exRM = dst.renderMode;

      // root が無いが extra にある → root へ
      if (rootRM == null && typeof exRM === 'string') {
        (out.metaForSave as any).renderMode = exRM;
      }

      // extra が無いが root にある → extra へ
      if (dst.renderMode == null && typeof (out.metaForSave as any).renderMode === 'string') {
        dst.renderMode = (out.metaForSave as any).renderMode;
      }

      // 3) デバッグログ（必要最低限）
      if (exIn.renderMode != null || exIn.forceIT != null) {
        console.log('[IROS/Reply][IT_META_MERGE]', {
          in_renderMode: exIn.renderMode ?? null,
          in_forceIT: exIn.forceIT ?? null,
          out_renderMode: (out.metaForSave as any).renderMode ?? null,
          out_extra_renderMode: dst.renderMode ?? null,
          out_forceIT: dst.forceIT ?? null,
        });
      }
    }
  } catch (e) {
    console.warn('[IROS/Reply][IT_META_MERGE][ERROR]', e);
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
// ✅ PDF用の最終構造パック（persist直前の正本）
{
  out.metaForSave = out.metaForSave ?? {};
  (out.metaForSave as any).extra = (out.metaForSave as any).extra ?? {};

  const mf: any = out.metaForSave as any;
  const ex: any = mf.extra as any;
  const cp: any = ex.ctxPack && typeof ex.ctxPack === 'object' ? ex.ctxPack : {};
  const unifiedObserved: any =
    mf?.unified?.observed ??
    ex?.unified?.observed ??
    null;

  const pickText = (...vals: any[]): string | null => {
    for (const v of vals) {
      if (typeof v === 'string') {
        const s = v.trim();
        if (s) return s;
      }
    }
    return null;
  };

  const pickStage = (...vals: any[]): string | null => {
    for (const v of vals) {
      if (typeof v === 'string') {
        const s = v.trim().toUpperCase();
        if (/^[SFRCIT][123]$/.test(s)) return s;
      }
    }
    return null;
  };

  const pickDepthHistoryLite = (...vals: any[]): string[] => {
    for (const v of vals) {
      if (Array.isArray(v)) {
        return v
          .map((x: any) => (typeof x === 'string' ? x.trim().toUpperCase() : ''))
          .filter((x: string) => /^[SFRCIT][123]$/.test(x))
          .slice(-5);
      }
    }
    return [];
  };

  const flowMeaningCanon =
    pickText(
      ex?.flowMeaning,
      ex?.flowDigest,
    );

  const conversationLineCanon =
    pickText(
      cp?.conversationLine,
      ex?.conversationLine,
    );

  const topicDigestCanon =
    pickText(
      cp?.topicDigest,
      ex?.topicDigest,
      conversationLineCanon,
    );

    ex.pdfPack = {
      depthStage: pickStage(
        mf?.depth_stage,
        mf?.depth,
        mf?.unified?.depth?.stage,
        ex?.unified?.depth?.stage,
        cp?.depthStage,
        cp?.depth,
        mf?.depthStage,
      ),
      phase: pickText(
        mf?.phase,
        cp?.phase,
      ),
      qCode: pickText(
        mf?.qCode,
        mf?.q_code,
        mf?.q,
        cp?.qCode,
        cp?.q_code,
        cp?.q,
      ),

      primaryStage: pickStage(
        mf?.primaryStage,
        cp?.primaryStage,
        unifiedObserved?.primaryStage,
      ),
      secondaryStage: pickStage(
        mf?.secondaryStage,
        cp?.secondaryStage,
        unifiedObserved?.secondaryStage,
      ),
      observedStage: pickStage(
        mf?.observedStage,
        cp?.observedStage,
        unifiedObserved?.observedStage,
      ),
      observedBasedOn: pickText(
        mf?.observedBasedOn,
        cp?.observedBasedOn,
        unifiedObserved?.basedOn,
      ),

      depthHistoryLite: pickDepthHistoryLite(
        cp?.depthHistoryLite,
        ex?.depthHistoryLite,
      ),

      flowMeaning: flowMeaningCanon,
      conversationLine: conversationLineCanon,
      topicDigest: topicDigestCanon,
    };
}
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

// ✅ ここ以降の persist は “CANON後の meta” を正本として使う
// - いまの症状（CANONはS2なのに persist がS1になる）は、
//   persist に古い metaForSave を渡しているのが原因
const metaForSaveFinal: any = (out as any)?.metaForSave ?? metaForSave;

await persistIntentAnchorIfAny({
  supabase,
  userCode,
  metaForSave: metaForSaveFinal,
});
t.persist_ms.intent_anchor_ms = msSince(t2);

// =========================================================
// ✅ itTriggered は「boolean のときだけ渡す」
// - 不明(undefined/null)を false に丸めない
// - さらに「null混入」をここで確実に除去する
// =========================================================
const itTriggeredForPersistRaw: unknown =
  (out as any)?.metaForSave?.itTriggered ??
  (out as any)?.metaForSave?.it_triggered ??
  (metaForSave as any)?.itTriggered ??
  (metaForSave as any)?.it_triggered ??
  (orch as any)?.meta?.itTriggered ??
  (orch as any)?.meta?.it_triggered ??
  undefined;

// ✅ “boolean 以外” は全部 undefined（=不明）にする。null も落ちる。
const itTriggeredForPersist: boolean | undefined =
  typeof itTriggeredForPersistRaw === 'boolean' ? itTriggeredForPersistRaw : undefined;

// ✅ 任意：q_counts も “あるときだけ” 渡す（persist側で最終mergeされる）
const qCountsForPersist: unknown | undefined =
  (metaForSave as any)?.q_counts ??
  (out as any)?.metaForSave?.q_counts ??
  (orch as any)?.meta?.q_counts ??
  undefined;

// =========================================================
// ✅ anchorEntry decision を metaForSave から拾って persist に渡す
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
  metaForSave: metaForSaveFinal,
  qCounts: qCountsForPersist,
  itTriggered: itTriggeredForPersist, // ✅ ここが本命
  anchorEntry_decision: anchorEntryDecisionForPersist,
} as any);
t.persist_ms.memory_state_ms = msSince(t3);

const t4 = nowNs();
await persistUnifiedAnalysisIfAny({
  supabase,
  userCode,
  tenantId,
  userText: text,
  assistantText: out.assistantText,
  metaForSave: metaForSaveFinal,
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

try {
  console.log('[IROS/Reply][FINAL_META_CTXPACK_WILLROTATION]', {
    conversationId,
    userCode,

    metaForSave_extra_ctxPack_willRotation:
      (out as any)?.metaForSave?.extra?.ctxPack?.willRotation ?? null,

    metaForSave_extra_ctxPack_keys:
      (out as any)?.metaForSave?.extra?.ctxPack &&
      typeof (out as any).metaForSave.extra.ctxPack === 'object'
        ? Object.keys((out as any).metaForSave.extra.ctxPack)
        : null,

    metaForSave_rotationState:
      (out as any)?.metaForSave?.rotationState ?? null,

    metaForSave_spinLoop:
      (out as any)?.metaForSave?.spinLoop ?? null,

    metaForSave_descentGate:
      (out as any)?.metaForSave?.descentGate ?? null,
  });
} catch {}

// ✅ 最後に single-writer stamp を確定（念押し）
out.metaForSave = stampSingleWriter(out.metaForSave);

const resultForReturn: any =
  orch && typeof orch === 'object' ? { ...(orch as any) } : {};

const willRotationForReturn =
  ((out.metaForSave as any)?.extra?.ctxPack?.willRotation &&
  typeof (out.metaForSave as any).extra.ctxPack.willRotation === 'object')
    ? ((out.metaForSave as any).extra.ctxPack.willRotation as any)
    : null;

if (!resultForReturn.meta || typeof resultForReturn.meta !== 'object') {
  resultForReturn.meta = {};
}
if (!resultForReturn.meta.extra || typeof resultForReturn.meta.extra !== 'object') {
  resultForReturn.meta.extra = {};
}

resultForReturn.meta.extra.ctxPack_willRotation = willRotationForReturn;
resultForReturn.ctxPack_willRotation = willRotationForReturn;

try {
  console.log('[IROS/Reply][FINAL_RETURN_WILLROTATION]', {
    conversationId,
    userCode,
    willRotationForReturn,
    result_meta_extra_ctxPack_willRotation:
      resultForReturn?.meta?.extra?.ctxPack_willRotation ?? null,
    result_ctxPack_willRotation:
      resultForReturn?.ctxPack_willRotation ?? null,
  });
} catch {}

return {
  ok: true,
  result: resultForReturn,
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
