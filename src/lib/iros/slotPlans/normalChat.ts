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
  key: string;
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
function m(tag: string, payload?: Record<string, any>) {
  if (!payload || Object.keys(payload).length === 0) return `@${tag}`;
  // payload は writer が読む前提。可読性より “壊れにくさ” 優先で JSON に寄せる。
  return `@${tag} ${JSON.stringify(payload)}`;
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

  if (t.length <= 8) return true;
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

  return (
    t === 'どうしたらいい？' ||
    t === 'どうしたらいい' ||
    t === 'どうすればいい？' ||
    t === 'どうすればいい' ||
    t === '何したらいい？' ||
    t === '何したらいい' ||
    t.includes('どうしたら') ||
    t.includes('どうすれば') ||
    t.includes('何したら')
  );
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

// ---- slot builders（文章禁止：@TAG JSON のみ） ----

function buildEndSlots(): NormalChatSlot[] {
  return [
    { key: 'END', role: 'assistant', style: 'soft', content: m('END') },
    { key: 'NEXT', role: 'assistant', style: 'neutral', content: m('NEXT_HINT', { mode: 'resume_anytime' }) },
  ];
}

function buildEmptySlots(): NormalChatSlot[] {
  return [
    { key: 'EMPTY', role: 'assistant', style: 'soft', content: m('EMPTY', { ask: 'user_one_liner' }) },
  ];
}

function buildILineSlots(ctx?: { lastSummary?: string | null }, seedText?: string): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const seed = norm(seedText ?? last);

  // I-line は「他の質問を止めて」1本だけ
  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { last: last ? clamp(last, 120) : null, seed: seed ? clamp(seed, 120) : null }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'direction_only' }) },
    { key: 'I', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'i_line', ask: 'future_priority_one_phrase' }) },
  ];
}

function buildRepairSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const u = norm(userText);

  if (last) {
    return [
      { key: 'ACK', role: 'assistant', style: 'soft', content: m('ACK', { kind: 'repair' }) },
      { key: 'RESTORE', role: 'assistant', style: 'neutral', content: m('RESTORE', { last: clamp(last, 160) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'angle_change', avoid: ['question_loop', 'binary_choice'] }) },
      // ✅ 質問は出さない（repair は “復元→角度変更” で前へ）
      { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) },
    ];
  }

  return [
    { key: 'ACK', role: 'assistant', style: 'soft', content: m('ACK', { kind: 'repair' }) },
    { key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'restore_last_one_liner' }) },
  ];
}

function buildHowToSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);

  if (looksLikeILineMoment(userText, ctx)) {
    return buildILineSlots({ lastSummary: last }, userText);
  }

  // how-to は “手段を増やさず、基準/優先の整理” に寄せる（質問は0〜1）
  if (last) {
    return [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { last: clamp(last, 160) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'criteria_first', avoid: ['more_options'] }) },
      // ✅ 質問は無しでもOK（writer が自然に進める）
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

  // 短文：質問攻めを避け、必要なら “1問だけ”
  if (t.length <= 10) {
    const base: NormalChatSlot[] = [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 80), short: true }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'keep_focus' }) },
    ];

    // 内的相談は Q を止める
    if (looksLikeInnerConcern(t)) {
      base.push({ key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) });
      return base;
    }

    // ✅ 質問は最大1つ
    base.push({ key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'peak_moment_one_liner' }) });
    return base;
  }

  // 通常：OBS + SHIFT。Q は “必要時だけ” （ここではデフォルトは出さない）
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

  // “薄い/内的” は質問を止めて「解説＋次を置ける」へ
  if (looksLikeThinReply(t) || looksLikeInnerConcern(seed + ' ' + t)) {
    return [
      { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 160), seed: clamp(seed, 160) }) },
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'explain_angle_change', q: 0 }) },
      { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) },
    ];
  }

  // それ以外：OBS + SHIFT + （必要なら1問）
  const base: NormalChatSlot[] = [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { user: clamp(t, 200) }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'normalize_then_nudge' }) },
  ];

  const alreadyHasIrritation = containsAny(t, ['嫌', '無理', '怖い', '不安', 'しんどい', 'つらい', 'きつい', 'モヤ', '違和感']);
  if (!alreadyHasIrritation) {
    base.push({ key: 'Q', role: 'assistant', style: 'neutral', content: m('Q', { kind: 'what_sticks_one_liner' }) });
  }

  return base;
}

function buildStabilizeSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  const last = norm(ctx?.lastSummary);
  const seed = last || t;

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { last: last ? clamp(last, 200) : null, user: clamp(t, 200) }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 'reduce_pressure', seed: clamp(seed, 160) }) },
    { key: 'NEXT', role: 'assistant', style: 'soft', content: m('NEXT_HINT', { mode: 'continue_free' }) },
  ];
}

// ---- main ----

export function buildNormalChatSlotPlan(args: {
  userText: string;
  context?: {
    lastSummary?: string | null;
    recentUserTexts?: string[];
  };
}): NormalChatSlotPlan {
  const stamp = 'normalChat.ts@2026-01-13#phase11-no-user-facing-text-v3.0';
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

  const signals = userText ? computeConvSignals(userText) : null;
  const branch = userText
    ? decideConversationBranch({
        userText,
        signals,
        ctx: pack,
        depthStage: null,
        phase: null,
      })
    : 'UNKNOWN';

  let slots: NormalChatSlot[] = [];
  let reason = 'default';

  if (!userText) {
    reason = 'empty';
    slots = buildEmptySlots();
  } else if (looksLikeEndConversation(userText)) {
    reason = 'end';
    slots = buildEndSlots();
  } else if (branch === 'REPAIR' || looksLikeRepair(userText)) {
    reason = 'repair';
    slots = buildRepairSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'STABILIZE') {
    reason = 'stabilize';
    slots = buildStabilizeSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'DETAIL') {
    reason = 'detail';
    slots = buildExpansionSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (looksLikeHowTo(userText)) {
    reason = 'how-to';
    slots = buildHowToSlots(userText, { lastSummary: effectiveLastSummary });
  } else {
    const expansion = detectExpansionMoment({
      userText,
      recentUserTexts: (ctx?.recentUserTexts ?? []).map((x) => String(x ?? '')),
    });

    console.log('[IROS/EXPANSION]', { kind: expansion.kind, userHead: userText.slice(0, 40) });

    if (expansion.kind === 'BRANCH' || expansion.kind === 'TENTATIVE') {
      reason = `expansion-${expansion.kind.toLowerCase()}`;
      slots = buildExpansionSlots(userText, { lastSummary: effectiveLastSummary });
    } else {
      reason = 'default';
      slots = buildDefaultSlots(userText, { lastSummary: effectiveLastSummary });
    }
  }

  console.log('[IROS/NORMAL_CHAT][PLAN]', {
    stamp,
    reason,
    branch,
    topicHint: signals?.topicHint ?? null,
    userHead: userText.slice(0, 40),
    lastSummary: effectiveLastSummary ? effectiveLastSummary.slice(0, 80) : null,
    slots: slots.map((s) => ({ key: s.key, len: s.content.length, head: s.content.slice(0, 40) })),
  });

  return {
    kind: 'normal-chat',
    slotPlanPolicy: 'FINAL',
    stamp,
    reason,
    slots,
  };
}
