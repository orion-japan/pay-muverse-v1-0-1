// src/lib/iros/conversation/evidenceLog.ts
// iros — Conversation Evidence Logger (phase11)
// 目的：会話の「強さ」を4条件で可視化し、改善が効いたかをログで判定できるようにする。
// 4条件（0/1）
// - understand: 会話の流れ/直前要点を復元できている
// - repair: 取りこぼし/「さっき言った」等の修復に入れている
// - advance: Rで支えつつ、必要ならC/Iへ“提案として”橋を出している（押し付けない）
// - proof: 上記がログで判定可能（このloggerが出ている）
//
// 方針：
// - UIへ露出しない（ログのみ）
// - “推測で進めない”：判定は入力と構造情報（signals/ctx/branch/slots）に基づく
// - 例文/固定ワードに依存しない（「会議/朝」などはここでは扱わない）

export type ConvEvidence = {
  understand: 0 | 1;
  repair: 0 | 1;
  advance: 0 | 1;
  proof: 0 | 1;

  // 追跡用（ログのみ）
  reason?: string;
  detail?: Record<string, unknown>;
};

export type ConvEvidenceInput = {
  // これらは各ユニットから渡される想定（未導入なら null/undefined でOK）
  userText?: string | null;

  // signals（Unit A）
  signals?: {
    repair?: boolean;
    stuck?: boolean;
    detail?: boolean;
    topicHint?: string | null;
  } | null;

  // ctx（Unit B）
  ctx?: {
    lastUser?: string | null;
    lastAssistant?: string | null;
    shortSummary?: string | null;
    topic?: string | null;
  } | null;

  // branch（Unit C）
  branch?:
    | 'REPAIR'
    | 'DETAIL'
    | 'STABILIZE'
    | 'OPTIONS'
    | 'C_BRIDGE'
    | 'I_BRIDGE'
    | 'UNKNOWN'
    | null;

  // slots（Unit D）
  slots?: Array<{ key: string; content: string }> | null;

  // meta（任意）
  meta?: {
    qCode?: string | null;
    depthStage?: string | null;
    phase?: string | null;
  } | null;

  // ログ識別（任意）
  conversationId?: string | null;
  userCode?: string | null;
};

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function hasAnyText(s?: string | null): boolean {
  return !!norm(s);
}

function slotsText(slots?: Array<{ key: string; content: string }> | null): string {
  if (!slots?.length) return '';
  return slots.map((x) => norm(x.content)).filter(Boolean).join(' ');
}

// 「理解できている」最低条件：
// - ctx.shortSummary がある、または
// - lastUser/lastAssistant のどちらかがあり、かつ slots に“復元らしさ”がある
function judgeUnderstand(input: ConvEvidenceInput): { ok: boolean; why: string } {
  const short = norm(input.ctx?.shortSummary);
  if (short) return { ok: true, why: 'has_shortSummary' };

  const lu = norm(input.ctx?.lastUser);
  const la = norm(input.ctx?.lastAssistant);
  const st = slotsText(input.slots);

  if ((lu || la) && st) return { ok: true, why: 'has_last_and_slots' };

  // fallback: signalsがrepairで、かつユーザー文があるなら最低限は“流れ意識”扱い
  if (input.signals?.repair && hasAnyText(input.userText)) return { ok: true, why: 'repair_signal_with_userText' };

  return { ok: false, why: 'no_ctx_summary' };
}

// 「修復に入れている」条件：
// - signals.repair が true、または
// - branch が REPAIR
function judgeRepair(input: ConvEvidenceInput): { ok: boolean; why: string } {
  if (input.signals?.repair) return { ok: true, why: 'signals.repair' };
  if (input.branch === 'REPAIR') return { ok: true, why: 'branch=REPAIR' };
  return { ok: false, why: 'no_repair' };
}

// 「前進（提案の橋）」条件：
// - branch が C_BRIDGE / I_BRIDGE、または
// - slots 内に “提案/次の一手” の意図がある（固定語に依存しない軽い判定）
function judgeAdvance(input: ConvEvidenceInput): { ok: boolean; why: string } {
  if (input.branch === 'C_BRIDGE') return { ok: true, why: 'branch=C_BRIDGE' };
  if (input.branch === 'I_BRIDGE') return { ok: true, why: 'branch=I_BRIDGE' };

  // 文字列マッチは最小限（「やってみてください」等の口癖テンプレを強制しない）
  const st = slotsText(input.slots);
  if (!st) return { ok: false, why: 'no_slots' };

  // “提案”の雰囲気だけ拾う（過剰に決めつけない）
  const hints = ['案', '提案', '次', '一歩', '一手', 'まず', '整理', '選ぶ', '決める'];
  const hit = hints.some((h) => st.includes(h));
  if (hit) return { ok: true, why: 'slots_has_soft_advance_hint' };

  return { ok: false, why: 'no_advance_hint' };
}

export function computeConvEvidence(input: ConvEvidenceInput): ConvEvidence {
  const u = judgeUnderstand(input);
  const r = judgeRepair(input);
  const a = judgeAdvance(input);

  // proof はこの関数を呼べている＝1
  const ev: ConvEvidence = {
    understand: u.ok ? 1 : 0,
    repair: r.ok ? 1 : 0,
    advance: a.ok ? 1 : 0,
    proof: 1,
    reason: [u.ok ? `U:${u.why}` : `U!:${u.why}`, r.ok ? `R:${r.why}` : `R!:${r.why}`, a.ok ? `A:${a.why}` : `A!:${a.why}`].join(' | '),
    detail: {
      branch: input.branch ?? null,
      topicHint: input.signals?.topicHint ?? null,
      q: input.meta?.qCode ?? null,
      depth: input.meta?.depthStage ?? null,
      phase: input.meta?.phase ?? null,
      slotsLen: input.slots?.length ?? 0,
    },
  };
  return ev;
}

export function logConvEvidence(input: ConvEvidenceInput): ConvEvidence {
  const ev = computeConvEvidence(input);

  // 1行で判定できるログ（grepしやすい）
  // NOTE: 個人情報・本文は出さない。ヘッドだけ。
  const head = norm(input.userText).slice(0, 40);

  console.log('[IROS/CONV_EVIDENCE]', {
    conversationId: input.conversationId ?? null,
    userCode: input.userCode ?? null,
    understand: ev.understand,
    repair: ev.repair,
    advance: ev.advance,
    proof: ev.proof,
    reason: ev.reason ?? null,
    head: head || null,
    detail: ev.detail ?? null,
  });

  return ev;
}
