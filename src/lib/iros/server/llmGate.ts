// src/lib/iros/server/llmGate.ts
// iros — LLM Gate (Policy -> Execute)
//
// 目的：
// - 「LLMを呼ぶ資格（allowLLM_final）」と「実際に呼ぶか」を分離する
// - 入口4通り（CALL_LLM / SKIP_SLOTPLAN / SKIP_SILENCE / SKIP_POLICY）を確定して meta に刻む
// - slotPlan は「最終(FINAL)」と「足場(SCAFFOLD)」を分離する
// - ここでは “OpenAIを叩かない”。叩く直前に finalize を呼ぶ運用
//
// ✅ v2 方針（重要 / 新憲法 正式）
// - 「水増し」はしない（expand/filler は render 側の責務）
// - LLM に渡すのは「seed（rewriteSeed）」であり、本文採用用（resolvedText）とは分離する
// - SCAFFOLD は “LLM自体を呼ばない”（「呼ぶのに採用しない」混乱を構造で排除）
// - SKIP 系 decision には resolvedText を必ず載せる（本文採用OK）
// - CALL_LLM decision では resolvedText を **原則 null**（本文採用禁止）、rewriteSeed にのみ載せる
//
// ✅ Phase11 重要（今回の修正ポイント）
// - FINAL slotPlan は「テンプレ固定化」を防ぐため、原則 CALL_LLM にする
//   （slotPlan が non-empty でも SKIP しない）
// - 例外：資格なし / 明示沈黙 / SCAFFOLD / slotsが無い通常テキストは従来通り
//
/* eslint-disable @typescript-eslint/no-explicit-any */

import { IROS_FLAGS } from '@/lib/iros/config/flags';

export type LlmGateDecision =
  | {
      entry: 'SKIP_POLICY';
      reason: string;
      // ✅ 本文採用OK（route/handle側が本文として採用してよい）
      resolvedText: string | null;
      // ✅ seed（LLM用）。SKIPでもデバッグ/将来用に載せてよい
      rewriteSeed: string | null;
    }
  | {
      entry: 'SKIP_SILENCE';
      reason: string;
      resolvedText: string | null;
      rewriteSeed: string | null;
    }
  | {
      entry: 'SKIP_SLOTPLAN';
      reason: string;
      resolvedText: string | null;
      rewriteSeed: string | null;
    }
  | {
      entry: 'CALL_LLM';
      reason: string;
      // ✅ CALL_LLM では本文採用を禁止（採用すると directive/@TAG 漏洩や短文化の温床になる）
      resolvedText: null;
      // ✅ LLM に渡す seed（@OBS/@SHIFT 等を含んでいてよい）
      rewriteSeed: string | null;
    };

export type SlotPlanPolicy = 'FINAL' | 'SCAFFOLD' | 'UNKNOWN';

export type LlmGateProbeInput = {
  conversationId: string;
  userCode: string;

  // 「資格」: handleIrosReply.ts で finalAllow を確定した値
  allowLLM_final: boolean;

  // 周辺状況（推測しない）
  brakeReason?: string | null;
  speechAct?: string | null;

  // 既に本文がある（slotをレンダ済み等）。無ければ slot から candidate を作る
  finalAssistantTextNow?: string | null;

  // slotPlan の有無ヒント（呼び出し側が持っている値）
  slotPlanLen?: number | null;
  hasSlots?: boolean | null;

  // slotPlan の性質（FINAL/SCAFFOLD）
  slotPlanPolicy?: SlotPlanPolicy | null;

  // slot から candidate を作るための meta（複数パスに対応）
  meta?: any;
};

export type LlmGateProbeOutput = {
  decision: LlmGateDecision;
  patch: {
    allowLLM_final: boolean;
    brakeReason: string | null;
    speechAct: string | null;
    slotPlanLen: number | null;
    hasSlots: boolean | null;
    slotPlanPolicy: SlotPlanPolicy;

    // 実質本文（candidate含む）
    finalAssistantTextLen: number;
    finalAssistantTextHead: string;

    llmEntry: LlmGateDecision['entry'];
    llmSkipReason: string | null;

    // デバッグ用（候補文がある時だけ埋まる）
    finalAssistantTextCandidateLen?: number | null;
    finalAssistantTextCandidateHead?: string | null;

    // ✅ 新憲法：seed と本文採用を分離してログに残す（SQLで追える）
    resolvedTextLen?: number | null;
    rewriteSeedLen?: number | null;

    // ✅ Phase11: 強制CALL（log証拠用）
    finalForceCall?: boolean | null;
    finalForceCallReason?: string | null;
  };
};

// ---------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------

function head(v: any, n = 48): string {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function normPolicy(v: any): SlotPlanPolicy {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'FINAL') return 'FINAL';
  if (s === 'SCAFFOLD') return 'SCAFFOLD';
  return 'UNKNOWN';
}

function normText(v: any): string {
  return String(v ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function slotsOkFromHints(args: { slotPlanLen: number | null; hasSlots: boolean | null }) {
  const { slotPlanLen, hasSlots } = args;
  if (typeof slotPlanLen === 'number') return slotPlanLen > 0;
  return hasSlots === true;
}

// --- ADD: rewriteSeed builder (SHIFT + CTX + OBS + SEED_TEXT) ---
// ✅ 目的：LLMが迷わない seed を固定で作る（本文採用とは分離）
// - @SHIFT: 出力契約（semantic_answer）
// - @CTX  : メタの短い要約（JSONは渡さず短文化）
// - @OBS  : ユーザー生文（必須）
// - SEED_TEXT: slots 由来の本文（あれば）
function buildWriterRewriteSeed(args: {
  userText: string;
  seedText: string;
  meta?: any;
}): string {
  const n = (s: any) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

  const user = n(args.userText);
  const seed = n(args.seedText);
  const meta = args.meta ?? {};

  // ✅ “メタは背景”として短く（LLMが迷わない程度）
  const q =
    meta?.qCode ??
    meta?.q_primary ??
    meta?.qPrimary ??
    meta?.memoryState?.qPrimary ??
    meta?.memoryState?.q_primary ??
    null;

  const depth =
    meta?.depthStage ??
    meta?.depth_stage ??
    meta?.memoryState?.depthStage ??
    meta?.memoryState?.depth_stage ??
    null;

  const phase =
    meta?.phase ??
    meta?.memoryState?.phase ??
    null;

  const layer =
    meta?.intentLayer ??
    meta?.intent_layer ??
    meta?.memoryState?.intentLayer ??
    meta?.memoryState?.intent_layer ??
    null;

  const summary =
    meta?.situationSummary ??
    meta?.situation_summary ??
    meta?.memoryState?.situationSummary ??
    meta?.memoryState?.situation_summary ??
    meta?.summary ??
    meta?.memoryState?.summary ??
    null;

  const ctxParts: string[] = [];
  if (q) ctxParts.push(`Q=${String(q)}`);
  if (depth) ctxParts.push(`Depth=${String(depth)}`);
  if (phase) ctxParts.push(`Phase=${String(phase)}`);
  if (layer) ctxParts.push(`Layer=${String(layer)}`);
  if (summary && String(summary).trim()) ctxParts.push(`Summary=${String(summary).trim()}`);

  const ctxLine = ctxParts.length ? ctxParts.join(' / ') : '';

  // ✅ SHIFT（出力契約）— あなたの指定を固定で入れる
  const shift = [
    '@SHIFT {',
    '  "kind":"semantic_answer",',
    '  "output_contract":[',
    '    "1行目：Yes/No か核心",',
    '    "2行目：短い理由"',
    '  ],',
    '  "rules":[',
    '    "テンプレ/ボイラープレート禁止",',
    '    "平易な言葉",',
    '    "質問で逃げない（最大1個まで）"',
    '  ],',
    '  "forbid":["diagnosis","preach","hard_guidance","forced_task"],',
    '  "questions_max":1',
    '}',
  ].join('\n');

  const obs = user ? `@OBS {"user":${JSON.stringify(user)}}` : '';
  const ctx = ctxLine ? `@CTX ${JSON.stringify(ctxLine)}` : '';

  // ✅ seedText は「最後」に置く（契約→背景→入力→素材の順）
  const out: string[] = [];
  out.push(shift);
  if (ctx) out.push(ctx);
  if (obs) out.push(obs);
  if (seed) out.push(seed);

  return out.filter(Boolean).join('\n\n').trim();
}



// ---------------------------------------------------------------------
// slots helpers
// ---------------------------------------------------------------------

function extractSlotsObj(meta: any): any | null {
  if (!meta || typeof meta !== 'object') return null;

  // ✅ 現場で “あり得る場所” を列挙
  const candidates = [
    meta?.framePlan?.slots,
    meta?.framePlan?.framePlan?.slots, // 二重ラップ
    meta?.framePlan?.slotPlan?.slots, // 旧
    meta?.slotPlan?.slots, // さらに旧
    meta?.slots, // 最旧
    meta?.extra?.framePlan?.slots, // extraに入るケース
  ];

  for (const s of candidates) {
    if (!s) continue;
    if (Array.isArray(s) && s.length > 0) return s;
    if (typeof s === 'object' && Object.keys(s).length > 0) return s;
  }
  return null;
}

function pickSlotText(v: any): string {
  const t =
    typeof v === 'string'
      ? v
      : typeof v?.text === 'string'
        ? v.text
        : typeof v?.content === 'string'
          ? v.content
          : typeof v?.value === 'string'
            ? v.value
            : typeof v?.message === 'string'
              ? v.message
              : typeof v?.out === 'string'
                ? v.out
                : '';
  return normText(t);
}

function buildTextFromSlots(slotsObj: any | null): string | null {
  if (!slotsObj) return null;

  // ✅ structured の優先順（seedとして扱いやすい順）
  const ORDER = [
    'OBS',
    'SHIFT',
    'NEXT',
    'SAFE',
    'INSIGHT',
    // legacy / fallback
    'core',
    'add',
    'one',
    'two',
    'three',
    'close',
    'ending',
  ];

  // (1) Array slots: [{ key, content }, ...]
  if (Array.isArray(slotsObj)) {
    const items = slotsObj
      .map((s: any) => {
        const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim();
        return { key, text: pickSlotText(s) };
      })
      .filter((x) => x.text.length > 0);

    if (items.length === 0) return null;

    // sort by ORDER (unknown keys keep stable-ish alphabetical)
    items.sort((a, b) => {
      const ia = ORDER.indexOf(a.key);
      const ib = ORDER.indexOf(b.key);
      if (ia === -1 && ib === -1) return a.key.localeCompare(b.key);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const out = items.map((x) => x.text).join('\n');
    return out.length ? out : null;
  }

  // (2) Object slots: { OBS:'...', SHIFT:'...' } / { core:{text:'...'} }
  if (typeof slotsObj === 'object') {
    const keysAll = Object.keys(slotsObj);
    const keys: string[] = [];

    for (const k of ORDER) if (keysAll.includes(k)) keys.push(k);
    for (const k of keysAll) if (!keys.includes(k)) keys.push(k);

    const parts: string[] = [];
    for (const k of keys) {
      const s = pickSlotText((slotsObj as any)[k]);
      if (s) parts.push(s);
    }

    const out = parts.join('\n');
    return out.length ? out : null;
  }

  return null;
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

export function probeLlmGate(input: LlmGateProbeInput): LlmGateProbeOutput {
  const conversationId = input.conversationId;
  const userCode = input.userCode;

  const allowLLM_final = input.allowLLM_final;
  const brakeReason = input.brakeReason ?? null;
  const speechAct = input.speechAct ?? null;

  const slotPlanLen = input.slotPlanLen ?? null;
  const hasSlots = input.hasSlots ?? null;
  const policy = normPolicy(input.slotPlanPolicy);

  const textNow = normText(input.finalAssistantTextNow);
  const textNowLen = textNow.length;

  const slotsObj = extractSlotsObj(input.meta ?? null);
  const candidate = normText(buildTextFromSlots(slotsObj) ?? '');
  const candidateLen = candidate.length;

  // ✅ 実質本文（raw seed source）：textNow 優先、なければ candidate
  const effectiveText = textNowLen > 0 ? textNow : candidate;
  const effectiveLen = effectiveText.length;

  const slotsOk = slotsOkFromHints({ slotPlanLen, hasSlots });

  const mk = (
    decision: LlmGateDecision,
    extras?: { finalForceCall?: boolean; finalForceCallReason?: string },
  ): LlmGateProbeOutput => {
    const resolvedLen =
      decision.entry === 'CALL_LLM' ? null : decision.resolvedText ? String(decision.resolvedText).length : null;
    const seedLen = decision.rewriteSeed ? String(decision.rewriteSeed).length : null;

    return {
      decision,
      patch: {
        allowLLM_final,
        brakeReason,
        speechAct,
        slotPlanLen,
        hasSlots,
        slotPlanPolicy: policy,

        finalAssistantTextLen: effectiveLen,
        finalAssistantTextHead: head(effectiveText),

        llmEntry: decision.entry,
        llmSkipReason: decision.entry === 'CALL_LLM' ? null : decision.reason,

        finalAssistantTextCandidateLen: candidateLen > 0 ? candidateLen : null,
        finalAssistantTextCandidateHead: candidateLen > 0 ? head(candidate) : null,

        resolvedTextLen: resolvedLen,
        rewriteSeedLen: seedLen,

        finalForceCall: extras?.finalForceCall ?? null,
        finalForceCallReason: extras?.finalForceCallReason ?? null,
      },
    };
  };

  // (A) 資格なし
  if (!allowLLM_final) {
    return mk({
      entry: 'SKIP_POLICY',
      reason: 'allowLLM_final=false',
      resolvedText: effectiveLen ? effectiveText : null, // ✅ 本文採用OK
      rewriteSeed: effectiveLen ? effectiveText : null, // （LLM呼ばないのでそのまま保持）
    });
  }

  // (B) 明示沈黙
  const brake = String(brakeReason ?? '');
  const act = String(speechAct ?? '').toUpperCase();
  if (brake === 'Q1_SUPPRESS' || act === '無言アクト') {
    return mk({
      entry: 'SKIP_SILENCE',
      reason: 'brakeReason=Q1_SUPPRESS or speechAct=無言アクト',
      resolvedText: effectiveLen ? effectiveText : null, // ✅ 本文採用OK
      rewriteSeed: effectiveLen ? effectiveText : null, // （LLM呼ばないのでそのまま保持）
    });
  }

  // (C) ✅ SCAFFOLD：LLMを呼ばない
  if (slotsOk && policy === 'SCAFFOLD') {
    return mk({
      entry: 'SKIP_SLOTPLAN',
      reason: 'SCAFFOLD_POLICY__NO_LLM',
      resolvedText: effectiveLen ? effectiveText : null, // ✅ 本文採用OK（ただし seed/タグ混入は上位で扱う）
      rewriteSeed: effectiveLen ? effectiveText : null, // （LLM呼ばないのでそのまま保持）
    });
  }

  // (D) ✅ Phase11：診断FINALのみ「強制CALL無効化」の緊急退避口を残す
  const isIrDiagnosisTurn =
    input?.meta?.isIrDiagnosisTurn === true ||
    input?.meta?.mode === 'diagnosis' ||
    input?.meta?.framePlan?.isIrDiagnosisTurn === true ||
    input?.meta?.framePlan?.mode === 'diagnosis';

  // デフォルトは "許可"（= CALL_LLM）。0 のときだけ無効化。
  const allowDiagnosisFinalForceCall =
    String(process.env.IROS_DIAGNOSIS_ALLOW_FINAL_FORCE_CALL ?? '1').trim() !== '0';

  if (slotsOk && policy === 'FINAL' && isIrDiagnosisTurn && !allowDiagnosisFinalForceCall) {
    return mk({
      entry: 'SKIP_SLOTPLAN',
      reason: 'DIAGNOSIS_FINAL__SKIP_FORCE_CALL (disabled by env=0)',
      resolvedText: effectiveLen ? effectiveText : null, // ✅ 本文採用OK（旧挙動）
      rewriteSeed: effectiveLen ? effectiveText : null, // （LLM呼ばないのでそのまま保持）
    });
  }

  // (E) ✅ Phase11：FINAL slotPlan は原則 CALL_LLM（本文採用は禁止、seedのみ渡す）
  if (slotsOk && policy === 'FINAL') {
    // ✅ feature flag（import重複事故を避けるため dynamic import）
    const retryFinalForceCall = IROS_FLAGS.retryFinalForceCall;


    // ✅ CALL_LLM のときだけ：SHIFT + CTX + OBS + SEED_TEXT を組んで rewriteSeed に渡す
    const userTextForSeed =
      (input as any)?.meta?.userTextClean ??
      (input as any)?.meta?.userText ??
      '';

    const rewriteSeedFinal = effectiveLen
      ? buildWriterRewriteSeed({
          userText: userTextForSeed,
          seedText: effectiveText,
          meta: input.meta,
        })
      : null;

    // --- ここがスイッチ ---
    // retryFinalForceCall=false のとき：
    // - “FINAL_FORCE_CALL” 扱い（finalForceCall:true）をやめる
    // - ただし CALL_LLM は維持して会話停止を増やさない
    if (!retryFinalForceCall) {
      console.warn('[IROS/LLM_GATE][FINAL_CALL][NO_FORCE]', {
        conversationId,
        userCode,
        slotPlanPolicy: policy,
        slotPlanLen,
        hasSlots,
        effectiveLen,
        head: head(effectiveText, 80),
      });

      return mk(
        {
          entry: 'CALL_LLM',
          reason: 'FINAL_CALL (force disabled by IROS_RETRY_FINAL_FORCE_CALL=false)',
          resolvedText: null, // ✅ 新憲法：CALL_LLM は本文採用禁止
          rewriteSeed: rewriteSeedFinal,
        },
        { finalForceCall: false, finalForceCallReason: 'FINAL_CALL_NO_FORCE' },
      );
    }

    // ✅ 既存挙動：FINAL_FORCE_CALL（従来通り）
    console.warn('[IROS/LLM_GATE][FINAL_FORCE_CALL]', {
      conversationId,
      userCode,
      slotPlanPolicy: policy,
      slotPlanLen,
      hasSlots,
      effectiveLen,
      head: head(effectiveText, 80),
    });

    return mk(
      {
        entry: 'CALL_LLM',
        reason: 'FINAL_FORCE_CALL (avoid template lock)',
        resolvedText: null, // ✅ 新憲法：CALL_LLM は本文採用禁止
        rewriteSeed: rewriteSeedFinal,
      },
      { finalForceCall: true, finalForceCallReason: 'FINAL_FORCE_CALL' },
    );
  }


  // (F) slots があるが policy が UNKNOWN：守りで CALL_LLM（seed を渡す）
  if (slotsOk) {
    const userTextForSeed =
      (input as any)?.meta?.userTextClean ??
      (input as any)?.meta?.userText ??
      '';

    const rewriteSeedUnknown = effectiveLen
      ? buildWriterRewriteSeed({
          userText: userTextForSeed,
          seedText: effectiveText,
          meta: input.meta,
        })
      : null;

    return mk({
      entry: 'CALL_LLM',
      reason: 'slotsOk but slotPlanPolicy=UNKNOWN (fallback to CALL_LLM)',
      resolvedText: null, // ✅ 新憲法：CALL_LLM は本文採用禁止
      rewriteSeed: rewriteSeedUnknown,
    });
  }

  // (G) slots が無いが本文がある：そのまま返す（LLM不要）
  if (effectiveLen > 0) {
    return mk({
      entry: 'SKIP_SLOTPLAN',
      reason: 'no slots but have non-empty text',
      resolvedText: effectiveText, // ✅ 本文採用OK
      rewriteSeed: effectiveText, // （LLM呼ばないのでそのまま保持）
    });
  }

  // (H) 何も無い：最後の砦として CALL_LLM（空seedでも呼ぶ）
  return mk({
    entry: 'CALL_LLM',
    reason: 'no slots and empty text (last resort)',
    resolvedText: null, // ✅ 本文採用禁止
    rewriteSeed: null,
  });
}

// ---------------------------------------------------------------------
// meta write
// ---------------------------------------------------------------------

export function writeLlmGateToMeta(metaForSave: any, patch: LlmGateProbeOutput['patch']): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;
  metaForSave.extra = metaForSave.extra ?? {};

  // ✅ ネスト（詳細）
  (metaForSave.extra as any).llmGate = {
    ...(metaForSave.extra as any).llmGate,
    ...patch,
    at: new Date().toISOString(),
  };

  // ✅ 直下ミラー（DB検索用）
  (metaForSave.extra as any).llmEntry = patch.llmEntry;
  (metaForSave.extra as any).llmSkipReason = patch.llmSkipReason;

  // ✅ FINAL強制CALLの証拠（SQLで追える）
  (metaForSave.extra as any).finalForceCall = patch.finalForceCall ?? null;
  (metaForSave.extra as any).finalForceCallReason = patch.finalForceCallReason ?? null;

  // ✅ 新憲法：seed/本文の長さを直下にも残す（調査の1手短縮）
  (metaForSave.extra as any).resolvedTextLen = patch.resolvedTextLen ?? null;
  (metaForSave.extra as any).rewriteSeedLen = patch.rewriteSeedLen ?? null;
}

// ---------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------

export function logLlmGate(
  tag: 'PROBE' | 'FINAL',
  args: {
    conversationId: string;
    userCode: string;
    patch: LlmGateProbeOutput['patch'];
    decision?: LlmGateDecision;
  },
): void {
  const { conversationId, userCode, patch, decision } = args;

  console.log(`[IROS/LLM_GATE][${tag}]`, {
    conversationId,
    userCode,

    llmEntry: patch.llmEntry,
    llmSkipReason: patch.llmSkipReason,

    allowLLM_final: patch.allowLLM_final,
    brakeReason: patch.brakeReason,
    speechAct: patch.speechAct,

    slotPlanLen: patch.slotPlanLen,
    hasSlots: patch.hasSlots,
    slotPlanPolicy: patch.slotPlanPolicy,

    finalAssistantTextLen: patch.finalAssistantTextLen,
    finalAssistantTextHead: patch.finalAssistantTextHead,

    finalAssistantTextCandidateLen: patch.finalAssistantTextCandidateLen ?? null,
    finalAssistantTextCandidateHead: patch.finalAssistantTextCandidateHead ?? null,

    finalForceCall: patch.finalForceCall ?? null,
    finalForceCallReason: patch.finalForceCallReason ?? null,

    // ✅ 新憲法：本文採用(resolved)とseed(rewrite)を分けて追う
    resolvedTextLen: patch.resolvedTextLen ?? null,
    rewriteSeedLen: patch.rewriteSeedLen ?? null,

    // 参考：decision側（あれば）
    decisionResolvedLen:
      decision && decision.entry !== 'CALL_LLM' && decision.resolvedText
        ? String(decision.resolvedText).length
        : null,
    decisionRewriteSeedLen: decision?.rewriteSeed ? String(decision.rewriteSeed).length : null,
  });
}
