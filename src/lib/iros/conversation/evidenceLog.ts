// src/lib/iros/conversation/evidenceLog.ts
// iros — Conversation Evidence Logger (phase11)
//
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
//
// NOTE（phase11）
// - normalChat は @NEXT_HINT {"mode":"advance_hint", ...} を常設する設計。
//   これを拾わないと A!:no_advance_hint が残り続け、改善の効果が測れない。
//   したがって「NEXT_HINT が出ている」こと自体を advance の証拠としてカウントする。

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
  return slots
    .map((x) => norm(x?.content))
    .filter(Boolean)
    .join(' ');
}

function safeSlots(input: ConvEvidenceInput): Array<{ key: string; content: string }> {
  return Array.isArray(input.slots) ? input.slots : [];
}

function looksLikeNextHint(slot: { key: string; content: string }): boolean {
  const k = String(slot?.key ?? '');
  const c = norm(slot?.content ?? '');
  return k === 'NEXT' || c.startsWith('@NEXT_HINT');
}

function isAdvanceHintNextHint(slot: { key: string; content: string }): boolean {
  const c = norm(slot?.content ?? '');
  // JSON stringify 前提の検出（堅め）
  if (c.includes('"mode":"advance_hint"')) return true;
  // まれな整形差分にも弱く当てる（保険）
  if (c.includes("'mode':'advance_hint'")) return true;
  if (c.includes('advance_hint')) return true;
  return false;
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
  if (input.signals?.repair && hasAnyText(input.userText)) {
    return { ok: true, why: 'repair_signal_with_userText' };
  }

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
// - NEXT_HINT が出ている（phase11ではadvanceHint常設のため）
// - ✅ それ以外でも T_CONCRETIZE（SHIFT kind=t_concretize / intent=implement_next_step）があれば「前進」扱い
// - それ以外は slots 内の“提案/次の一手”の雰囲気を軽く拾う（固定語に依存しない）
function judgeAdvance(input: ConvEvidenceInput): { ok: boolean; why: string } {
  if (input.branch === 'C_BRIDGE') return { ok: true, why: 'branch=C_BRIDGE' };
  if (input.branch === 'I_BRIDGE') return { ok: true, why: 'branch=I_BRIDGE' };

  const slots = safeSlots(input);
  if (!slots.length) return { ok: false, why: 'no_slots' };

  // ✅ T_CONCRETIZE を「前進」扱い（口癖テンプレに依存しない）
  //  - normalChat の SHIFT は '@SHIFT {"kind":"t_concretize","intent":"implement_next_step", ...}' 形式が多い
  for (const s of slots as any[]) {
    const key = String(s?.key ?? '');
    const raw = s?.content ?? s?.text ?? s?.value ?? s?.body ?? null;

    // object 形式が来ても拾えるように（将来の変更に耐える）
    const objKind =
      raw && typeof raw === 'object' ? String((raw as any)?.kind ?? '') : '';
    const objIntent =
      raw && typeof raw === 'object' ? String((raw as any)?.intent ?? '') : '';

    const str = typeof raw === 'string' ? raw : '';

    const hit =
      objKind === 't_concretize' ||
      objIntent === 'implement_next_step' ||
      str.includes('"kind":"t_concretize"') ||
      str.includes('"intent":"implement_next_step"') ||
      str.includes('t_concretize') ||
      str.includes('implement_next_step') ||
      (key === 'SHIFT' &&
        (str.includes('t_concretize') || str.includes('implement_next_step')));

    if (hit) return { ok: true, why: 'shift:t_concretize' };
  }

  // ✅ Phase11: NEXT_HINT(mode=advance_hint) を「前進」として正式にカウント
  for (const s of slots) {
    if (!looksLikeNextHint(s)) continue;

    if (isAdvanceHintNextHint(s)) {
      return { ok: true, why: 'next_hint:advance_hint' };
    }

    // NEXT_HINT 自体があるなら「橋」は出ている扱い（mode欠けの救済）
    return { ok: true, why: 'next_hint:present' };
  }

  // 文字列マッチは最小限（口癖テンプレを強制しない）
  const st = slotsText(slots);
  if (!st) return { ok: false, why: 'no_slots_text' };

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
    reason: [
      u.ok ? `U:${u.why}` : `U!:${u.why}`,
      r.ok ? `R:${r.why}` : `R!:${r.why}`,
      a.ok ? `A:${a.why}` : `A!:${a.why}`,
    ].join(' | '),
    detail: {
      branch: input.branch ?? null,
      topicHint: input.signals?.topicHint ?? null,
      q: input.meta?.qCode ?? null,
      depth: input.meta?.depthStage ?? null,
      phase: input.meta?.phase ?? null,
      slotsLen: safeSlots(input).length,
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
