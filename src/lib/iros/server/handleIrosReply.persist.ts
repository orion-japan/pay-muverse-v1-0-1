// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (minimal first, expand later)

import type { SupabaseClient } from '@supabase/supabase-js';

/* =========================
 * Helpers
 * ========================= */

type Phase = 'Inner' | 'Outer';
type SpinLoop = 'SRI' | 'TCF';
type DescentGate = 'closed' | 'offered' | 'accepted';
type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

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
    metaForSave.qTrace && typeof metaForSave.qTrace === 'object'
      ? metaForSave.qTrace
      : null;

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
  const streakLength =
    lenQ == null && lenU == null ? undefined : Math.max(lenQ ?? 0, lenU ?? 0);

  // 形は qTrace + qTraceUpdated をマージして「最終形」を作る
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
    typeof mergedQTrace.streakLength === 'number'
      ? Math.max(uncoverPrev, mergedQTrace.streakLength)
      : uncoverPrev;

  return {
    ...metaForSave,
    qTrace: mergedQTrace,
    // ✅ ここも重要：DBに入る qTraceUpdated は常に “最終形” に揃える
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
  const {
    reqOrigin,
    authorizationHeader,
    conversationId,
    userCode,
    assistantText,
    metaForSave,
  } = args;

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

    const phaseNorm = normalizePhase(phaseRaw);
    const spinLoopNorm = normalizeSpinLoop(spinLoopRaw);
    const spinStepNorm = normalizeSpinStep(spinStepRaw);

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

      // 互換：snake_case も同値で載せる（過去コード/集計/デバッグ用）
      ...(phaseNorm ? { phase_mode: phaseNorm } : {}),
      ...(spinLoopNorm ? { spin_loop: spinLoopNorm } : {}),
      ...(typeof spinStepNorm === 'number' ? { spin_step: spinStepNorm } : {}),
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
    const unified: any = m?.unified ?? null;

    const q: any = m?.qCode ?? m?.q_code ?? unified?.q?.current ?? null;
    const stage: any = m?.depth ?? m?.depth_stage ?? unified?.depth?.stage ?? null;

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
        extra: { _from: 'handleIrosReply.persist' },
      });
    } else {
      console.warn('[IROS/Q] skip persistQCodeSnapshotIfAny because q is null');
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
  userText: string; // ★追加
  metaForSave: any;
}) {
  const { supabase, userCode, userText, metaForSave } = args;

  try {
    if (!metaForSave) return;

// ✅ A: previous を先に取得（merge の土台）
const { data: previous, error: prevErr } = await supabase
  .from('iros_memory_state')
  .select(
    [
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
    ].join(',')
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


    // unified を最優先で使う（postProcessReply 後は必ず揃っている）
    const unified: any = metaForSave.unified ?? {};

    const depthInput = metaForSave.depth ?? unified?.depth?.stage ?? null;
    const qCodeInput = metaForSave.qCode ?? unified?.q?.current ?? null;

// =========================
// QTrace 更新（streak育成）
// =========================

const prevQ = previous?.q_primary ?? null;

let streakQ: string | null = null;
let streakLength = 1;

if (qCodeInput && prevQ === qCodeInput) {
  streakQ = qCodeInput;
  const prevTrace = metaForSave?.qTrace;
  const prevLen =
    typeof prevTrace?.streakLength === 'number'
      ? prevTrace.streakLength
      : 1;
  streakLength = prevLen + 1;
} else if (qCodeInput) {
  streakQ = qCodeInput;
  streakLength = 1;
}

// metaForSave に反映（generate 側が拾う）
metaForSave.qTrace = {
  lastQ: qCodeInput,
  dominantQ: qCodeInput,
  streakQ,
  streakLength,
};
console.log('[IROS/QTrace] updated', {
  prevQ,
  qNow: qCodeInput,
  streakQ,
  streakLength,
});

    const phaseRawInput = metaForSave.phase ?? unified?.phase ?? null;
    const phaseInput = normalizePhase(phaseRawInput);

    const selfAcceptanceInput =
      metaForSave.selfAcceptance ??
      unified?.selfAcceptance ??
      unified?.self_acceptance ??
      null;

    // y/h は DB が integer なので、必ず 0..3 に丸めて整数化する
    const yIntInput = toInt0to3(metaForSave?.yLevel ?? unified?.yLevel);
    const hIntInput = toInt0to3(metaForSave?.hLevel ?? unified?.hLevel);

    // situation
    const situationSummaryInput =
      metaForSave.situationSummary ??
      unified?.situation?.summary ??
      metaForSave.situation_summary ??
      null;

    const situationTopicInput =
      metaForSave.situationTopic ??
      unified?.situation?.topic ??
      metaForSave.situation_topic ??
      null;

    const sentimentLevelInput =
      metaForSave.sentimentLevel ??
      metaForSave.sentiment_level ??
      unified?.sentiment_level ??
      null;

    // --------
    // ✅ A: spin / descentGate は「normalize → merge」する（nullで潰さない）
    // --------
    const spinLoopRawInput =
      metaForSave.spinLoop ??
      metaForSave.spin_loop ??
      unified?.spin_loop ??
      unified?.spinLoop ??
      null;

    const spinStepRawInput =
      metaForSave.spinStep ??
      metaForSave.spin_step ??
      unified?.spin_step ??
      unified?.spinStep ??
      null;

    const descentGateRawInput =
      metaForSave.descentGate ??
      metaForSave.descent_gate ??
      unified?.descent_gate ??
      unified?.descentGate ??
      null;

    const spinLoopNormInput = normalizeSpinLoop(spinLoopRawInput);
    const spinStepNormInput = normalizeSpinStep(spinStepRawInput);
    const descentGateNormInput = normalizeDescentGate(descentGateRawInput);

    const spinLoopNormPrev = normalizeSpinLoop(previous?.spin_loop ?? null);
    const spinStepNormPrev = normalizeSpinStep(previous?.spin_step ?? null);
    const descentGateNormPrev = normalizeDescentGate(previous?.descent_gate ?? null);

    // ✅ merge ルール（確定仕様）
    const finalSpinLoop: SpinLoop | null = spinLoopNormInput ?? spinLoopNormPrev ?? null;
    const finalSpinStep: 0 | 1 | 2 | null = spinStepNormInput ?? spinStepNormPrev ?? null;
    const finalDescentGate: DescentGate | null = descentGateNormInput ?? descentGateNormPrev ?? null;

    // intent_anchor（jsonb）
    const intentAnchorRaw =
      metaForSave.intent_anchor ??
      metaForSave.intentAnchor ??
      null;

    const anchorText = extractAnchorText(intentAnchorRaw);

    // アンカー更新イベント
    const anchorEventType = pickAnchorEventType(metaForSave);

    // 固定北（SUN）判定
    const fixedSun = isFixedNorthSun(metaForSave);

    // set/reset 判定（固定SUNなら常に keep）
    const anchorDecision = fixedSun
      ? { action: 'keep' as const }
      : shouldWriteIntentAnchorToMemoryState({ anchorEventType, anchorText });

    // 追加の安全策：メタ発話が紛れたら強制 keep
    const metaLike = anchorText ? isMetaAnchorText(anchorText) : false;
    const finalAnchorDecision =
      metaLike && anchorDecision.action !== 'keep' ? { action: 'keep' as const } : anchorDecision;

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      userText: (userText ?? '').slice(0, 80),

      depthInput,
      qCodeInput,
      phaseRawInput,
      phaseInput,

      yLevelRaw: metaForSave?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: metaForSave?.hLevel ?? unified?.hLevel ?? null,
      yLevelInt: yIntInput,
      hLevelInt: hIntInput,

      spinLoopRawInput,
      spinLoopNormInput,
      spinLoopNormPrev,
      finalSpinLoop,

      spinStepRawInput,
      spinStepNormInput,
      spinStepNormPrev,
      finalSpinStep,

      descentGateRawInput,
      descentGateNormInput,
      descentGateNormPrev,
      finalDescentGate,

      fixedSun,
      anchorText,
      anchorEventType,
      anchorDecision: finalAnchorDecision.action,
    });

    // 保存する意味がある最低条件
    if (!depthInput && !qCodeInput) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', { userCode });
      return;
    }

    // null は “保存しない” payload にする（過去の値を壊さない）
    // ※ただし回転3点は final* を保存する（inputがnullでも previous を保持）
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

    /* ✅ 文章メモリ（summary）
       - situationSummary を最優先
       - 無ければ metaForSave からユーザー原文っぽいものを拾う
       - ある時だけ保存（過去の summary は壊さない）
    */
    const rawUserText =
      metaForSave?.userText ??
      metaForSave?.user_text ??
      metaForSave?.input_text ??
      metaForSave?.text ??
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

    // ✅ 核心：intent_anchor は set/reset のときだけ触る（SUN固定 or keep は触らない）
    if (finalAnchorDecision.action === 'set' && intentAnchorRaw) {
      upsertPayload.intent_anchor = intentAnchorRaw;
    } else if (finalAnchorDecision.action === 'reset') {
      upsertPayload.intent_anchor = null;
    }

    // 1回目 upsert
    let { error } = await supabase
      .from('iros_memory_state')
      .upsert(upsertPayload, { onConflict: 'user_code' });

    // 42703(未定義カラム) で descent_gate が原因なら、外して1回だけ再試行
    if (error) {
      const code = (error as any)?.code;
      const msg = (error as any)?.message ?? '';
      const isMissingDescentGate = code === '42703' && /descent_gate/i.test(msg);

      if (isMissingDescentGate && 'descent_gate' in upsertPayload) {
        console.warn('[IROS/STATE] descent_gate missing in DB. retry without it.', {
          userCode,
          code,
          message: msg,
        });

        delete upsertPayload.descent_gate;

        const retry = await supabase
          .from('iros_memory_state')
          .upsert(upsertPayload, { onConflict: 'user_code' });

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
        intentAnchor:
          'intent_anchor' in upsertPayload
            ? upsertPayload.intent_anchor === null
              ? '(cleared)'
              : '(updated)'
            : '(kept)',
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
