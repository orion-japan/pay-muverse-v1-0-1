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

    // ✅ seed が載ってる meta を優先（postprocess 後の metaForSave を拾えるようにする）
    const candidateHasSeed =
      Boolean(candEx?.slotPlanSeed) ||
      Boolean(candEx?.llmRewriteSeed) ||
      Boolean((metaCandidate as any)?.seed_text) ||
      Boolean(candEx?.ctxPack?.seed_text);

    const savedHasSeed =
      Boolean(saveEx?.slotPlanSeed) ||
      Boolean(saveEx?.llmRewriteSeed) ||
      Boolean((metaSaved as any)?.seed_text) ||
      Boolean(saveEx?.ctxPack?.seed_text);

    const metaForProbe =
      (savedHasSeed && !candidateHasSeed) ? metaSaved :
      (metaCandidate ?? metaSaved ?? null);
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

    const goalKind = String(cp?.goalKind ?? metaAny.goalKind ?? 'stabilize').trim() || 'stabilize';

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

  // ✅ ここで return しない（下へ続行）
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
  const { buildHistoryDigestV1 } = await import('@/lib/iros/history/historyDigestV1');

// repeatSignal はここでは最小扱い（ctx0 側で持っているならそれを優先）
const repeatSignal =
  !!(ctx0 as any)?.repeatSignalSame || !!(ctx0 as any)?.repeat_signal || false;

// continuity は最小版（historyForTurn から取れるならそれを優先）
const lastUserCore =
  String(
    (ctx0 as any)?.continuity?.last_user_core ??
      (ctx0 as any)?.lastUserCore ??
      '',
  ).trim() || '';

const lastAssistantCore =
  String(
    (ctx0 as any)?.continuity?.last_assistant_core ??
      (ctx0 as any)?.lastAssistantCore ??
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
        if (cp.slotPlan) keep.slotPlan = cp.slotPlan;
        if (cp.exprMeta) keep.exprMeta = cp.exprMeta;
        if (cp.framePlan) keep.framePlan = cp.framePlan;
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

      if (cp.phase) keep.phase = cp.phase;
      if (cp.depthStage) keep.depthStage = cp.depthStage;
      if (cp.qCode) keep.qCode = cp.qCode;
      if (cp.slotPlanPolicy) keep.slotPlanPolicy = cp.slotPlanPolicy;
      if (cp.goalKind) keep.goalKind = cp.goalKind;
      if (cp.slotPlan) keep.slotPlan = cp.slotPlan;
      if (cp.exprMeta) keep.exprMeta = cp.exprMeta;
      if (cp.framePlan) keep.framePlan = cp.framePlan;
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
    // ✅ ViewShift: 前回スナップを baseMetaMergedForTurn に注入
    // - orchestrator.ts は baseMeta/history から prevSnap を拾う
    // - historyForTurn に meta が載っている環境でも確実に拾えるように、入口で集約する
    // ---------------------------------------------------------
    try {
      const pickSnapFromMsg = (m: any) =>
        m?.meta?.extra?.ctxPack?.viewShiftSnapshot ??
        m?.meta?.ctxPack?.viewShiftSnapshot ??
        m?.meta?.extra?.viewShiftSnapshot ??
        m?.meta?.viewShiftSnapshot ??
        null;

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

      if (snap && typeof snap === 'object') {
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

        (baseMetaMergedForTurn as any).extra.ctxPack.viewShiftSnapshot = snap;
      }

      console.log('[IROS/VIEWSHIFT][pre-orch][inject]', {
        hasSnap: Boolean(snap),
        snapKeys: snap && typeof snap === 'object' ? Object.keys(snap).slice(0, 20) : null,
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

    // 既存：flow
    (mf.extra as any).flowTape = tape ?? null;
    (mf.extra as any).flowDigest = exAny.flowDigest ?? null;

    // ✅ 追加：historyDigestV1（無ければこの場で作って保存）
    // - 生成ポイントを “ここ1箇所” に固定（重複生成しない）
    // - 既に入ってるなら触らない
    if (!(mf.extra as any).historyDigestV1) {
      try {
        const { buildHistoryDigestV1 } = await import('@/lib/iros/history/historyDigestV1');

        const lastUserCore =
          String((ctx as any)?.continuity?.last_user_core ?? (ctx as any)?.lastUserCore ?? '').trim();
        const lastAssistantCore =
          String((ctx as any)?.continuity?.last_assistant_core ?? (ctx as any)?.lastAssistantCore ?? '').trim();

        const repeatSignal =
          !!(ctx as any)?.repeatSignalSame ||
          !!(ctx as any)?.repeat_signal ||
          false;

        (mf.extra as any).historyDigestV1 = buildHistoryDigestV1({
          fixedNorth: { key: 'SUN', phrase: '成長 / 進化 / 希望 / 歓喜' },
          metaAnchorKey: String((ctx as any)?.baseMetaForTurn?.intent_anchor_key ?? '').trim() || null,
          memoryAnchorKey: String((ctx as any)?.memoryState?.intentAnchor ?? (ctx as any)?.intentAnchor ?? '').trim() || null,

          qPrimary: (ctx as any)?.memoryState?.qPrimary ?? (ctx as any)?.qPrimary ?? 'Q3',
          depthStage: (ctx as any)?.memoryState?.depthStage ?? (ctx as any)?.depthStage ?? 'F1',
          phase: (ctx as any)?.memoryState?.phase ?? (ctx as any)?.phase ?? 'Inner',

          situationTopic: String((ctx as any)?.situationTopic ?? 'その他・ライフ全般'),
          situationSummary: String((ctx as any)?.situationSummary ?? '').slice(0, 120),

          lastUserCore: String(lastUserCore ?? '').slice(0, 120),
          lastAssistantCore: String(lastAssistantCore ?? '').slice(0, 120),
          repeatSignal,
        });
      } catch (e) {
        // digest は非必須：失敗しても会話を止めない
      }
    }
  }
}


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

    const restored: any = {
      qCode: typeof ctx.qCode === 'string' ? ctx.qCode : null,
      depthStage: typeof ctx.depthStage === 'string' ? ctx.depthStage : null,
      phase: typeof ctx.phase === 'string' ? ctx.phase : null,
      conversationLine: typeof ctx.conversationLine === 'string' ? ctx.conversationLine : null,
    };

    if (restored.qCode || restored.depthStage || restored.phase || restored.conversationLine) {
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

// ✅ ここで「今回の returnStreak」を確定させる（拾えた prev を必ず継承）
{
  const deltaNow =
    (out as any)?.metaForSave?.extra?.flow?.delta ??
    (out as any)?.metaForSave?.extra?.flow?.flowDelta ??
    (extra2.ctxPack as any)?.flow?.delta ??
    (extra2.ctxPack as any)?.flow?.flowDelta ??
    null;

  const prevRs =
    typeof prevReturnStreak === 'number' && Number.isFinite(prevReturnStreak)
      ? prevReturnStreak
      : 0;

  // RETURN なら prev+1、RETURN 以外は 0（※ここは設計に合わせて変更可）
  const rsNow = String(deltaNow || '').toUpperCase() === 'RETURN' ? prevRs + 1 : 0;

  // ctxPack.flow は「正本」なので、ここで stamp
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

// ---- conversationLine v1 ----
// 目的：戻す（復帰）に必要な「話題1行」を ctxPack に保存する（重い処理なし）。
// ルール：
// - 既存が「Q/D/Pだけのデバッグ行」なら上書きしてよい（話題1行が永遠に入らないのを防ぐ）
// - 直近ユーザー3発話（+ 今回入力）から共通語彙を抽出して短く圧縮する
{
  const current = String(text ?? '').trim();

  const existing = String((extra2.ctxPack as any).conversationLine ?? '').trim();
  const looksLikeDebugLine =
    !!existing &&
    (/^Q:/.test(existing) || existing.includes('Q:') || existing.includes('D:') || existing.includes('P:') || existing.includes('流れ:') || existing.includes('戻り:'));

  if (!existing || looksLikeDebugLine) {
    // --- last3 user turns from history + current ---
    const lastUsers: string[] = [];
    for (let i = hft.length - 1; i >= 0; i--) {
      const m = hft[i];
      const role = String((m as any)?.role ?? '').toLowerCase();
      if (role !== 'user') continue;
      const c = String((m as any)?.content ?? (m as any)?.text ?? '').trim();
      if (!c) continue;
      lastUsers.push(c);
      if (lastUsers.length >= 3) break;
    }
    const turns = [...lastUsers.reverse(), current].filter(Boolean);

    const STOP = new Set([
      'これ', 'それ', 'あれ', 'ここ', 'そこ', 'どこ', '何', 'なん', 'だっけ',
      'こと', 'もの', '感じ', 'いま', '今', 'その', 'この', 'あの',
      'です', 'ます', 'する', 'した', 'して', 'いる', 'なる', 'ため',
      'あと', 'だけ', 'ちょっと', 'やっぱり', 'まだ',
    ]);

    const pickKeywords = (s: string) => {
      const t = s
        .replace(/[　\s]+/g, ' ')
        .replace(/[。、，．・\(\)（）「」『』【】\[\]{}<>＜＞"“”'’!?！？:：;；]/g, ' ')
        .trim();

      const words: string[] = [];

      // 漢字・カタカナ・英数の“塊”だけ拾う（日本語分かち書き無しでも最低限動く）
      const re = /[一-龥]{2,}|[ァ-ヶー]{2,}|[A-Za-z0-9]{3,}/g;
      const ms = t.match(re) ?? [];
      for (const w0 of ms) {
        const w = w0.trim();
        if (!w) continue;
        if (STOP.has(w)) continue;
        words.push(w);
      }
      return words;
    };

    const freq = new Map<string, number>();
    for (const s of turns) {
      for (const w of pickKeywords(s)) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }

    const ranked = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([w]) => w);

    // できるだけ短く：上位2〜3語
    const picked = ranked.slice(0, 3);
    let line = picked.join('・').trim();

    // どうしても拾えないときは、今回入力を短く使う
    if (!line) {
      line = current.length > 18 ? current.slice(0, 18) + '…' : current;
    }

    // 最終ガード（長すぎ防止）
    if (line.length > 28) line = line.slice(0, 28) + '…';

    (extra2.ctxPack as any).conversationLine = line || null;

    // rephraseEngine が拾えるように topicDigest も同期（TOPIC_DIGEST: (none) を消す）
    (extra2.ctxPack as any).topicDigest = line || null;
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

// ✅ returnStreak は「既に計算済みがあればそれを正本」として採用し、無い時だけ prev+delta で算出
const preReturnStreakRaw =
  (mf2 as any)?.flow?.returnStreak ??
  (mf2 as any)?.extra?.flow?.returnStreak ??
  (mf2 as any)?.extra?.ctxPack?.flow?.returnStreak ??
  (mf2 as any)?.ctxPack?.flow?.returnStreak ??
  null;

let returnStreak: number = 0;

if (typeof preReturnStreakRaw === 'number' && Number.isFinite(preReturnStreakRaw)) {
  returnStreak = preReturnStreakRaw;
} else if (typeof preReturnStreakRaw === 'string' && preReturnStreakRaw.trim() && Number.isFinite(Number(preReturnStreakRaw))) {
  returnStreak = Number(preReturnStreakRaw);
} else {
  const prevRs =
    typeof prevReturnStreak === 'number' && Number.isFinite(prevReturnStreak) ? prevReturnStreak : 0;
  returnStreak = flowDelta === 'RETURN' ? prevRs + 1 : 0;
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

// 互換：extra.flow にも薄く置く（既存が参照している可能性があるため）
if (!extra2.flow || typeof extra2.flow !== 'object') extra2.flow = {};
(extra2.flow as any).delta = (extra2.flow as any).delta ?? flowDeltaNorm ?? null;
(extra2.flow as any).confidence = (extra2.flow as any).confidence ?? flowConfidence ?? null;
(extra2.flow as any).returnStreak = (extra2.flow as any).returnStreak ?? returnStreak;
(extra2.flow as any).sessionBreak = (extra2.flow as any).sessionBreak ?? false;

// ctxPack にも historyForWriter を同期（循環参照を避ける最小形）
const hfw = Array.isArray((out.metaForSave as any)?.extra?.historyForWriter)
  ? (out.metaForSave as any).extra.historyForWriter
  : [];

// ✅ 重要：null だけでなく「空配列」も“未同期”として扱い、hfw があれば上書き同期する
const curHfw = (extra2.ctxPack as any)?.historyForWriter;
const curLen = Array.isArray(curHfw) ? curHfw.length : 0;

if (hfw.length && (!Array.isArray(curHfw) || curLen === 0)) {
  (extra2.ctxPack as any).historyForWriter = (hfw as any[]).map((m) => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String((m as any)?.content ?? '').trim(),
  }));
}

// ✅ ctxPack にも historyDigestV1 を同期（存在しているものだけ）
const digestV1Raw =
  (out.metaForSave as any)?.extra?.historyDigestV1 ??
  (extra2 as any)?.historyDigestV1 ??
  null;

if ((extra2.ctxPack as any).historyDigestV1 == null && digestV1Raw) {
  (extra2.ctxPack as any).historyDigestV1 = digestV1Raw;
}

// ✅ ctxPack に phase / depthStage / qCode も同期（rephraseEngine が拾う）
// 優先：metaForSave → unified（あれば）→ null
{
  const m = (out.metaForSave as any) ?? {};
  const u = (m.unified as any) ?? {};

  // phase
  const phaseRaw = m.phase ?? u.phase ?? null;
  if (
    (extra2.ctxPack as any).phase == null &&
    (phaseRaw === 'Inner' || phaseRaw === 'Outer')
  ) {
    (extra2.ctxPack as any).phase = phaseRaw;
  }

  // depthStage
  const depthRaw = m.depthStage ?? u.depthStage ?? m.depth ?? u?.depth?.stage ?? null;
  if ((extra2.ctxPack as any).depthStage == null && typeof depthRaw === 'string' && depthRaw) {
    (extra2.ctxPack as any).depthStage = depthRaw;
  }

  // qCode
  const qRaw = m.qCode ?? u.qCode ?? m.q ?? u?.q?.current ?? null;
  if ((extra2.ctxPack as any).qCode == null && typeof qRaw === 'string' && qRaw) {
    (extra2.ctxPack as any).qCode = qRaw;
  }
}
// ✅ ctxPack に slotPlanPolicy / slots / framePlan も同期（rephraseEngine / convEvidence が拾う）
// - 正本は framePlan（推定しない）
// - slotPlanPolicy は framePlan.slotPlanPolicy を最優先
// - slotPlan（本文スロット実体）は framePlan.slotPlan → meta.slotPlan の順で拾う
{
  const m = (out.metaForSave as any) ?? {};
  const fp = (m.framePlan as any) ?? null;

  // ✅ framePlan 自体を ctxPack に同期（SHIFT枠が無いと extractSlots が崩れる）
  if ((extra2.ctxPack as any).framePlan == null && fp && typeof fp === 'object') {
    (extra2.ctxPack as any).framePlan = fp;
  }

  // slotPlanPolicy（正本：framePlan）
  const policyRaw = (fp as any)?.slotPlanPolicy ?? m.slotPlanPolicy ?? null;
  if (
    (extra2.ctxPack as any).slotPlanPolicy == null &&
    typeof policyRaw === 'string' &&
    policyRaw.trim()
  ) {
    (extra2.ctxPack as any).slotPlanPolicy = policyRaw.trim();
  }

  // ✅ goalKind（BLOCK_PLAN の stabilize 縮退が効くように ctxPack に同期）
  // 注意：ctxPack.replyGoal は「文字列（permit_density 等）」として既に使うので触らない
  const goalKindRaw = m.targetKind ?? m.target_kind ?? m.goalKind ?? null;
  if (
    (extra2.ctxPack as any).goalKind == null &&
    typeof goalKindRaw === 'string' &&
    goalKindRaw.trim()
  ) {
    (extra2.ctxPack as any).goalKind = goalKindRaw.trim();
  }
  // ✅ replyGoal / repeatSignal を ctxPack に同期（writer の OBS_CARD で (none) を出さない）
  // - replyGoal: 'permit_density' | 'reduce_scatter' | 'reflect_position'
  // - repeatSignal: 'same_phrase' | null
  const itxStepRaw = String(
    (extra2.ctxPack as any)?.itxStep ??
      (extra2.ctxPack as any)?.tLayerHint ??
      (extra2.ctxPack as any)?.itx_step ??
      ''
  ).trim();

  const tLayerModeActive = /^T[123]$/u.test(itxStepRaw);

  // repeat は upstream の boolean シグナル（repeatSignalSame）を最優先で拾う
  const repeatSame =
    Boolean((extra2 as any)?.repeatSignalSame) ||
    Boolean((extra2.ctxPack as any)?.repeatSignalSame) ||
    false;

  if ((extra2.ctxPack as any).repeatSignal == null) {
    (extra2.ctxPack as any).repeatSignal = repeatSame ? 'same_phrase' : null;
  }

  if ((extra2.ctxPack as any).replyGoal == null) {
    (extra2.ctxPack as any).replyGoal = tLayerModeActive
      ? 'permit_density'
      : repeatSame
        ? 'reduce_scatter'
        : 'reflect_position';
  }
  // slotPlan（本文スロット実体）
  const slotsRaw =
    ((fp as any)?.slotPlan && Array.isArray((fp as any).slotPlan) ? (fp as any).slotPlan : null) ??
    (m.slotPlan && Array.isArray(m.slotPlan) ? m.slotPlan : null) ??
    null;

  // ctxPack 側のキー名は “slotPlan” に揃える
  if ((extra2.ctxPack as any).slotPlan == null && Array.isArray(slotsRaw) && slotsRaw.length) {
    (extra2.ctxPack as any).slotPlan = slotsRaw;
  }

  // ✅ exprMeta も ctxPack に同期（正本：metaForSave.extra.ctxPack.exprMeta）
  const exprMetaRaw = (m.extra as any)?.ctxPack?.exprMeta ?? (m.extra as any)?.exprMeta ?? null;
  if ((extra2.ctxPack as any).exprMeta == null && exprMetaRaw && typeof exprMetaRaw === 'object') {
    (extra2.ctxPack as any).exprMeta = exprMetaRaw;
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

// ✅ RESONANCE_STATE / seed_text を ctxPack 正本へ同期（rephraseEngine が拾う入口）
{
  const exOut: any = (out.metaForSave as any)?.extra ?? {};
  const rs: any =
    exOut?.resonanceState ??
    exOut?.ctxPack?.resonanceState ??
    null;

  if ((extra2.ctxPack as any).resonanceState == null && rs && typeof rs === 'object') {
    (extra2.ctxPack as any).resonanceState = rs;
  }

  // 互換：seed_text（rephraseEngine が旧キーでも拾える）
  const seedText: any =
    exOut?.seed_text ??
    (typeof rs?.seed?.seed_text === 'string' ? rs.seed.seed_text : null) ??
    (typeof rs?.seed_text === 'string' ? rs.seed_text : null) ??
    null;

  if ((extra2.ctxPack as any).seed_text == null && typeof seedText === 'string' && seedText.trim()) {
    (extra2.ctxPack as any).seed_text = seedText.trim();
  }
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

  ctxPackKeys: extra2.ctxPack ? Object.keys(extra2.ctxPack as any) : null,

  hfw_len: Array.isArray((extra2.ctxPack as any)?.historyForWriter)
    ? (extra2.ctxPack as any).historyForWriter.length
    : null,

  hasDigestV1: Boolean((extra2.ctxPack as any)?.historyDigestV1),
  digestChars,

  hfw_src_len: Array.isArray((out.metaForSave as any)?.extra?.historyForWriter)
    ? (out.metaForSave as any).extra.historyForWriter.length
    : null,
});


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

const shouldRunWriter =
  (policy === 'SCAFFOLD' || policy === 'FINAL') &&
  (seedOnlyNow || emptyLikeNow) &&
  !alreadyHasBlocks &&
  allowLLM_final_local !== false;
      if (seedOnlyNow || emptyLikeNow) {
        console.log('[IROS/rephraseBridge][ENTER]', {
          conversationId: _conversationId,
          userCode: _userCode,
          policy,
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
        });
      }

// --- DEBUG: slot sources snapshot (TEMP) ---
try {
  const sp = (out.metaForSave as any)?.slotPlan;
  const fp = (out.metaForSave as any)?.framePlan;

  const sp0 = Array.isArray(sp) ? sp[0] : null;
  const sp0Type = sp0 == null ? 'null' : Array.isArray(sp0) ? 'array' : typeof sp0;

  const fpSlots: any[] = Array.isArray(fp?.slots) ? fp.slots : [];
  const wantIds = fpSlots.map((s: any) => String(s?.id ?? '').trim()).filter(Boolean);
// ✅ slotPlan の JSON 内 "user":"..." は LLM へ渡さない（生文遮断）
function sanitizeSlotTextUser(s: string): string {
  const text = String(s ?? '');
  const a = text.replace(/"user"\s*:\s*"(?:\\.|[^"\\])*"/g, '"user":"[USER]"');
  const b = a.replace(/"(lastUserText|basedOn)"\s*:\s*"(?:\\.|[^"\\])*"/g, (_m, k) => `"${k}":"[USER]"`);
  return b;
}

console.log('[IROS/rephraseBridge][SLOT_SOURCES]', {
  slotPlan_type: Array.isArray(sp) ? 'array' : typeof sp,
  slotPlan_len: Array.isArray(sp) ? sp.length : null,
  slotPlan_item0_type: sp0Type,
  slotPlan_item0_keys: sp0 && typeof sp0 === 'object' ? Object.keys(sp0).slice(0, 12) : null,
  slotPlan_item0_head:
    typeof sp0 === 'string'
      ? sanitizeSlotTextUser(sp0).slice(0, 120)
      : sp0 && typeof sp0 === 'object'
        ? (
            sanitizeSlotTextUser(
              String((sp0 as any).text ?? (sp0 as any).content ?? (sp0 as any).hint ?? '')
            ).slice(0, 120) || null
          )
        : null,

  framePlan_has_slots: !!fp?.slots,
  framePlan_slots_len: fpSlots.length,
  framePlan_wantIds: wantIds,

  extra_keys: (out.metaForSave as any)?.extra
    ? Object.keys((out.metaForSave as any).extra).slice(0, 16)
    : null,
});
} catch {}
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
      const qCanon = (out.metaForSave as any)?.q ?? null;
      const depthCanon = (out.metaForSave as any)?.depth ?? null;
      const phaseCanon = (out.metaForSave as any)?.phase ?? null;

      ctxPack.qCode = qCanon ?? ctxPack.qCode ?? null;
      ctxPack.depthStage = depthCanon ?? ctxPack.depthStage ?? null;
      ctxPack.phase = phaseCanon ?? ctxPack.phase ?? null;
    } catch {}

    // ✅ topicDigest を最低限確保（重い処理なし）
    // - conversationLine があるなら topicDigest にも入れる
    if (!ctxPack.topicDigest && ctxPack.conversationLine) {
      ctxPack.topicDigest = String(ctxPack.conversationLine);
    }

    // ✅ rephraseEngine.full.ts が拾いやすい経路にも置く
    if (!exAny.topicDigest && (ctxPack.topicDigest || ctxPack.conversationLine)) {
      exAny.topicDigest = String(ctxPack.topicDigest ?? ctxPack.conversationLine);
    }
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
  const rr = await rephraseSlotsFinal(
    extracted,
    {
      model,
      temperature: 0.7,

      // ✅ ここが本丸：rephraseEngine.full.ts の CARD_SEEDIN 判定は opts.inputKind を参照する
      inputKind: inputKindCanon,

      maxLinesHint: (() => {
        const exAny = (out.metaForSave as any)?.extra ?? {};

        // ✅ BlockPlan は“system注入専用”で保存・継続しない（残留は揺れの原因）
        // - ここで必ず消す（enabled=false の残留封じ）
        try {
          if (exAny && typeof exAny === 'object') {
            delete (exAny as any).blockPlan;
            delete (exAny as any).blockPlanText;
            delete (exAny as any).blockPlanEnabled;
            delete (exAny as any).blockPlanMeta;
          }
        } catch {}

        // ✅ 行数予算は UI/保存の“可視ブロック”に寄せる（BlockPlanは不可視なので basis にしない）
        const rbLen = Array.isArray((exAny as any)?.rephraseBlocks)
          ? (exAny as any)?.rephraseBlocks.length
          : 0;

        const slotLen = Array.isArray((extracted as any)?.keys) ? (extracted as any)?.keys.length : 0;

        const basis = rbLen > 0 ? rbLen : slotLen > 0 ? slotLen : 4;
        const budget = Math.max(12, basis * 8);
        return Math.min(80, budget);
      })(),

      userText: typeof text === 'string' ? text : null,

      debug: {
        traceId: traceIdCanon,
        conversationId: _conversationId ?? null,
        userCode: _userCode ?? null,
        slotPlanPolicy,
        renderEngine: true,
        inputKind: inputKindCanon, // ✅ debug も統一
      } as any,

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

        const metaRoot = (out.metaForSave as any)?.meta ?? null;

        // ✅ ctxPack の継続値を受けるが、BlockPlan 系は“絶対に継続しない”
        const ctxPackPrevRaw: any = ((out.metaForSave as any)?.extra?.ctxPack ?? null) as any;
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

        return {
          conversationId: _conversationId ?? null,
          userCode: _userCode ?? null,
          traceId: traceIdCanon,
          inputKind: inputKindCanon, // ✅ userContext も統一

          exprMeta: exprMetaCanon,

          historyForWriter: turns,

          ctxPack: {
            ...ctxPackPrev,

            // ✅ 正本（CANON/PP後の metaForSave）で毎ターン stamp してズレを殺す
            qCode: (out.metaForSave as any)?.q ?? (ctxPackPrev as any)?.qCode ?? null,
            depthStage: (out.metaForSave as any)?.depth ?? (ctxPackPrev as any)?.depthStage ?? null,
            phase: (out.metaForSave as any)?.phase ?? (ctxPackPrev as any)?.phase ?? null,

            traceId: traceIdCanon, // ✅ ここも固定
            inputKind: inputKindCanon, // ✅ ctxPack にも入れておく（観測しやすくする）
            historyForWriter: turns,
            slotPlanPolicy,
            exprMeta: exprMetaCanon,
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
          },
        };
      })(),
    } as any,
  );
          if (rr && rr.ok) {
            const mx = (rr as any)?.meta?.extra ?? {};
            const blocksCandidate =
              (rr as any)?.rephraseBlocks ?? mx?.rephraseBlocks ?? mx?.rephrase?.blocks ?? null;

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
