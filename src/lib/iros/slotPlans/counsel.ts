// src/lib/iros/slotPlans/counsel.ts
// iros — counsel slot plan (FINAL-only, task-driven, loop-resistant)
//
// ✅ 指示書準拠（slotPlan → LLM writer 仕様）
// - counsel（構造側）：入口分類(A/B/C/D) + TASK + 禁則 + seedDraft（保険）を確定
// - LLM（writer）：意味に合う自然文を作る（語彙・言い回し・温度・短さ/長さ）
// - 成果物は「答え」ではなく、会話が噛むこと
//
// 入力分類（必須）
// A: 質問（Clarify）          → TASK: clarify_answer_first
// B: 否定・不満（Mismatch/No）→ TASK: repair_mismatch
// C: ACK（相槌・受領）         → TASK: ack_return_turn
// D: 相談本体（Uncover）       → TASK: uncover_one_point
//
// 出力スロット（最低構成）
// - OBS: 観測（短く）※露出禁止（@OBS）
// - TASK: 今回のタスク（固定語彙）※露出禁止（@TASK）
// - CONSTRAINTS: 禁則（失敗条件の回避）※露出禁止（@CONSTRAINTS）
// - DRAFT: seedDraft（LLMが落ちた時の保険）※ユーザーに出しても成立する自然文
//
// 重要：seedFromSlots 等で slots がユーザーに露出する経路があるため、
// OBS/TASK/CONSTRAINTS は必ずメタ包装（@TAG）して「見えても事故らない」形に固定する。
// DRAFT だけは自然文として成立させる（ここが最後の保険）。
//
// 注意：このファイルは「話し方（slot配置）」のみ。
// stage更新 / IntentLock 判定 / topic抽出は orchestrator で行う。

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
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function clamp(s: string, n: number) {
  const t = norm(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}

function isShortOrThin(t: string) {
  const s = norm(t);
  if (!s) return true;
  if (s.length <= 8) return true;
  return /^(うん|はい|そう|なるほど|わかった|OK|了解|たしかに|えー|まじ|助かる|ありがとう)+[。！？!?…]*$/.test(
    s
  );
}

function looksLikeMismatch(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /(ズレ|違う|会話になってない|分かりにくい|意味わから|おかしい|テンプレ|むかつく|イラつく|直らない|ダメ)/.test(
    s
  );
}

// ✅ D: 相談入口（「相談ですが」等）
// - ここを明示検知して、ACK/Clarifyに吸われないようにする
function looksLikeConsultOpen(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /(相談(ですが|です|したい|したくて|があります|にのって|乗って|聞いて|お願い)|ちょっと相談|相談なんだけど|相談です)/.test(
    s
  );
}

// ✅ A: 「意味/根拠/指してるもの」の確認質問（clarify）
// - 相談質問（どこ行こう/どうしよう/迷う）は D に寄せるため、ここでは拾いすぎない
function looksLikeClarifyQuestion(t: string) {
  const s = norm(t);
  if (!s) return false;

  // 相談質問（D寄せ）：疑問符があってもここでは false にして D に回す
  // 例: 今日はどこに行こうかな？/どうしよう/迷う/決められない
  if (/(どこに行こう|どこ行こ|どうしよう|迷う|決められない|選べない|どうする)/.test(s)) return false;

  // 明示の? は強いが、内容が「意味/根拠/指示対象」寄りのときのみ A 扱いにする
  const hasQ = /[？?]/.test(s);
  const clarifyLexeme =
    /(どういう意味|何の意味|つまり|要するに|って何|とは|意味|根拠|どの部分|何がズレ|何を指して|どっち|どれのこと)/.test(
      s
    );

  // 疑問語があっても、相談質問の典型でなければ A にしてよい
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

  // ❶ 相談入口は ACK にしない
  if (looksLikeConsultOpen(s)) return false;

  if (isShortOrThin(s)) return true;

  return /(わかりやすい|なるほど|OK|了解|助かる|ありがとう|それでいい|いける)/.test(s);
}

function pickTask(userText: string): { task: CounselTask; kind: 'A' | 'B' | 'C' | 'D'; reason: string } {
  const t = norm(userText);

  // 優先：B（不満/否定）→ D（相談入口）→ A（確認/意味質問）→ C（ACK）→ D（相談本体）
  if (looksLikeMismatch(t)) return { task: 'repair_mismatch', kind: 'B', reason: 'input:B(mismatch)' };

  // ❷ 相談入口は最優先で D
  if (looksLikeConsultOpen(t)) return { task: 'uncover_one_point', kind: 'D', reason: 'input:D(consult_open)' };

  if (looksLikeClarifyQuestion(t))
    return { task: 'clarify_answer_first', kind: 'A', reason: 'input:A(clarify)' };

  if (looksLikeAck(t)) return { task: 'ack_return_turn', kind: 'C', reason: 'input:C(ack)' };

  return { task: 'uncover_one_point', kind: 'D', reason: 'input:D(uncover)' };
}

// ---- meta packers（露出禁止） ----
// seedFromSlots などで露出しても「ただの記号列」として扱えるようにする。
// ※ render側で @TAG を剥がす/無視する設計なら、そのまま非表示化できる。

function m(tag: string, payload: Record<string, unknown>) {
  // 露出時に読みやすさを上げない（=ユーザー向け文章に見えない）ため、整形しすぎない
  // ただしJSONとして壊れないことは保証する
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

  // OBSは「素材の指定」だけに寄せる（自然文にしない）
  // 行数を増やさず、必要情報はメタとして渡す
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
  // 禁則は「行動禁止」で渡す（指示書準拠）
  // 露出しても事故らないよう、自然文にしない
  const common = {
    avoid: [
      'generalities',
      'cheer_only',
      'template_loop',
      'over_questioning',
      'meta_explaining',
      'teacher_tone',
    ],
    maxQuestions: 1,
  };

  switch (task) {
    case 'clarify_answer_first':
      return m('CONSTRAINTS', {
        ...common,
        must: ['answer_first_1to2_lines', 'put_object_noun', 'then_optional_confirm'],
        maxQuestions: 1,
      });

    case 'repair_mismatch':
      return m('CONSTRAINTS', {
        ...common,
        must: ['name_the_mismatch_target_one', 'use_noun_for_target', 'no_generic_escape'],
        mismatchTargets: ['wording', 'premise', 'distance', 'purpose'],
        maxQuestions: 1,
      });

    case 'ack_return_turn':
      return m('CONSTRAINTS', {
        ...common,
        must: ['short_return', 'return_turn_to_user'],
        // ACKは質問ゼロでも良い。QCOUNT事故を避けたいので 0 を推奨
        maxQuestions: 0,
        lengthGuide: '60-120jp_chars',
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
  // task名は内部語彙なので、露出禁止包装に入れる
  return m('TASK', { task });
}

// ---- seedDraft（保険：ユーザーに出しても成立する自然文） ----

function buildSeedDraft(task: CounselTask, userText: string, lastSummary?: string | null): string {
  const t = norm(userText);
  const last = norm(lastSummary);

  // seedは「思想説明」にならないように、意味の一致だけを出す。
  // 質問数を増やさない（ACKは0、他は最大1）。
  switch (task) {
    case 'clarify_answer_first': {
      const x = clamp(t || 'それ', 56);
      const ref = last && t && last !== t ? `今聞いてるのは、前の「${clamp(last, 40)}」の言い方だね。` : '';

      return [
        ref || `今の質問は「${x}」の確認だね。`,
        'ここで言っていたのは、内容の正しさじゃなくて「どの言い方を指していたか」を揃えること。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'repair_mismatch': {
      return [
        'ズレてたのは認める。いま直したいのは「どこがズレたか」を一点に揃えること。',
        'ズレは「言葉」か「前提」か「距離感」か「目的」、どれが一番大きい？',
      ].join('\n');
    }

    case 'ack_return_turn': {
      return [
        '了解。相談でいこう。',
        'どこからでもいい。いま一番ひっかかってるところを、そのまま話して。'
      ].join('\n');
    }

    case 'uncover_one_point':
    default: {
      // 相談入口（「相談ですが」等）は“判断・説明・条件提示”を一切しない
      // ✅ ただし返答が短すぎると、LLM がそのまま復唱して終わるので
      // ✅ 「話して」を入れた“開く一文”にする
      if (looksLikeConsultOpen(t) && t.length <= 12) {
        return [
          '了解。続けて。',
          'どこからでもいい。いま一番ひっかかってるところを、そのまま話して。'
        ].join('\n');
      }

      const one = t ? clamp(t, 80) : 'まだ言葉になっていないもの';
      return [`いま扱う一点は「${one}」。`, 'ここだけ残す。'].join('\n');
    }



// ここでは「不足」「状態」「テーマ」などを言語化しない
// LLMには「自然な一言を返す」以外の判断材料を渡さない
const one = t ? clamp(t, 80) : null;
return one
  ? `いま、話していいのはこの一言だけ。\n${one}`
  : 'そのまま、言葉を続けて。';

    }}
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

  // 型を落とさずに空を除去
  return out.filter((s): s is CounselSlot => !!norm(s.content));
}

// ---- main ----

export function buildCounselSlotPlan(args: {
  userText: string;
  stage: ConsultStage;

  // Intent Lock（orchestrator で判定して渡す）※任意
  intentLocked?: boolean;
  intentAnchorKey?: string | null;

  // 話題（orchestrator で推定して渡す。ここではOBSに溶かすだけ）※任意
  topic?: string | null;

  // orchestrator から渡す（無ければ null）※任意
  lastSummary?: string | null;
}): CounselSlotPlan {
  const stamp = 'counsel.ts@2026-01-18#task-v3';

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

  // stageは引数をそのまま保持（互換）。主導はtask。
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
