// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (minimal first, expand later)

import type { SupabaseClient } from '@supabase/supabase-js';

function toInt0to3(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3, Math.round(v)));
}

function normalizePhase(v: unknown): 'Inner' | 'Outer' | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop(v: unknown): 'SRI' | 'TCF' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeDescentGate(
  v: unknown
): 'closed' | 'offered' | 'accepted' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'closed') return 'closed';
  if (s === 'offered') return 'offered';
  if (s === 'accepted') return 'accepted';
  return null;
}

function normalizeSpinStep(v: unknown): 0 | 1 | 2 | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n === 0 || n === 1 || n === 2) return n;
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
function pickAnchorEventType(
  metaForSave: any
): 'none' | 'confirm' | 'set' | 'reset' {
  const t1 = metaForSave?.anchorEvent?.type;
  if (t1 === 'none' || t1 === 'confirm' || t1 === 'set' || t1 === 'reset')
    return t1;

  const t2 = metaForSave?.anchorEventType;
  if (t2 === 'none' || t2 === 'confirm' || t2 === 'set' || t2 === 'reset')
    return t2;

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
 */
function shouldWriteIntentAnchorToMemoryState(args: {
  anchorEventType: 'none' | 'confirm' | 'set' | 'reset';
  anchorText: string | null;
}): boolean {
  const { anchorEventType, anchorText } = args;

  // set/reset 以外は絶対に書かない（北極星を動かさない）
  if (anchorEventType !== 'set' && anchorEventType !== 'reset') return false;

  if (!anchorText) return false;

  // メタ発話は set/reset でも拒否
  if (isMetaAnchorText(anchorText)) return false;

  return true;
}

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

    // ★ writer を必ず一本化（skip判定の揺れを消す）
    // ★ さらに y/h は DB 保存と揃えるため整数に丸めて meta にも反映
    const yInt = toInt0to3(metaForSave?.yLevel ?? metaForSave?.unified?.yLevel);
    const hInt = toInt0to3(metaForSave?.hLevel ?? metaForSave?.unified?.hLevel);

    // ★ phase/spin は camel/snake 両対応で拾って、messages 側にも両方入れる（互換）
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

    const meta = {
      ...(metaForSave ?? {}),
      writer: 'handleIrosReply',

      ...(yInt !== null ? { yLevel: yInt } : {}),
      ...(hInt !== null ? { hLevel: hInt } : {}),

      // ✅ 正規化した値を camelCase にも載せる
      ...(phaseNorm ? { phase: phaseNorm } : {}),
      ...(spinLoopNorm ? { spinLoop: spinLoopNorm } : {}),
      ...(typeof spinStepNorm === 'number' ? { spinStep: spinStepNorm } : {}),

      // ✅ 互換：snake_case も同値で載せる（過去コード/集計/デバッグ用）
      ...(phaseNorm ? { phase_mode: phaseNorm } : {}),
      ...(spinLoopNorm ? { spin_loop: spinLoopNorm } : {}),
      ...(typeof spinStepNorm === 'number' ? { spin_step: spinStepNorm } : {}),
    };

    // ✅ messages 保存：text/content を両方入れて互換を維持する
    await fetch(msgUrl.toString(), {
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
  } catch (e) {
    console.error('[IROS/Persist] persistAssistantMessage failed', e);
  }
}

/**
 * Qコードスナップショット（既存の writeQCodeWithEnv に統一）
 */
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

export async function persistMemoryStateIfAny(args: {
  supabase: SupabaseClient;
  userCode: string;
  metaForSave: any;
}) {
  const { supabase, userCode, metaForSave } = args;

  try {
    if (!metaForSave) return;

    // unified を最優先で使う（postProcessReply 後は必ず揃っている）
    const unified: any = metaForSave.unified ?? {};

    const depth = metaForSave.depth ?? unified?.depth?.stage ?? null;
    const qCode = metaForSave.qCode ?? unified?.q?.current ?? null;

    // phase は揺れやすいので正規化して 'Inner' | 'Outer' に寄せる
    const phaseRaw = metaForSave.phase ?? unified?.phase ?? null;
    const phase = normalizePhase(phaseRaw);

    const selfAcceptance =
      metaForSave.selfAcceptance ??
      unified?.selfAcceptance ??
      unified?.self_acceptance ??
      null;

    // ★ y/h は DB が integer なので、必ず 0..3 に丸めて整数化する
    const yInt = toInt0to3(metaForSave?.yLevel ?? unified?.yLevel);
    const hInt = toInt0to3(metaForSave?.hLevel ?? unified?.hLevel);

    // ★ situation 系
    const situationSummary =
      metaForSave.situationSummary ??
      unified?.situation?.summary ??
      metaForSave.situation_summary ??
      null;

    const situationTopic =
      metaForSave.situationTopic ??
      unified?.situation?.topic ??
      metaForSave.situation_topic ??
      null;

    const sentimentLevel =
      metaForSave.sentimentLevel ??
      metaForSave.sentiment_level ??
      unified?.sentiment_level ??
      null;

    // ★ spin
    const spinLoopRaw =
      metaForSave.spinLoop ??
      metaForSave.spin_loop ??
      unified?.spin_loop ??
      unified?.spinLoop ??
      null;

    const spinStepRaw =
      metaForSave.spinStep ??
      metaForSave.spin_step ??
      unified?.spin_step ??
      unified?.spinStep ??
      null;

    const spinLoop = normalizeSpinLoop(spinLoopRaw);
    const spinStep = normalizeSpinStep(spinStepRaw);

    // ★ descentGate（列がある環境だけ入れる前提。値だけ拾う）
    const descentGateRaw =
      metaForSave.descentGate ??
      metaForSave.descent_gate ??
      unified?.descent_gate ??
      unified?.descentGate ??
      null;

    // ✅ 正規化して 'closed'|'offered'|'accepted' に限定
    const descentGate = normalizeDescentGate(descentGateRaw);

    // ★ intent_anchor（jsonb）
    const intentAnchorRaw =
      metaForSave.intent_anchor ??
      metaForSave.intentAnchor ??
      null;

    // ★ 固定北（SUN）はDBアンカー更新の対象にしない（常に“背後の北”）
    const isFixedNorthSun =
      metaForSave?.fixedNorth?.key === 'SUN' ||
      metaForSave?.intent_anchor?.fixed === true ||
      metaForSave?.intentAnchor?.fixed === true;

    const anchorText = extractAnchorText(intentAnchorRaw);

    // ✅ アンカー更新イベント（北極星更新の許可）
    const anchorEventType = pickAnchorEventType(metaForSave);

    // ✅ DBへ書くかどうか（set/reset のときだけ）
    //    ただし固定北（SUN）は絶対に書かない
    const willWriteAnchor = isFixedNorthSun
      ? false
      : shouldWriteIntentAnchorToMemoryState({
          anchorEventType,
          anchorText,
        });

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      depth,
      qCode,
      phaseRaw,
      phase,
      yLevelRaw: metaForSave?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: metaForSave?.hLevel ?? unified?.hLevel ?? null,
      yLevelInt: yInt,
      hLevelInt: hInt,
      spinLoopRaw,
      spinLoop,
      spinStepRaw,
      spinStep,
      descentGateRaw,
      descentGate,
      hasIntentAnchor: !!intentAnchorRaw,
      anchorText,
      anchorEventType,
      willWriteAnchor,
    });

    // 保存する意味がある最低条件（ここは維持）
    if (!depth && !qCode) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', {
        userCode,
      });
      return;
    }

    // ✅ 重要：null は “保存しない” payload にする（過去の値を壊さない）
    const upsertPayload: any = {
      user_code: userCode,
      updated_at: new Date().toISOString(),
    };

    if (depth) upsertPayload.depth_stage = depth;
    if (qCode) upsertPayload.q_primary = qCode;
    if (phase) upsertPayload.phase = phase;

    if (typeof selfAcceptance === 'number')
      upsertPayload.self_acceptance = selfAcceptance;

    if (typeof yInt === 'number') upsertPayload.y_level = yInt;
    if (typeof hInt === 'number') upsertPayload.h_level = hInt;

    if (sentimentLevel != null) upsertPayload.sentiment_level = sentimentLevel;
    if (situationSummary) upsertPayload.situation_summary = situationSummary;
    if (situationTopic) upsertPayload.situation_topic = situationTopic;

    if (spinLoop) upsertPayload.spin_loop = spinLoop;
    if (typeof spinStep === 'number') upsertPayload.spin_step = spinStep;

    // ✅ descent_gate：列が無い環境が混ざるので「入れて失敗したら外してリトライ」方式にする
    if (descentGate) upsertPayload.descent_gate = descentGate;

    // ✅ ✅ ✅ 核心：intent_anchor は set/reset のときだけ保存（通常ターンは絶対に触らない）
    if (willWriteAnchor && intentAnchorRaw) {
      upsertPayload.intent_anchor = intentAnchorRaw;
    }

    // 1回目 upsert
    let { error } = await supabase
      .from('iros_memory_state')
      .upsert(upsertPayload, { onConflict: 'user_code' });

    // ✅ 42703(未定義カラム) で descent_gate が原因なら、外して1回だけ再試行
    if (error) {
      const code = (error as any)?.code;
      const msg = (error as any)?.message ?? '';
      const isMissingDescentGate =
        code === '42703' && /descent_gate/i.test(msg);

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
      console.error('[IROS/STATE] persistMemoryStateIfAny failed', {
        userCode,
        error,
      });
    } else {
      console.log('[IROS/STATE] persistMemoryStateIfAny ok', {
        userCode,
        saved: Object.keys(upsertPayload),
        depthStage: upsertPayload.depth_stage ?? '(kept)',
        qPrimary: upsertPayload.q_primary ?? '(kept)',
        spinLoop: upsertPayload.spin_loop ?? '(kept)',
        spinStep: upsertPayload.spin_step ?? '(kept)',
        descentGate: upsertPayload.descent_gate ?? '(kept)',
        intentAnchor: upsertPayload.intent_anchor ? '(updated)' : '(kept)',
      });
    }
  } catch (e) {
    console.error('[IROS/STATE] persistMemoryStateIfAny exception', {
      userCode,
      error: e,
    });
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
