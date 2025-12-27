// ✅ 変更：src/lib/iros/server/handleIrosReply.persist.ts
// このファイルに「IntentTransition v1.0 の保存」を追加する確定パッチ

import type { SupabaseClient } from '@supabase/supabase-js';



/* =========================
 * Helpers
 * ========================= */

type Phase = 'Inner' | 'Outer';
type SpinLoop = 'SRI' | 'TCF';
type DescentGate = 'closed' | 'offered' | 'accepted';
type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

// ✅ IntentTransition v1.0（DB列として保存する最小セット）
type IntentTransitionStep = 'recognize' | 'idea_loop' | 't_closed' | 't_open' | 'create';

function normalizeIntentTransitionStep(v: unknown): IntentTransitionStep | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'recognize') return 'recognize';
  if (s === 'idea_loop') return 'idea_loop';
  if (s === 't_closed') return 't_closed';
  if (s === 't_open') return 't_open';
  if (s === 'create') return 'create';
  return null;
}

function normalizeAnchorEventType(v: unknown): AnchorEventType | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'none' || s === 'confirm' || s === 'set' || s === 'reset') return s;
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ✅ intentTransition（orchが meta.intentTransition に載せたスナップ）を拾う
function pickIntentTransitionSnapshot(metaForSave: any): {
  step: IntentTransitionStep;
  anchorEventType: AnchorEventType;
  reason: string;
} | null {
  const itx =
    metaForSave?.intentTransition ??
    metaForSave?.intent_transition ??
    null;

  if (!itx || typeof itx !== 'object') return null;

  const step =
    normalizeIntentTransitionStep((itx as any).step) ??
    normalizeIntentTransitionStep((itx as any).intent_transition_step) ??
    null;

  const anchorEventType =
    normalizeAnchorEventType((itx as any).anchorEventType) ??
    normalizeAnchorEventType((itx as any).anchor_event_type) ??
    null;

  const reasonRaw =
    (itx as any).reason ??
    (itx as any).transition_reason ??
    null;

  const reason =
    typeof reasonRaw === 'string' ? reasonRaw.trim() : '';

  // step が無いなら「保存しない」（列だけ null で潰さない）
  if (!step) return null;

  return {
    step,
    anchorEventType: anchorEventType ?? 'none',
    reason: reason || 'itx',
  };
}

// ✅ q_counts は「it_cooldown」等の付帯情報を含み得る（jsonb）
type QCounts = {
  it_cooldown?: number; // 0/1 を想定（将来拡張OK）
  q_trace?: any; // 観測用（DB列追加なしで調査できる）
  [k: string]: any;
};

function toInt0to3(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3, Math.round(v)));
}

function normalizePhase(v: unknown): Phase | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop(v: unknown): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeSpinStep(v: unknown): 0 | 1 | 2 | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n === 0 || n === 1 || n === 2) return n;
  return null;
}

// ✅ boolean互換あり（Aの確定）
function normalizeDescentGate(v: unknown): DescentGate | null {
  if (v == null) return null;

  // 互換: boolean が来たら
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'closed') return 'closed';
  if (s === 'offered') return 'offered';
  if (s === 'accepted') return 'accepted';
  return null;
}

function normalizeQCounts(v: unknown): QCounts {
  if (!v || typeof v !== 'object') return { it_cooldown: 0 };
  const obj = v as any;

  const cd = typeof obj.it_cooldown === 'number' ? obj.it_cooldown : 0;

  // ✅ 交互仕様：0 or 1 に固定（将来拡張するならここ）
  return { ...(obj ?? {}), it_cooldown: cd > 0 ? 1 : 0 };
}

/** intent_anchor から text を安全に取り出す */
function extractAnchorText(anchor: any): string | null {
  if (!anchor) return null;
  if (typeof anchor === 'string') return anchor.trim() || null;
  if (typeof anchor === 'object') {
    const t = anchor.text;
    if (typeof t === 'string') return t.trim() || null;
  }
  return null;
}

function normalizeAnchorText(text: string): string {
  return (text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * “アンカー更新イベント” を meta から拾う
 * - metaForSave.anchorEvent.type を最優先
 * - 互換として anchorEventType も拾う
 */
function pickAnchorEventType(metaForSave: any): AnchorEventType {
  const t1 = metaForSave?.anchorEvent?.type;
  if (t1 === 'none' || t1 === 'confirm' || t1 === 'set' || t1 === 'reset') return t1;

  const t2 = metaForSave?.anchorEventType;
  if (t2 === 'none' || t2 === 'confirm' || t2 === 'set' || t2 === 'reset') return t2;

  return 'none';
}

/**
 * “メタ発話・会話制御” はアンカーにしない（固定ルール）
 * ※意味解釈ではなく、危険パターンを明示的に落とす
 */
function isMetaAnchorText(text: string): boolean {
  const s = normalizeAnchorText(text);
  if (!s) return true;

  // 典型メタ
  if (/^覚えて(る|ます)?[？?]?$/.test(s)) return true;
  if (/^何の話(し)?[？?]?$/.test(s)) return true;
  if (/^さっき(話した|言った)(でしょ|よね)?/.test(s)) return true;

  // 極端に短いものは北極星にならない
  if (s.length <= 6) return true;

  // テンプレ批評・AI批評系はアンカーにしない
  const metaKeywords = [
    'AI',
    'iros',
    'Iros',
    'GPT',
    'テンプレ',
    '同じ',
    '繰り返し',
    '一般',
    '違う',
    'それ違う',
    'その答え',
    '足踏み',
  ];
  for (const k of metaKeywords) {
    if (s.includes(k)) return true;
  }

  return false;
}

/**
 * ✅ intent_anchor 保存ゲート（合意仕様）
 * - DB上のアンカーは「北極星」なので、通常ターンでは更新しない
 * - 更新できるのは set/reset のときだけ
 * - confirm は「表に出す」だけで、DB更新はしない
 *
 * 追加安全策：
 * - reset は「消す」なので anchorText 不要
 * - メタ発話は set/reset でも絶対拒否
 */
function shouldWriteIntentAnchorToMemoryState(args: {
  anchorEventType: AnchorEventType;
  anchorText: string | null;
}): { action: 'keep' | 'set' | 'reset' } {
  const { anchorEventType, anchorText } = args;

  if (anchorEventType === 'reset') {
    // reset はクリア（テキスト不要）
    return { action: 'reset' };
  }

  if (anchorEventType !== 'set') {
    return { action: 'keep' };
  }

  if (!anchorText) return { action: 'keep' };
  if (isMetaAnchorText(anchorText)) return { action: 'keep' };

  return { action: 'set' };
}

/** SUN固定判定：揺れやすいのでパターンを増やす */
function isFixedNorthSun(metaForSave: any): boolean {
  // 明示フラグ
  if (metaForSave?.fixedNorth?.key === 'SUN') return true;
  if (metaForSave?.fixed_north?.key === 'SUN') return true;

  // intent_anchor 側の互換
  if (metaForSave?.intent_anchor?.fixed === true) return true;
  if (metaForSave?.intentAnchor?.fixed === true) return true;

  // 文字キーで来る可能性
  if (metaForSave?.north_star === 'SUN') return true;
  if (metaForSave?.northStar === 'SUN') return true;

  return false;
}

// ✅ 追加：qTrace を persist 直前で正規化（branch差を吸収）
function normalizeQTraceForPersist(metaForSave: any): any {
  if (!metaForSave || typeof metaForSave !== 'object') return metaForSave;

  const qTrace =
    metaForSave.qTrace && typeof metaForSave.qTrace === 'object' ? metaForSave.qTrace : null;

  const qTraceUpdated =
    metaForSave.qTraceUpdated && typeof metaForSave.qTraceUpdated === 'object'
      ? metaForSave.qTraceUpdated
      : null;

  if (!qTrace && !qTraceUpdated) return metaForSave;

  const lenQ =
    typeof (qTrace as any)?.streakLength === 'number' &&
    Number.isFinite((qTrace as any).streakLength)
      ? Math.max(0, Math.floor((qTrace as any).streakLength))
      : null;

  const lenU =
    typeof (qTraceUpdated as any)?.streakLength === 'number' &&
    Number.isFinite((qTraceUpdated as any).streakLength)
      ? Math.max(0, Math.floor((qTraceUpdated as any).streakLength))
      : null;

  // ✅ 重要：streakLength は “大きい方” を採用（1で潰される事故を防ぐ）
  const streakLength = lenQ == null && lenU == null ? undefined : Math.max(lenQ ?? 0, lenU ?? 0);

  const mergedQTrace = {
    ...(qTrace ?? {}),
    ...(qTraceUpdated ?? {}),
    ...(streakLength !== undefined ? { streakLength } : {}),
  };

  const uncoverPrevRaw = metaForSave.uncoverStreak;
  const uncoverPrev =
    typeof uncoverPrevRaw === 'number' && Number.isFinite(uncoverPrevRaw)
      ? Math.max(0, Math.floor(uncoverPrevRaw))
      : 0;

  const uncoverNext =
    typeof (mergedQTrace as any).streakLength === 'number'
      ? Math.max(uncoverPrev, (mergedQTrace as any).streakLength)
      : uncoverPrev;

  return {
    ...metaForSave,
    qTrace: mergedQTrace,
    qTraceUpdated: mergedQTrace,
    uncoverStreak: uncoverNext,
  };
}

/* =========================
 * Persist: messages
 * ========================= */

export async function persistAssistantMessage(args: {
  supabase: SupabaseClient; // 使わないが、呼び出し側の統一のため受け取る
  reqOrigin: string;
  authorizationHeader: string | null;
  conversationId: string;
  userCode: string;
  assistantText: string;
  metaForSave: any;
}) {
  const { reqOrigin, authorizationHeader, conversationId, userCode, assistantText, metaForSave } =
    args;

  try {
    const msgUrl = new URL('/api/agent/iros/messages', reqOrigin);

    // y/h は DB 保存と揃えるため整数に丸めて meta にも反映
    const yInt = toInt0to3(metaForSave?.yLevel ?? metaForSave?.unified?.yLevel);
    const hInt = toInt0to3(metaForSave?.hLevel ?? metaForSave?.unified?.hLevel);

    // phase/spin は camel/snake 両対応で拾って、messages 側にも両方入れる（互換）
    const phaseRaw =
      metaForSave?.phase ??
      metaForSave?.phase_mode ??
      metaForSave?.phaseMode ??
      metaForSave?.unified?.phase ??
      null;

    const spinLoopRaw =
      metaForSave?.spinLoop ??
      metaForSave?.spin_loop ??
      metaForSave?.unified?.spin_loop ??
      metaForSave?.unified?.spinLoop ??
      null;

    const spinStepRaw =
      metaForSave?.spinStep ??
      metaForSave?.spin_step ??
      metaForSave?.unified?.spin_step ??
      metaForSave?.unified?.spinStep ??
      null;

    // ✅ 追加：descent_gate / descentGate（camel/snake 両対応）
    const descentGateRaw =
      metaForSave?.descentGate ??
      metaForSave?.descent_gate ??
      metaForSave?.unified?.descent_gate ??
      metaForSave?.unified?.descentGate ??
      null;

    const phaseNorm = normalizePhase(phaseRaw);
    const spinLoopNorm = normalizeSpinLoop(spinLoopRaw);
    const spinStepNorm = normalizeSpinStep(spinStepRaw);
    const descentGateNorm = normalizeDescentGate(descentGateRaw);

    const metaForSaveNormalized = normalizeQTraceForPersist(metaForSave);

    const meta = {
      ...(metaForSaveNormalized ?? {}),
      writer: 'handleIrosReply',

      ...(yInt !== null ? { yLevel: yInt } : {}),
      ...(hInt !== null ? { hLevel: hInt } : {}),

      // 正規化した値を camelCase にも載せる
      ...(phaseNorm ? { phase: phaseNorm } : {}),
      ...(spinLoopNorm ? { spinLoop: spinLoopNorm } : {}),
      ...(typeof spinStepNorm === 'number' ? { spinStep: spinStepNorm } : {}),
      ...(descentGateNorm ? { descentGate: descentGateNorm } : {}),

      // 互換：snake_case も同値で載せる
      ...(phaseNorm ? { phase_mode: phaseNorm } : {}),
      ...(spinLoopNorm ? { spin_loop: spinLoopNorm } : {}),
      ...(typeof spinStepNorm === 'number' ? { spin_step: spinStepNorm } : {}),
      ...(descentGateNorm ? { descent_gate: descentGateNorm } : {}),
    };

    const res = await fetch(msgUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorizationHeader ?? '',
        'x-user-code': userCode,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        role: 'assistant',
        // legacy / newer 両対応
        text: assistantText,
        content: assistantText,
        meta,
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('[IROS/Persist] persistAssistantMessage not ok', {
        status: res.status,
        body: t?.slice?.(0, 300) ?? '',
      });
    }
  } catch (e) {
    console.error('[IROS/Persist] persistAssistantMessage failed', e);
  }
}


/* =========================
 * Persist: Q snapshot
 * ========================= */

export async function persistQCodeSnapshotIfAny(args: {
  userCode: string;
  conversationId: string;
  requestedMode: string | undefined;
  metaForSave: any;
}) {
  const { userCode, conversationId, requestedMode, metaForSave } = args;

  try {
    const m: any = metaForSave ?? null;

    // metaForSave の形が複数あり得るので “実体” を探す
    const core: any =
      m?.meta ?? // { meta: {...} } で包まれてるケース
      m?.finalMeta ?? // { finalMeta: {...} } のケース
      m;

    const unified: any = core?.unified ?? null;

    // ---- Q を “絶対に拾う” 優先順 ----
    const q: any =
      core?.qCode ??
      core?.q_code ??
      core?.qPrimary ?? // MemoryState 由来で来ることがある
      core?.q_now ?? // もし来てたら拾う
      core?.qTraceUpdated?.qNow ??
      core?.qTrace?.qNow ??
      core?.q_counts?.q_trace?.qNow ??
      unified?.q?.current ??
      unified?.qCode ?? // 念のため
      null;

    // ---- Depth stage を拾う ----
    const stage: any =
      core?.depth ??
      core?.depth_stage ??
      core?.depthStage ??
      unified?.depth?.stage ??
      null;

    // ここは将来 meta から取れるなら差し替え可
    const layer: any = 'inner';
    const polarity: any = 'now';

    if (q) {
      const { writeQCodeWithEnv } = await import('@/lib/qcode/qcode-adapter');

      await writeQCodeWithEnv({
        user_code: userCode,
        source_type: 'iros',
        intent: requestedMode ?? 'auto',
        q,
        stage,
        layer,
        polarity,
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
        extra: {
          _from: 'handleIrosReply.persist',
          _picked_from: {
            has_qCode: !!core?.qCode,
            has_q_code: !!core?.q_code,
            has_qPrimary: !!core?.qPrimary,
            has_unified_current: !!unified?.q?.current,
            has_qTraceUpdated: !!core?.qTraceUpdated,
          },
        },
      });
    } else {
      console.warn('[IROS/Q] skip persistQCodeSnapshotIfAny because q is null', {
        userCode,
        conversationId,
        requestedMode,
        keys_core: core ? Object.keys(core) : null,
        qCode: core?.qCode ?? null,
        q_code: core?.q_code ?? null,
        qPrimary: core?.qPrimary ?? null,
        qTraceUpdated: core?.qTraceUpdated ?? null,
        unifiedCurrent: unified?.q?.current ?? null,
        unifiedDepth: unified?.depth?.stage ?? null,
      });
    }
  } catch (e) {
    console.error('[IROS/Q] persistQCodeSnapshotIfAny failed', e);
  }
}


/* =========================
 * Persist: intent_anchor (reserved)
 * ========================= */

export async function persistIntentAnchorIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  metaForSave: any;
}) {
  // NOTE:
  // intent_anchor は現状 iros_memory_state.intent_anchor(jsonb) に保存する設計に寄せる。
  // ここは「専用テーブル」等に分離したくなったら移植する。
  return;
}


/* =========================
 * Persist: iros_memory_state
 * ========================= */

export async function persistMemoryStateIfAny(args: {
  supabase: SupabaseClient;
  userCode: string;
  userText: string;
  metaForSave: any;

  // ✅ 任意：q_counts を外から渡せる
  qCounts?: unknown | null;

  // ✅ 任意：そのターンで IT が発火したか（最優先）
  itTriggered?: boolean;
}) {
  // ✅ これが無いのが原因（metaForSave がスコープに存在しない）
  const { supabase, userCode, userText, metaForSave, qCounts, itTriggered } = args;

  try {
    if (!metaForSave) return;

    // unified を最優先で使う（postProcessReply 後は必ず揃っている）
    // ✅ unified はここで1回だけ（再宣言しない）
    const unified: any = metaForSave?.unified ?? {};

    // =========================================================
    // ITX（intent transition）入力：関数外に出さない
    // =========================================================
    const transitionStepInput =
      (metaForSave as any)?.intentTransition?.snapshot?.step ??
      (metaForSave as any)?.intent_transition?.step ??
      (metaForSave as any)?.intent_transition_step ??
      null;

    const anchorEventTypeInput =
      (metaForSave as any)?.intentTransition?.snapshot?.anchorEventType ??
      (metaForSave as any)?.intent_transition?.anchor_event_type ??
      (metaForSave as any)?.anchorEventType ??
      null;

    const transitionReasonInput =
      (metaForSave as any)?.intentTransition?.snapshot?.reason ??
      (metaForSave as any)?.intent_transition?.reason ??
      (metaForSave as any)?.transition_reason ??
      null;

    const lastTransitionAtInput =
      (metaForSave as any)?.intentTransition?.snapshot?.lastTransitionAt ??
      (metaForSave as any)?.intent_transition?.last_transition_at ??
      (metaForSave as any)?.last_transition_at ??
      null;

    // allowlist（変な値を入れない）
    const STEP_ALLOW = new Set(['recognize', 'idea_loop', 't_closed', 't_open', 'create']);
    const ANCHOR_ALLOW = new Set(['none', 'confirm', 'set', 'reset']);

    const stepFinal =
      typeof transitionStepInput === 'string' && STEP_ALLOW.has(transitionStepInput)
        ? transitionStepInput
        : null;

    const anchorFinal =
      typeof anchorEventTypeInput === 'string' && ANCHOR_ALLOW.has(anchorEventTypeInput)
        ? anchorEventTypeInput
        : null;

    const reasonFinal =
      typeof transitionReasonInput === 'string' && transitionReasonInput.trim().length > 0
        ? transitionReasonInput.trim()
        : null;

    const lastAtFinal =
      typeof lastTransitionAtInput === 'string' && lastTransitionAtInput.trim().length > 0
        ? lastTransitionAtInput.trim()
        : null;

    // =========================================================
    // A: previous を先に取得（merge の土台）
    // ※ ITX列は「未定義列で落ちるDBがある」ので select には入れない（安全）
    // =========================================================
    const { data: previous, error: prevErr } = await supabase
      .from('iros_memory_state')
      .select(
        [
          'q_counts',
          'depth_stage',
          'q_primary',
          'phase',
          'self_acceptance',
          'y_level',
          'h_level',
          'spin_loop',
          'spin_step',
          'descent_gate',
          'intent_anchor',
          'summary',
          'situation_summary',
          'situation_topic',
          'sentiment_level',
        ].join(','),
      )
      .eq('user_code', userCode)
      .maybeSingle();

    if (prevErr) {
      console.warn('[IROS/STATE] load previous memory_state not ok (continue)', {
        userCode,
        code: (prevErr as any)?.code,
        message: (prevErr as any)?.message,
      });
    }

    // =========================================================
    // 入力正規化 helpers（この関数内ローカルでOK）
    // =========================================================
    type Phase = 'Inner' | 'Outer';
    type SpinLoop = 'SRI' | 'TCF';
    type DescentGate = 'closed' | 'offered' | 'accepted';

    type QCounts = {
      it_cooldown?: number;
      q_trace?: any;
      [k: string]: any;
    };

    function toInt0to3(v: unknown): number | null {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      return Math.max(0, Math.min(3, Math.round(v)));
    }

    function normalizePhase(v: unknown): Phase | null {
      if (typeof v !== 'string') return null;
      const p = v.trim().toLowerCase();
      if (p === 'inner') return 'Inner';
      if (p === 'outer') return 'Outer';
      return null;
    }

    function normalizeSpinLoop(v: unknown): SpinLoop | null {
      if (typeof v !== 'string') return null;
      const s = v.trim().toUpperCase();
      if (s === 'SRI') return 'SRI';
      if (s === 'TCF') return 'TCF';
      return null;
    }

    function normalizeSpinStep(v: unknown): 0 | 1 | 2 | null {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const n = Math.round(v);
      if (n === 0 || n === 1 || n === 2) return n;
      return null;
    }

    // ✅ boolean互換あり（Aの確定）
    function normalizeDescentGate(v: unknown): DescentGate | null {
      if (v == null) return null;

      // 互換: boolean が来たら
      if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

      if (typeof v !== 'string') return null;
      const s = v.trim().toLowerCase();
      if (s === 'closed') return 'closed';
      if (s === 'offered') return 'offered';
      if (s === 'accepted') return 'accepted';
      return null;
    }

    function normalizeQCounts(v: unknown): QCounts {
      if (!v || typeof v !== 'object') return { it_cooldown: 0 };
      const obj = v as any;
      const cd = typeof obj.it_cooldown === 'number' ? obj.it_cooldown : 0;
      return { ...(obj ?? {}), it_cooldown: cd > 0 ? 1 : 0 };
    }

    // =========================================================
    // q / depth の入力（取りこぼし防止）
    // =========================================================
    const qCodeInput =
      unified?.q?.current ??
      (metaForSave as any)?.qPrimary ??
      (metaForSave as any)?.q_code ??
      (metaForSave as any)?.qCode ??
      null;

    const depthInput =
      unified?.depth?.stage ??
      (metaForSave as any)?.depth ??
      (metaForSave as any)?.depth_stage ??
      (metaForSave as any)?.depthStage ??
      null;

    // --- IT発火の復元（renderMode=IT から推定しない）---
    // 優先順位：引数(itTriggered) > meta.itTriggered > meta.extra.itTriggered
    const itTriggeredResolved: boolean | null =
      typeof itTriggered === 'boolean'
        ? itTriggered
        : typeof (metaForSave as any)?.itTriggered === 'boolean'
          ? (metaForSave as any).itTriggered
          : typeof (metaForSave as any)?.extra?.itTriggered === 'boolean'
            ? (metaForSave as any).extra.itTriggered
            : null;

    const itTriggeredForCounts = itTriggeredResolved === true;

    // =========================================================
    // QTrace（persistでは“再計算しない” / ただし1固定事故だけ防ぐ）
    // =========================================================
    const prevQ = (previous as any)?.q_primary ?? null;

    const qtu = (metaForSave as any)?.qTraceUpdated;
    const qtuLen =
      typeof qtu?.streakLength === 'number' && Number.isFinite(qtu.streakLength)
        ? Math.max(0, Math.floor(qtu.streakLength))
        : null;

    const qt = (metaForSave as any)?.qTrace;
    const qtLen =
      typeof qt?.streakLength === 'number' && Number.isFinite(qt.streakLength)
        ? Math.max(0, Math.floor(qt.streakLength))
        : null;

    let streakQ: string | null = null;
    let streakLength: number | null = null;
    let streakFrom: 'qTraceUpdated' | 'qTrace' | 'fallback' | 'none' = 'none';

    if (qCodeInput) {
      const sameAsPrev = prevQ != null && prevQ === qCodeInput;

      if (qtuLen != null) {
        streakQ = qCodeInput;
        streakLength = Math.max(qtuLen, sameAsPrev ? 2 : 1);
        streakFrom = 'qTraceUpdated';
      } else if (qtLen != null) {
        streakQ = qCodeInput;
        streakLength = Math.max(qtLen, sameAsPrev ? 2 : 1);
        streakFrom = 'qTrace';
      } else {
        streakQ = qCodeInput;
        streakLength = sameAsPrev ? 2 : 1;
        streakFrom = 'fallback';
      }
    } else {
      streakFrom = 'none';
    }

    const qTraceForCounts =
      qCodeInput
        ? {
            prevQ,
            qNow: qCodeInput,
            streakQ,
            streakLength,
            from: streakFrom,
          }
        : null;

    console.log('[IROS/QTrace] persisted', {
      prevQ,
      qNow: qCodeInput,
      streakQ,
      streakLength,
      from: streakFrom,
    });

    // =========================================================
    // 基本入力
    // =========================================================
    const phaseRawInput = (metaForSave as any)?.phase ?? unified?.phase ?? null;
    const phaseInput = normalizePhase(phaseRawInput);

    const selfAcceptanceInput =
      (metaForSave as any)?.selfAcceptance ??
      unified?.selfAcceptance ??
      unified?.self_acceptance ??
      null;

    const yIntInput = toInt0to3((metaForSave as any)?.yLevel ?? unified?.yLevel);
    const hIntInput = toInt0to3((metaForSave as any)?.hLevel ?? unified?.hLevel);

    const situationSummaryInput =
      (metaForSave as any)?.situationSummary ??
      unified?.situation?.summary ??
      (metaForSave as any)?.situation_summary ??
      null;

    const situationTopicInput =
      (metaForSave as any)?.situationTopic ??
      unified?.situation?.topic ??
      (metaForSave as any)?.situation_topic ??
      null;

    const sentimentLevelInput =
      (metaForSave as any)?.sentimentLevel ??
      (metaForSave as any)?.sentiment_level ??
      unified?.sentiment_level ??
      null;

    // =========================================================
    // spin / descentGate は「normalize → merge」する（nullで潰さない）
    // =========================================================
    const spinLoopRawInput =
      (metaForSave as any)?.spinLoop ??
      (metaForSave as any)?.spin_loop ??
      unified?.spin_loop ??
      unified?.spinLoop ??
      null;

    const spinStepRawInput =
      (metaForSave as any)?.spinStep ??
      (metaForSave as any)?.spin_step ??
      unified?.spin_step ??
      unified?.spinStep ??
      null;

    const descentGateRawInput =
      (metaForSave as any)?.descentGate ??
      (metaForSave as any)?.descent_gate ??
      unified?.descent_gate ??
      unified?.descentGate ??
      null;

    const spinLoopNormInput = normalizeSpinLoop(spinLoopRawInput);
    const spinStepNormInput = normalizeSpinStep(spinStepRawInput);
    const descentGateNormInput = normalizeDescentGate(descentGateRawInput);

    const spinLoopNormPrev = normalizeSpinLoop((previous as any)?.spin_loop ?? null);
    const spinStepNormPrev = normalizeSpinStep((previous as any)?.spin_step ?? null);
    const descentGateNormPrev = normalizeDescentGate((previous as any)?.descent_gate ?? null);

    const finalSpinLoop: SpinLoop | null = spinLoopNormInput ?? spinLoopNormPrev ?? null;
    const finalSpinStep: 0 | 1 | 2 | null = spinStepNormInput ?? spinStepNormPrev ?? null;
    const finalDescentGate: DescentGate | null =
      descentGateNormInput ?? descentGateNormPrev ?? null;

    // =========================================================
    // q_counts（IT cooldown / q_trace を一本化）
    // =========================================================
    const prevQCounts = normalizeQCounts((previous as any)?.q_counts);
    const incomingQCounts = qCounts ? normalizeQCounts(qCounts) : null;

    const itResetRequested =
      Boolean((metaForSave as any)?.extra?.itReset) ||
      Boolean((metaForSave as any)?.extra?.resetIT) ||
      Boolean((metaForSave as any)?.extra?.resetItCooldown);

    // 方針：自動ITの“完全停止スイッチ”を開放する（cooldown無効化）
    const nextCooldown = itResetRequested ? 0 : 0;

    const nextQCounts: QCounts = {
      ...(incomingQCounts ?? prevQCounts),
      it_cooldown: nextCooldown,
      ...(qTraceForCounts ? { q_trace: qTraceForCounts } : {}),
      ...(itTriggeredResolved != null ? { it_triggered: itTriggeredResolved } : {}),
      ...(itTriggeredForCounts ? { it_triggered_true: true } : {}),
    };

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      userText: (userText ?? '').slice(0, 80),

      depthInput,
      qCodeInput,
      phaseRawInput,
      phaseInput,

      yLevelRaw: (metaForSave as any)?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: (metaForSave as any)?.hLevel ?? unified?.hLevel ?? null,
      yLevelInt: yIntInput,
      hLevelInt: hIntInput,

      spinLoopRawInput,
      finalSpinLoop,
      spinStepRawInput,
      finalSpinStep,
      descentGateRawInput,
      finalDescentGate,

      itTriggered: itTriggeredResolved ?? null,
      q_counts_prev: prevQCounts,
      q_counts_next: nextQCounts,

      // ITX
      itx_step: stepFinal,
      itx_anchor_event_type: anchorFinal,
      itx_reason: reasonFinal,
      itx_last_at: lastAtFinal,
    });

    // 保存する意味がある最低条件
    if (!depthInput && !qCodeInput) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', { userCode });
      return;
    }

    // =========================================================
    // upsertPayload：null は “保存しない”（過去の値を壊さない）
    // =========================================================
    const upsertPayload: any = {
      user_code: userCode,
      updated_at: new Date().toISOString(),
    };

    if (depthInput) upsertPayload.depth_stage = depthInput;
    if (qCodeInput) upsertPayload.q_primary = qCodeInput;
    if (phaseInput) upsertPayload.phase = phaseInput;

    if (typeof selfAcceptanceInput === 'number') {
      upsertPayload.self_acceptance = selfAcceptanceInput;
    }

    if (typeof yIntInput === 'number') upsertPayload.y_level = yIntInput;
    if (typeof hIntInput === 'number') upsertPayload.h_level = hIntInput;

    if (sentimentLevelInput != null) upsertPayload.sentiment_level = sentimentLevelInput;
    if (situationSummaryInput) upsertPayload.situation_summary = situationSummaryInput;
    if (situationTopicInput) upsertPayload.situation_topic = situationTopicInput;

    // ✅ 文章メモリ（summary）：ある時だけ更新（過去を壊さない）
    const rawUserText =
      (metaForSave as any)?.userText ??
      (metaForSave as any)?.user_text ??
      (metaForSave as any)?.input_text ??
      (metaForSave as any)?.text ??
      null;

    const summaryCandidate =
      (typeof situationSummaryInput === 'string' && situationSummaryInput.trim()) ||
      (typeof rawUserText === 'string' && rawUserText.trim()) ||
      null;

    if (summaryCandidate) {
      const s = summaryCandidate.replace(/\s+/g, ' ').trim();
      upsertPayload.summary = s.length > 200 ? s.slice(0, 200) : s;
    }

    // ✅ 回転3点：final* を入れる（inputがnullでも previous を保持した final になる）
    if (finalSpinLoop) upsertPayload.spin_loop = finalSpinLoop;
    if (typeof finalSpinStep === 'number') upsertPayload.spin_step = finalSpinStep;

    // descent_gate は列がない環境があるので、まず入れて失敗なら外して再試行
    if (finalDescentGate) upsertPayload.descent_gate = finalDescentGate;

    // ✅ q_counts
    upsertPayload.q_counts = nextQCounts;

    // =========================================================
    // ✅ ITX列：列が無いDBがあるので「入れて→無ければ外して再試行」
    // =========================================================
    if (stepFinal) upsertPayload.intent_transition_step = stepFinal;
    if (anchorFinal) upsertPayload.intent_transition_anchor_event_type = anchorFinal;
    if (reasonFinal) upsertPayload.intent_transition_reason = reasonFinal;
    if (lastAtFinal) upsertPayload.intent_transition_last_transition_at = lastAtFinal;

    // 1回目 upsert
    let { error } = await supabase.from('iros_memory_state').upsert(upsertPayload, {
      onConflict: 'user_code',
    });

    // 42703(未定義カラム) のとき、原因列を外して1回だけ再試行（descent_gate / ITX）
    if (error) {
      const code = (error as any)?.code;
      const msg = (error as any)?.message ?? '';

      const missing = (name: string) => code === '42703' && new RegExp(name, 'i').test(msg);

      let retried = false;

      if (missing('descent_gate') && 'descent_gate' in upsertPayload) {
        console.warn('[IROS/STATE] descent_gate missing in DB. retry without it.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.descent_gate;
        retried = true;
      }

      if (missing('intent_transition_step') && 'intent_transition_step' in upsertPayload) {
        console.warn('[IROS/STATE] intent_transition_step missing in DB. drop ITX cols and retry.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.intent_transition_step;
        delete upsertPayload.intent_transition_anchor_event_type;
        delete upsertPayload.intent_transition_reason;
        delete upsertPayload.intent_transition_last_transition_at;
        retried = true;
      }

      if (retried) {
        const retry = await supabase.from('iros_memory_state').upsert(upsertPayload, {
          onConflict: 'user_code',
        });
        error = retry.error ?? null;
      }
    }

    if (error) {
      console.error('[IROS/STATE] persistMemoryStateIfAny failed', { userCode, error });
    } else {
      console.log('[IROS/STATE] persistMemoryStateIfAny ok', {
        userCode,
        saved: Object.keys(upsertPayload),
        depthStage: upsertPayload.depth_stage ?? '(kept)',
        qPrimary: upsertPayload.q_primary ?? '(kept)',
        spinLoop: upsertPayload.spin_loop ?? '(kept)',
        spinStep: upsertPayload.spin_step ?? '(kept)',
        descentGate: upsertPayload.descent_gate ?? '(kept)',
        qCounts: upsertPayload.q_counts ?? '(kept)',
        itx_step: upsertPayload.intent_transition_step ?? '(kept/none)',
      });
    }
  } catch (e) {
    console.error('[IROS/STATE] persistMemoryStateIfAny exception', { userCode, error: e });
  }
}


export async function persistUnifiedAnalysisIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  tenantId: string;
  userText: string;
  assistantText: string;
  metaForSave: any;
  conversationId: string;
}) {
  // TODO: buildUnifiedAnalysis / saveUnifiedAnalysisInline / applyAnalysisToLastUserMessage を移植する
}
