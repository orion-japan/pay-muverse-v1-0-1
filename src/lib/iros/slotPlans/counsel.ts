// src/lib/iros/slotPlans/counsel.ts
// iros — counsel slot plan (FINAL-only, task-driven, loop-resistant)
//
// ✅ 新憲法（writer分離）
// - counsel（構造側）：入口分類(A/B/C/D) + TASK + 禁則 + seedDraft（保険）を確定
// - LLM（writer）：自然文を作る（語彙・言い回し・温度・長さ）
// - ここは「判断や結論」ではなく「会話が噛む」ための配線だけを作る
//
// 入力分類（必須）
// A: 確認質問（Clarify）     → TASK: clarify_answer_first
// B: 否定・不満（Mismatch） → TASK: repair_mismatch
// C: ACK（相槌・受領）      → TASK: ack_return_turn
// D: 相談本体（Uncover）    → TASK: uncover_one_point
//
// 出力スロット（最低構成）
// - OBS: 観測（短く）※露出禁止（@OBS）
// - TASK: 今回のタスク（固定語彙）※露出禁止（@TASK）
// - CONSTRAINTS: 禁則（失敗条件の回避）※露出禁止（@CONSTRAINTS）
// - DRAFT: seedDraft（LLMが落ちた時の保険）※ユーザーに出しても成立する自然文（最大2行）
//
// 注意：このファイルは「話し方（slot配置）」のみ。
// stage更新 / IntentLock / topic抽出 / FinalAnchor/SideQuest判定は orchestrator 側で行う。

import type { SlotPlanPolicy } from '../server/llmGate';

export type ConsultStage = 'OPEN' | 'CLARIFY' | 'OPTIONS' | 'NEXT';

export type CounselTask =
  | 'clarify_answer_first'
  | 'repair_mismatch'
  | 'ack_return_turn'
  | 'uncover_one_point';

export type CounselSlot = {
  key: 'OBS' | 'TASK' | 'CONSTRAINTS' | 'DRAFT';
  role: 'assistant';
  style: 'neutral' | 'soft' | 'firm';
  content: string;
};

export type CounselSlotPlan = {
  kind: 'counsel';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy; // 'FINAL'
  stage: ConsultStage;
  intentLocked: boolean;
  task: CounselTask;
  slots: CounselSlot[];
};

// ---- helpers ----

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function clamp(s: string, n: number) {
  const t = norm(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}

function twoLines(lines: string[]) {
  const picked = lines.map((x) => norm(x)).filter(Boolean).slice(0, 2);
  return picked.join('\n');
}

function isShortOrThin(t: string) {
  const s = norm(t);
  if (!s) return true;
  if (s.length <= 8) return true;
  return /^(うん|はい|そう|なるほど|わかった|OK|了解|たしかに|えー|まじ|助かる|ありがとう)+[。！？!?…]*$/.test(
    s,
  );
}

function looksLikeMismatch(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /(ズレ|違う|会話になってない|分かりにくい|意味わから|おかしい|テンプレ|むかつく|イラつく|直らない|ダメ)/.test(
    s,
  );
}

// ✅ D: 相談入口（「相談ですが」等）
// - ここを明示検知して、ACK/Clarifyに吸われないようにする
function looksLikeConsultOpen(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /(相談(ですが|です|したい|したくて|があります|にのって|乗って|聞いて|お願い)|ちょっと相談|相談なんだけど|相談です)/.test(
    s,
  );
}

// ✅ A: 「意味/根拠/指してるもの」の確認質問（clarify）
// - 相談質問（どこ行こう/どうしよう/迷う）は D に寄せるため拾いすぎない
function looksLikeClarifyQuestion(t: string) {
  const s = norm(t);
  if (!s) return false;

  // 相談質問（D寄せ）：疑問符があってもここでは false にして D に回す
  if (/(どこに行こう|どこ行こ|どうしよう|迷う|決められない|選べない|どうする)/.test(s)) return false;

  const hasQ = /[？?]/.test(s);
  const clarifyLexeme =
    /(どういう意味|何の意味|つまり|要するに|って何|とは|意味|根拠|どの部分|何がズレ|何を指して|どっち|どれのこと)/.test(
      s,
    );

  const whButClarify =
    /^(何が|なにが|何を|なにを|どこが|どれが|いつ|なぜ|なんで|何で|それって|それは)/.test(s) &&
    /(意味|指して|根拠|ズレ|言い方|前提|意図)/.test(s);

  return (hasQ && clarifyLexeme) || clarifyLexeme || whButClarify;
}

// ✅ C: ACK（相槌・受領）
// - 相談入口はACKにしない（短文でもDへ）
function looksLikeAck(t: string) {
  const s = norm(t);
  if (!s) return false;

  if (looksLikeConsultOpen(s)) return false;
  if (isShortOrThin(s)) return true;

  return /(わかりやすい|なるほど|OK|了解|助かる|ありがとう|それでいい|いける)/.test(s);
}

function pickTask(userText: string): { task: CounselTask; kind: 'A' | 'B' | 'C' | 'D'; reason: string } {
  const t = norm(userText);

  // 優先：B（不満/否定）→ D（相談入口）→ A（確認）→ C（ACK）→ D（相談本体）
  if (looksLikeMismatch(t)) return { task: 'repair_mismatch', kind: 'B', reason: 'input:B(mismatch)' };
  if (looksLikeConsultOpen(t)) return { task: 'uncover_one_point', kind: 'D', reason: 'input:D(consult_open)' };
  if (looksLikeClarifyQuestion(t)) return { task: 'clarify_answer_first', kind: 'A', reason: 'input:A(clarify)' };
  if (looksLikeAck(t)) return { task: 'ack_return_turn', kind: 'C', reason: 'input:C(ack)' };

  return { task: 'uncover_one_point', kind: 'D', reason: 'input:D(uncover)' };
}

// ---- meta packers（露出禁止） ----
// seedFromSlots 等で露出しても「ただの記号列」に見える形に固定する（自然文にしない）。
function m(tag: string, payload: Record<string, unknown>) {
  let body = '';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ _err: 'stringify_failed' });
  }
  return `@${tag} ${body}`;
}

// ---- slot builders ----

function buildObsMeta(args: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
  task: CounselTask;
}): string {
  const t = norm(args.userText);
  return m('OBS', {
    userText: clamp(t, 220),
    task: args.task,
    intentLocked: args.intentLocked,
    intentAnchorKey: args.intentAnchorKey ?? null,
    topic: args.topic ?? null,
    lastSummary: args.lastSummary ?? null,
  });
}

function buildConstraintsMeta(task: CounselTask): string {
  const common = {
    avoid: [
      'generalities',
      'cheer_only',
      'template_loop',
      'over_questioning',
      'meta_explaining',
      'teacher_tone',
      'menu_like',
    ],
    // 全タスク共通：質問は最大1（ACKは0推奨）
    maxQuestions: 1,
    maxLines: 2,
  };

  switch (task) {
    case 'clarify_answer_first':
      return m('CONSTRAINTS', {
        ...common,
        must: ['answer_first_line', 'use_object_noun', 'optional_one_question_at_end'],
        maxQuestions: 1,
      });

    case 'repair_mismatch':
      return m('CONSTRAINTS', {
        ...common,
        must: ['name_mismatch_one_point', 'use_noun_for_target', 'no_generic_escape'],
        mismatchTargets: ['wording', 'premise', 'distance', 'purpose'],
        maxQuestions: 1,
      });

    case 'ack_return_turn':
      return m('CONSTRAINTS', {
        ...common,
        must: ['short_return', 'return_turn_to_user'],
        maxQuestions: 0,
        lengthGuide: '40-120jp_chars',
      });

    case 'uncover_one_point':
    default:
      return m('CONSTRAINTS', {
        ...common,
        must: ['place_one_point_only', 'no_advice', 'no_do_this'],
        maxQuestions: 1,
      });
  }
}

function buildTaskMeta(task: CounselTask): string {
  return m('TASK', { task });
}

// ---- seedDraft（保険：ユーザーに出しても成立する自然文 / 最大2行） ----

function buildSeedDraft(task: CounselTask, userText: string, lastSummary?: string | null): string {
  const t = norm(userText);
  const last = norm(lastSummary);

  // DRAFTは「思想説明」や「講義」にならない。短く、最大2行。
  // writerが落ちたときでも会話が噛む「保険」だけを置く。
  switch (task) {
    case 'clarify_answer_first': {
      const x = clamp(t || 'それ', 56);
      const ref =
        last && t && last !== t ? `いま確認したいのは、前の「${clamp(last, 40)}」のどこを指してるか。` : null;

      return twoLines([
        ref ?? `いまの「${x}」は、指してる対象を揃えたい確認だね。`,
        'どの文（どの部分）を指してる？',
      ]);
    }

    case 'repair_mismatch': {
      return twoLines([
        'ズレは受け取った。いま直す一点を決めたい。',
        'ズレは「言葉」「前提」「距離感」「目的」のどれが一番大きい？',
      ]);
    }

    case 'ack_return_turn': {
      // ACKは質問ゼロでも成立させる（QCOUNT事故を避ける）
      return twoLines(['了解。相談でいこう。', 'いま一番ひっかかってるところを、そのまま置いて。']);
    }

    case 'uncover_one_point':
    default: {
      // 相談入口（短文）でも“復唱だけ”で終わらないように、開く一文を置く
      if (looksLikeConsultOpen(t) && t.length <= 12) {
        return twoLines(['了解。続けて。', 'いま一番ひっかかってるところから。']);
      }

      const one = t ? clamp(t, 80) : 'まだ言葉になっていないもの';
      return twoLines([`いま扱う一点は「${one}」。`, 'ここだけ残す。']);
    }
  }
}

function buildSlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
  task: CounselTask;
}): CounselSlot[] {
  const obs = buildObsMeta({
    userText: input.userText,
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
    topic: input.topic,
    lastSummary: input.lastSummary,
    task: input.task,
  });

  const taskMeta = buildTaskMeta(input.task);
  const constraints = buildConstraintsMeta(input.task);
  const draft = buildSeedDraft(input.task, input.userText, input.lastSummary ?? null);

  const out: CounselSlot[] = [
    { key: 'OBS', role: 'assistant', style: 'soft', content: obs },
    { key: 'TASK', role: 'assistant', style: 'firm', content: taskMeta },
    { key: 'CONSTRAINTS', role: 'assistant', style: 'neutral', content: constraints },
    { key: 'DRAFT', role: 'assistant', style: 'neutral', content: draft },
  ];

  return out.filter((s): s is CounselSlot => !!norm(s.content));
}

// ---- main ----

export function buildCounselSlotPlan(args: {
  userText: string;
  stage: ConsultStage;

  // Intent Lock（orchestrator で判定して渡す）
  intentLocked?: boolean;
  intentAnchorKey?: string | null;

  // 話題（orchestrator で推定して渡す。ここではOBSに溶かすだけ）
  topic?: string | null;

  // orchestrator から渡す（無ければ null）
  lastSummary?: string | null;
}): CounselSlotPlan {
  const stamp = 'counsel.ts@2026-02-06#constitution-v2';

  const userText = norm(args.userText);

  const lastSummary =
    typeof args.lastSummary === 'string' && args.lastSummary.trim().length > 0 ? args.lastSummary.trim() : null;

  const intentLocked = args.intentLocked === true;

  const intentAnchorKey =
    typeof args.intentAnchorKey === 'string' && args.intentAnchorKey.trim().length > 0
      ? args.intentAnchorKey.trim()
      : null;

  const topic = typeof args.topic === 'string' && args.topic.trim().length > 0 ? args.topic.trim() : null;

  const picked = pickTask(userText);

  const slots = buildSlots({
    userText,
    intentLocked,
    intentAnchorKey,
    topic,
    lastSummary,
    task: picked.task,
  });

  const reason = `${picked.reason} / stage:${args.stage}`;

  return {
    kind: 'counsel',
    stamp,
    reason,
    slotPlanPolicy: 'FINAL',
    stage: args.stage,
    intentLocked,
    task: picked.task,
    slots,
  };
}
