// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, conversation-first)
//
// 方針（2026-01-11 改）
// - normalChat は「普通に会話する」最低ラインを保証する
// - 箱テンプレは禁止（事実/感情/望み 等の固定枠を出さない）
// - 口癖テンプレは禁止（核/切る/受け取った/呼吸 等）
// - 二択誘導は禁止（A/B で選ばせない）
// - 質問は最大1つ（会話が進むための“必要最小”だけ / 0問もOK）
// - 質問で掘り続けない：必要なら「短い解説（見方の変更）」で自然に次が湧く状態を作る
// - I-line（方向の問い）は “他の質問を止めて” 1本で出す（= 質問連打を止める）
//
// ✅ Phase11重要：slotPlan から “文章” を追放する
// - content は user-facing 文ではなく「writer入力用のメタ」を入れる
// - writer が毎回生成（CALL_LLM）して初めて「会話」が成立する
// - ここは “意味の骨格/合図/素材” だけを返す（自然言語は書かない）

import type { SlotPlanPolicy } from '../server/llmGate';
import { detectExpansionMoment } from '../language/expansionMoment';

// ✅ phase11 conversation modules
import { buildContextPack } from '../conversation/contextPack';
import { computeConvSignals } from '../conversation/signals';
import { decideConversationBranch } from '../conversation/branchPolicy';

export type NormalChatSlot = {
  key: string; // ✅ key は “カテゴリ” （識別子ではない）
  slotId?: string; // ✅ 重複 key 許容のための安定識別子（framePlan/writer/log の追跡用）
  role: 'assistant';
  style: 'neutral' | 'soft' | 'firm';
  content: string; // ✅ writer入力用メタ（ユーザー表示文ではない）
};

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy; // 'FINAL'
  slots: NormalChatSlot[];
};

// ---- helpers ----

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function containsAny(t: string, words: string[]) {
  return words.some((w) => t.includes(w));
}

// ✅ meta builder（文章禁止：短いタグ＋最小payloadだけ）
function m(tag: string, payload?: Record<string, unknown>) {
  if (!payload || Object.keys(payload).length === 0) return `@${tag}`;

  // payload は writer が読む前提。可読性より “壊れにくさ” 優先で JSON に寄せる。
  // 例外が出るような値（BigInt / Circular 等）が混じっても落とさない保険。
  try {
    return `@${tag} ${JSON.stringify(payload)}`;
  } catch {
    return `@${tag} ${JSON.stringify({ _fallback: String(payload) })}`;
  }
}

/**
 * ✅ slots を「配列」に統一し、重複 key を許容したまま追跡できるよう slotId を付与する。
 * - key は “カテゴリ” として扱い、識別は slotId で行う。
 * - 既に slotId / slot_id があれば尊重する。
 * - upstream が object を作ってしまった場合でも array に正規化（ただし重複はこの時点で失われ得る）。
 *
 * 🔧 使い方：
 *   const slotsNormalized = normalizeSlotsForFramePlan(slots, { idPrefix: 'N' });
 *   // framePlan に渡す直前（= return 直前）に必ず噛ませる
 */
export function normalizeSlotsForFramePlan(
  slots: NormalChatSlot[] | Record<string, unknown> | null | undefined,
  opts?: { idPrefix?: string }
): NormalChatSlot[] {
  const idPrefix = String(opts?.idPrefix ?? 'N');
  const out: NormalChatSlot[] = [];
  if (!slots) return out;

  const arr: any[] = Array.isArray(slots)
    ? slots
    : Object.keys(slots).map((k) => ({
        key: k,
        content: (slots as any)[k],
        role: 'assistant',
        style: 'neutral',
      }));

  let seq = 0;

  for (const s of arr) {
    if (!s) continue;

    const key = String(s.key ?? '').trim();
    const role = (s.role ?? 'assistant') as 'assistant';
    const style = (s.style ?? 'neutral') as 'neutral' | 'soft' | 'firm';
    const content = String(s.content ?? s.text ?? s.value ?? '').trim();

    if (!key || !content) continue;

    const existingId = String(s.slotId ?? s.slot_id ?? '').trim();
    const slotId = existingId || `${idPrefix}${++seq}`;

    out.push({ key, slotId, role, style, content });
  }

  return out;
}

// ✅ 「評価/指摘/フィードバック」検出：ここは“質問で返すと逃げ”になりやすいので q=0 を強制する
function looksLikeFeedback(text: string) {
  const t = norm(text);
  if (!t) return false;

  return containsAny(t, [
    '説得力',
    '弱い',
    '薄い',
    '足りない',
    '足りてない',
    '違う',
    '違います',
    '違うでしょ',
    'それじゃ',
    'そのままじゃ',
    '生意気',
    '失礼',
    'なんで',
    'おかしい',
  ]);
}

function looksLikeInnerConcern(text: string) {
  const t = norm(text);
  if (!t) return false;

  return containsAny(t, [
    '迷',
    '不安',
    '怖',
    '心配',
    '重',
    '責任',
    '可能性',
    '方向',
    '意味',
    '在り方',
    'この先',
    'どうなる',
    'どうして',
    'なぜ',
    '自分',
    '考え',
    '感じ',
    'しんど',
    'つら',
    'きつ',
    '苦',
    'モヤ',
    'もや',
    '違和感',
  ]);
}

function looksLikeThinReply(text: string) {
  const t = norm(text);
  if (!t) return false;

  if (
    t === '日常です' ||
    t === '日常' ||
    t === 'まだです' ||
    t === 'まだ' ||
    t === '分からない' ||
    t === 'わからない' ||
    t === '可能性の話です' ||
    t === '可能性' ||
    t === 'そうかも' ||
    t === 'そうですね'
  ) {
    return true;
  }

  if (
    /^(どうしよ|どうしよう|どうする|どうしたら|どうすれば)(.*)?$/.test(t) ||
    /^(うーん|うーむ|んー|ん〜|う〜ん|えーと|えっと)$/.test(t) ||
    /^(迷う|迷ってる|悩む|悩んでる|決められない|決まらない)(.*)?$/.test(t)
  ) {
    return true;
  }

  const stripped = t.replace(/[〜~ー…\.\,\!\?！？、。]/g, '').trim();
  if (stripped.length <= 6) return true;

  if (t.length <= 12) return true;

  return false;
}

// ---- triggers ----

function looksLikeEndConversation(text: string) {
  const t = norm(text);
  if (!t) return false;
  return (
    /^(終わり|終了|おわり|やめる|やめます|ストップ|中断|解散)$/.test(t) ||
    t.includes('今日はここまで') ||
    t === 'ここまで' ||
    t === '以上'
  );
}

/**
 * ✅ Recall check（記憶確認）検出
 */
function looksLikeRecallCheck(text: string) {
  const t = norm(text);
  if (!t) return false;

  const hasRemember =
    t.includes('覚えて') ||
    t.includes('記憶') ||
    t.includes('前の話') ||
    t.includes('前回') ||
    t.includes('この前') ||
    t.includes('さっきの話') ||
    t.includes('以前の話') ||
    t.includes('前に言った') ||
    t.includes('前に話した');

  if (!hasRemember) return false;

  const protest = containsAny(t, [
    '言ったよね',
    '言ったでしょ',
    'もう言った',
    'さっき言った',
    '同じこと',
    '繰り返し',
    'ループ',
    'また？',
    'またそれ',
    '変わってない',
  ]);
  if (protest) return false;

  if (/[?？]$/.test(t) || /(ですか|ますか|かな)$/.test(t)) return true;
  return true;
}

function looksLikeRepair(text: string) {
  const t = norm(text);
  if (!t) return false;

  const repairWords = [
    'ゆったよね',
    '言ったよね',
    '言ったでしょ',
    'さっき言った',
    'もう言った',
    '今言った',
    'それ言った',
    '前も言った',
    '前にも言った',
    'さっきも言った',

    'さっき話した',
    'さっき話しました',
    'もう話した',
    '今話した',
    'それ話した',
    '話しましたよ',
    '話したよ',
    'さっき言いました',
    'もう言いました',
    '今言いました',

    '同じこと',
    '同じ話',
    '繰り返し',
    '繰り返してる',
    'ループ',
    'また？',
    'またか',
    'またそれ',
    '話が変わってない',
    '変わってない',
    '変わらない',
  ];

  if (containsAny(t, repairWords)) return true;
  if (/(さっき|もう|今|前も?)\s*(言|い|話)/.test(t)) return true;
  if (/^また[?？]?$/.test(t)) return true;

  return false;
}

function looksLikeHowTo(text: string) {
  const t = norm(text);
  if (!t) return false;

  if (
    t === 'どうしたらいい？' ||
    t === 'どうしたらいい' ||
    t === 'どうすればいい？' ||
    t === 'どうすればいい' ||
    t === '何したらいい？' ||
    t === '何したらいい' ||
    t.includes('どうしたら') ||
    t.includes('どうすれば') ||
    t.includes('何したら')
  ) {
    return true;
  }

  const nextStepLike =
    t.includes('次のステップ') ||
    t.includes('この先') ||
    t.includes('進め方') ||
    t.includes('進める方法') ||
    t.includes('やり方') ||
    t.includes('手順') ||
    t.includes('方法');

  const asksMethods =
    t.includes('どんな方法') ||
    t.includes('どういう方法') ||
    t.includes('どんなやり方') ||
    t.includes('どういうやり方') ||
    t.includes('どう進め') ||
    t.includes('何から') ||
    t.includes('手段') ||
    t.includes('方法がありますか') ||
    t.includes('方法ある') ||
    t.includes('やり方ある');

  if (nextStepLike && asksMethods) return true;
  if (asksMethods) return true;
  if (/(次(のステップ)|この先).*(方法|やり方|進め方|手順)/.test(t)) return true;

  return false;
}

function looksLikeILineMoment(text: string, ctx?: { lastSummary?: string | null }) {
  const t = norm(text);
  const last = norm(ctx?.lastSummary);

  const keys = [
    '本当は',
    '望み',
    'どんな状態',
    'どう在りたい',
    'なりたい',
    '好きな状態',
    'これから',
    '完成したら',
    '完成後',
    'そのあと',
    '未来',
    '責任',
    '主権',
    '任せたら',
    '任せる',
    '怖い',
    '不安',
    '安心',
  ];

  if (containsAny(t, keys)) return true;

  if (looksLikeHowTo(t) && containsAny(last, ['完成', 'そのあと', '未来', '方向', '責任', '主権', '安心', '不安'])) {
    return true;
  }

  return false;
}

/**
 * ✅ COMPOSE（文章生成）検出
 */
function looksLikeComposeTask(text: string) {
  const t = norm(text);
  if (!t) return false;

  if (
    containsAny(t, [
      '送る文章',
      '送る文',
      '返信文',
      '返事',
      'メール文',
      'メールの文',
      'DM',
      'メッセージ文',
      '文章を作って',
      '文を作って',
      '文章作って',
      '文面',
      '文案',
      '例文',
    ])
  ) {
    return true;
  }

  const hasSend = /(に|へ)\s*送(る|りたい|るため)/.test(t) || t.includes('送信');
  const hasMake = /(作って|書いて|作成して|まとめて|整えて)/.test(t);
  if (hasSend && hasMake) return true;

  return false;
}

// ---- slot builders（文章禁止：@TAG JSON のみ） ----

function buildEndSlots(): NormalChatSlot[] {
  // ✅ END を「薄くしない」ための 3ブロック：
  // END（終了合図）→ RESTORE(mini)（再開の足場）→ NEXT（いつでも再開）
  return [
    { key: 'END', role: 'assistant', style: 'soft', content: m('END') },
    {
      key: 'RESTORE',
      role: 'assistant',
      style: 'neutral',
      content: m('RESTORE', {
        mode: 'mini_resume_scaffold',
        // ✅ 断言しない・文章は writer に任せる（“再開の入り口”だけ渡す）
        hint: {
          kind: 'resume_index',
          candidates: ['最後の要点', '詰まってた点', '次にやる一手', '確認したいログ/証拠'],
          avoid: ['general_advice', 'cheer_up'],
          questions_max: 0,
        },
      }),
    },
    { key: 'NEXT', role: 'assistant', style: 'neutral', content: m('NEXT_HINT', { mode: 'resume_anytime' }) },
  ];
}

function buildEmptySlots(): NormalChatSlot[] {
  return [{ key: 'EMPTY', role: 'assistant', style: 'soft', content: m('EMPTY', { ask: 'user_one_liner' }) }];
}

function buildRecallCheckSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  const last = norm(ctx?.lastSummary);

  return [
    {
      key: 'ACK',
      role: 'assistant',
      style: 'soft',
      content: m('ACK', { kind: 'recall_check', user: clamp(t, 160) }),
    },
    {
      key: 'RESTORE',
      role: 'assistant',
      style: 'neutral',
      content: m('RESTORE', {
        last: last ? clamp(last, 180) : null,
        mode: 'candidate_hint',
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'indexing_then_continue',
        avoid: ['general_advice', 'career_tips', 'communication_tips'],
      }),
    },
    {
      key: 'Q',
      role: 'assistant',
      style: 'neutral',
      content: m('Q', {
        kind: 'pointing_one_liner',
        ask: 'どの場面を指してる？（辞めたい理由／次の職場像／人間関係／条件など）',
        questions_max: 1,
      }),
    },
  ];
}

function buildComposeSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  const last = norm(ctx?.lastSummary);

  return [
    {
      key: 'TASK',
      role: 'assistant',
      style: 'neutral',
      content: m('TASK', {
        kind: 'compose_message',
        user: clamp(t, 260),
        last: last ? clamp(last, 180) : null,
        output: 'copy_paste_ready',
      }),
    },
    {
      key: 'DRAFT',
      role: 'assistant',
      style: 'soft',
      content: m('DRAFT', {
        rules: {
          no_bullets: true,
          no_general_advice: true,
          no_diagnosis: true,
          no_checklist: true,
          output_only: true,
          end_with_one_question: true,
          questions_max: 1,
        },
        structure_hint: [
          '1) ひとこと導入（相手への敬意/前提）',
          '2) いまの状況（事実を短く）',
          '3) 自分の迷い（結論を押し付けずに）',
          '4) 相手が自分で答えを出せる問いを1つだけ',
        ],
        tone_hint: 'plain_warm_no_push',
      }),
    },
  ];
}

function buildStabilizeSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  const last = norm(ctx?.lastSummary);
  const seed = last || t;

  const unknownish =
    /分からない|わからない|よく分からない|意味が分からない|ピンとこない|何言ってるか分からない|理解できない/.test(t);

  const cuts = [
    { id: 'which_part', label: '分からないのは「言葉」？「狙い」？「手順」？' },
    { id: 'expected', label: 'あなたが欲しいのは「設計の地図」？「1つの修正」？「動作の証拠」？' },
    { id: 'blocker', label: '止まってるのは「理解」？「実装」？「検証」？' },
  ];

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        last: last ? clamp(last, 200) : null,
        user: clamp(t, 200),
        unknownish,
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'explain_unknown_shape',
        seed: clamp(seed, 160),
        q: 0,
        avoid: ['general_advice', 'cheer_up', 'tell_user_to_think_more', 'ask_for_details_first'],
        shape: { lines: [4, 10], no_checklist: true, no_bullets: false },
      }),
    },
    {
      key: 'NEXT',
      role: 'assistant',
      style: 'soft',
      content: m('NEXT_HINT', {
        mode: 'advance_hint',
        hint: {
          kind: 'pick_one_cut',
          cuts,
          must_include_one_cut_label: true,
          questions_max: 1,
          avoid: ['general_advice', 'cheer_up'],
        },
      }),
    },
  ];
}

function buildILineSlots(ctx?: { lastSummary?: string | null }, seedText?: string): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const seed = norm(seedText ?? last);

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        last: last ? clamp(last, 120) : null,
        seed: seed ? clamp(seed, 120) : null,
      }),
    },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'direction_only' }) },
    {
      key: 'I',
      role: 'assistant',
      style: 'neutral',
      content: m('Q', { kind: 'i_line', ask: 'future_priority_one_phrase' }),
    },
  ];
}

function buildRepairSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const u = norm(userText);

  if (last) {
    return [
      { key: 'ACK', role: 'assistant', style: 'soft', content: m('ACK', { kind: 'repair', user: clamp(u, 80) }) },
      { key: 'RESTORE', role: 'assistant', style: 'neutral', content: m('RESTORE', { last: clamp(last, 160) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'angle_change', avoid: ['question_loop', 'binary_choice'] }) },
      { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) },
    ];
  }

  return [
    { key: 'ACK', role: 'assistant', style: 'soft', content: m('ACK', { kind: 'repair', user: clamp(u, 80) }) },
    { key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'restore_last_one_liner' }) },
  ];
}

function buildHowToSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);

  if (looksLikeILineMoment(userText, ctx)) {
    return buildILineSlots({ lastSummary: last }, userText);
  }

  if (last) {
    return [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { last: clamp(last, 160) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'criteria_first', avoid: ['more_options'] }) },
    ];
  }

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(norm(userText), 120) }) },
    { key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'topic_one_liner' }) },
  ];
}

function buildDefaultSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  if (!t) return buildEmptySlots();

  if (looksLikeILineMoment(t, { lastSummary: ctx?.lastSummary ?? null })) {
    return buildILineSlots({ lastSummary: ctx?.lastSummary ?? null }, t);
  }

  if (t.length <= 10) {
    const base: NormalChatSlot[] = [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 80), short: true }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'keep_focus' }) },
    ];

    if (looksLikeInnerConcern(t)) {
      base.push({ key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) });
      return base;
    }

    base.push({ key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'peak_moment_one_liner' }) });
    return base;
  }

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 200) }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'find_trigger_point' }) },
  ];
}

function buildExpansionSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);

  if (looksLikeILineMoment(t, { lastSummary: ctx?.lastSummary ?? null })) {
    return buildILineSlots({ lastSummary: ctx?.lastSummary ?? null }, t);
  }

  const seed = norm(ctx?.lastSummary) || t;

  const baseAvoid = ['general_advice', 'distance_tips', 'communication_tips', 'cheer_up', 'dictionary_explain'];
  const isFlagWord = t.includes('旗印');

  const cutsDefault = [
    { id: 'target', label: 'しんどいのは「特定の1人」？それとも「複数人の空気」？' },
    { id: 'timing', label: '強いのは「会う前／最中／会った後」のどこ？' },
    { id: 'type', label: '近いのは「摩耗（気を使いすぎ）／侵入（踏み込まれる）／不一致（通じない）」？' },
  ];

  const cutsFlag = [
    { id: 'usecase', label: '「旗印」と言いたくなるのは、いま“言葉の定義”じゃなく“運用”が欲しい時。' },
    { id: 'function', label: 'その運用はどれに近い？「迷いを止める／判断の軸を揃える／書き手を矯正する」' },
    { id: 'proof', label: '“答えを出せる位置”に立ったサインは何？（迷いが減る／一手が出る／読後に手が動く 等）' },
  ];

  const advanceHint = {
    kind: 'self_answer_scaffold',
    questions_max: 1,
    avoid: baseAvoid,
    cuts: isFlagWord ? cutsFlag : cutsDefault,
  };

  if (looksLikeThinReply(t) || looksLikeInnerConcern(seed + ' ' + t) || looksLikeFeedback(t)) {
    return [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 200), seed: clamp(seed, 200) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'explain_angle_change', q: 0 }) },
      { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'advance_hint', hint: advanceHint }) },
    ];
  }

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 240), seed: clamp(seed, 160) }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'explain_angle_change', q: 0 }) },
    { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'advance_hint', hint: advanceHint }) },
  ];
}

// ---- main ----

type BranchKind = 'REPAIR' | 'DETAIL' | 'STABILIZE' | 'OPTIONS' | 'C_BRIDGE' | 'I_BRIDGE' | 'UNKNOWN';

function normalizeBranch(args: {
  raw: BranchKind | null | undefined;
  signals?: { repair?: boolean; stuck?: boolean; detail?: boolean; topicHint?: string | null } | null;
  expansionKind?: 'NONE' | 'TENTATIVE' | 'BRANCH' | null;
  userText: string;
  recallCheck: boolean;
}): BranchKind {
  const raw = (args.raw ?? 'UNKNOWN') as BranchKind;
  const t = norm(args.userText);

  if (args.recallCheck) {
    return raw && raw !== 'UNKNOWN' ? raw : 'UNKNOWN';
  }

  if (!t) return raw && raw !== 'UNKNOWN' ? raw : 'UNKNOWN';

  const unknownish =
    /分からない|わからない|よく分からない|意味が分からない|ピンとこない|何言ってるか分からない|理解できない/.test(t);

  if (unknownish || looksLikeThinReply(t) || looksLikeInnerConcern(t)) {
    return 'STABILIZE';
  }

  if (raw && raw !== 'UNKNOWN') return raw;

  const s = args.signals ?? null;
  if (s?.repair) return 'REPAIR';
  if (s?.stuck) return 'STABILIZE';
  if (s?.detail) return 'DETAIL';

  if (args.expansionKind === 'BRANCH' || args.expansionKind === 'TENTATIVE') {
    return 'DETAIL';
  }

  return 'UNKNOWN';
}

export function buildNormalChatSlotPlan(args: {
  userText: string;
  context?: {
    lastSummary?: string | null;
    recentUserTexts?: string[];
  };
}): NormalChatSlotPlan {
  const stamp = 'normalChat.ts@2026-01-15#phase11-slots-v1.2';
  const userText = norm(args.userText);
  const ctx = args.context;

  const recent = (ctx?.recentUserTexts ?? []).map((x) => String(x ?? '')).filter(Boolean);
  const prevUser = recent.length >= 1 ? recent[recent.length - 1] : null;
  const prevPrevUser = recent.length >= 2 ? recent[recent.length - 2] : null;

  const pack = buildContextPack({
    lastUser: userText || null,
    prevUser,
    prevPrevUser,
    lastAssistant: null,
    shortSummaryFromState: ctx?.lastSummary ?? null,
    topicFromState: null,
  });

  const effectiveLastSummary = pack.shortSummary ?? ctx?.lastSummary ?? null;

  const signals: any = userText ? computeConvSignals(userText) : null;

  const rawBranch: BranchKind = userText
    ? (decideConversationBranch({
        userText,
        signals,
        ctx: pack,
        depthStage: null,
        phase: null,
      }) as BranchKind)
    : 'UNKNOWN';

  let expansionKind: 'NONE' | 'TENTATIVE' | 'BRANCH' | null = null;
  if (userText) {
    const exp = detectExpansionMoment({
      userText,
      recentUserTexts: (ctx?.recentUserTexts ?? []).map((x) => String(x ?? '')),
    });
    expansionKind = exp.kind;
    console.log('[IROS/EXPANSION]', { kind: exp.kind, userHead: userText.slice(0, 40) });
  }

  const recallCheck = userText ? looksLikeRecallCheck(userText) : false;

  const branch: BranchKind = normalizeBranch({
    raw: rawBranch,
    signals,
    expansionKind,
    userText,
    recallCheck,
  });

  let slots: NormalChatSlot[] = [];
  let reason = 'default';

  if (!userText) {
    reason = 'empty';
    slots = buildEmptySlots();
  } else if (looksLikeEndConversation(userText)) {
    reason = 'end';
    slots = buildEndSlots();
  } else if (looksLikeComposeTask(userText)) {
    reason = 'compose';
    slots = buildComposeSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (recallCheck) {
    reason = 'recall-check';
    slots = buildRecallCheckSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'REPAIR' || looksLikeRepair(userText)) {
    reason = 'repair';
    slots = buildRepairSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'STABILIZE') {
    reason = 'stabilize';
    slots = buildStabilizeSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (looksLikeHowTo(userText)) {
    reason = 'how-to';
    slots = buildHowToSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'DETAIL') {
    reason = 'detail';
    slots = buildExpansionSlots(userText, { lastSummary: effectiveLastSummary });
  } else {
    if (expansionKind === 'BRANCH' || expansionKind === 'TENTATIVE') {
      reason = `expansion-${String(expansionKind).toLowerCase()}`;
      slots = buildExpansionSlots(userText, { lastSummary: effectiveLastSummary });
    } else {
      reason = 'default';
      slots = buildDefaultSlots(userText, { lastSummary: effectiveLastSummary });
    }
  }

  if (!Array.isArray(slots) || slots.length === 0) {
    const fallbackReason = reason;
    reason = `fallback(${fallbackReason})`;
    slots = userText ? buildDefaultSlots(userText, { lastSummary: effectiveLastSummary }) : buildEmptySlots();

    if (!Array.isArray(slots) || slots.length === 0) {
      reason = `fallback-end(${fallbackReason})`;
      slots = buildEndSlots();
    }
  }

  const slotsNormalized = normalizeSlotsForFramePlan(slots, { idPrefix: 'N' });

  console.log('[IROS/NORMAL_CHAT][PLAN]', {
    stamp,
    reason,
    branch,
    rawBranch,
    expansionKind,
    recallCheck,
    topicHint: (signals?.topicHint as string | null) ?? null,
    userHead: userText.slice(0, 40),
    lastSummary: effectiveLastSummary ? effectiveLastSummary.slice(0, 80) : null,
    slots: slotsNormalized.map((s) => ({
      slotId: s.slotId ?? null,
      key: s.key,
      len: String(s.content ?? '').length,
      head: String(s.content ?? '').slice(0, 40),
    })),
  });

  return {
    kind: 'normal-chat',
    slotPlanPolicy: 'FINAL',
    stamp,
    reason,
    slots: slotsNormalized,
  };
}
