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
  content: string;
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

function scoreText(t: string) {
  // 簡易な決定的スコア（ランダム禁止 / テンプレ固定を避けるための分岐に使う）
  let s = 0;
  for (let i = 0; i < t.length; i++) s = (s + t.charCodeAt(i) * (i + 1)) % 9973;
  return s;
}

function pickOne<T>(t: string, xs: T[]): T {
  if (!xs.length) throw new Error('pickOne: empty');
  const idx = scoreText(t) % xs.length;
  return xs[idx]!;
}

function looksLikeInnerConcern(text: string) {
  const t = norm(text);
  if (!t) return false;

  // ✅ 内的相談（迷い/不安/方向/責任/意味/可能性…）
  // → ここで “場面/相手” を聞くと質問攻め化しやすいので、Q を止める
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

// “薄い返答” を検出（例：日常です、まだです、わからない、可能性の話です）
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

  // 短文は薄い扱い（質問攻め回避）
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

// REPAIR（取りこぼし/ループ指摘）
function looksLikeRepair(text: string) {
  const t = norm(text);
  if (!t) return false;

  // ✅ まずは強い正規化ワード（部分一致想定）
  const repairWords = [
    // 言った系
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

    // 話した系（今回の「さっき話しましたよ？」を拾う）
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

    // ループ/同じ系
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

// HOW_TO（どうしたらいい系）
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

// I-line（方向へ）
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

// ---- slot builders ----

function buildEndSlots(): NormalChatSlot[] {
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: '了解。ここで終わりにします。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: 'また必要になったら、続きだけ置いてください。' },
  ];
}

function buildEmptySlots(): NormalChatSlot[] {
  return [
    {
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: '大丈夫。いま困ってることを短く一言だけでいいよ。',
    },
  ];
}

function buildILineSlots(ctx?: { lastSummary?: string | null }, seedText?: string): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const seed = norm(seedText ?? last);

  const slots: NormalChatSlot[] = [];

  if (last) {
    slots.push({
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: `いまの話：${clamp(last, 80)}`,
    });
  } else {
    slots.push({
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: 'わかった。方向だけ合わせよう。',
    });
  }

  slots.push({
    key: 'B',
    role: 'assistant',
    style: 'neutral',
    content: pickOne(seed, [
      '手段の話は一回止めて、方向だけ見るね。',
      'ここで「やり方」に寄ると、同じ所を回りやすい。いったん方向。',
      '結論を急ぐより、まず“向き”を揃える方が早い。',
    ]),
  });

  slots.push({
    key: 'I',
    role: 'assistant',
    style: 'neutral',
    content: 'もし少し先のあなたがこれを見てたら、何を大事にしたいって言いそう？',
  });

  return slots;
}

// REPAIR：責めない / 直前を“復元” → 見方を変えて前へ
function buildRepairSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);
  const u = norm(userText);

  if (last) {
    const base: NormalChatSlot[] = [
      { key: 'A', role: 'assistant', style: 'soft', content: 'ごめん、取りこぼした。' },
      { key: 'B', role: 'assistant', style: 'neutral', content: `いま残す：${clamp(last, 80)}` },
      {
        key: 'C',
        role: 'assistant',
        style: 'neutral',
        content: pickOne(last + u, [
          'ここで壊れやすいのは、中身じゃなくて“切り口が固定されること”。いまは原因探しより、見方を一段変える。',
          '同じ感じに聞こえる時は、話が浅いのではなく、角度が固定されてるだけ。角度を変えると、自然に次が出る。',
          'ループして見えるのは、問いが悪いというより切り口が一定になりがちだから。ここからは解説で前に進める。',
        ]),
      },
    ];

    return base;
  }

  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'ごめん、聞き直す。' },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: '直前の要点を“一言だけ”置いて。そこから先はこっちで広げる。',
    },
  ];
}

function buildHowToSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);

  if (looksLikeILineMoment(userText, ctx)) {
    return buildILineSlots({ lastSummary: last }, userText);
  }

  if (last) {
    const base: NormalChatSlot[] = [
      { key: 'A', role: 'assistant', style: 'soft', content: `いま話してること：${clamp(last, 80)}` },
      {
        key: 'B',
        role: 'assistant',
        style: 'neutral',
        content: pickOne(last, [
          '「どうしたらいい？」が出るのは、やり方が無いからじゃなくて、優先順位がまだ揺れてる時が多い。',
          'ここで手段を増やすと迷いが増える。まず“守りたいもの”と“増やしたいもの”を分けると進む。',
          'いま必要なのは完璧な正解より、選び直しの基準。基準が決まると手段は勝手に集まる。',
        ]),
      },
    ];

    return base;
  }

  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'わかった。まず要点だけ掴む。' },
    {
      key: 'Q',
      role: 'assistant',
      style: 'neutral',
      content: 'いま扱いたい話を“一言だけ”で置いて。',
    },
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
      { key: 'A', role: 'assistant', style: 'soft', content: `いまの言葉：${clamp(t, 60)}` },
      {
        key: 'B',
        role: 'assistant',
        style: 'neutral',
        content: pickOne(t, [
          '短い言葉の時は、説明できない“違和感”が先に出てることがある。',
          '短いほど、芯がそのまま出てることが多い。',
          'いまの一言、焦点だけ残して進めよう。',
        ]),
      },
    ];

    if (looksLikeInnerConcern(t)) return base;

    base.push({
      key: 'Q',
      role: 'assistant',
      style: 'neutral',
      content: 'それが一番強く出るのは、どの瞬間？（一言でOK）',
    });

    return base;
  }

  const base: NormalChatSlot[] = [
    { key: 'A', role: 'assistant', style: 'soft', content: `いまの話：${clamp(t, 90)}` },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: pickOne(t, [
        'ここで大事なのは、正解探しより「反応が強くなる点」を押さえること。',
        'この手の迷いは、内容より“スイッチが入る瞬間”を掴むと進む。',
        '問題は“どこで強くなるか”に隠れてることが多い。まず輪郭を出そう。',
      ]),
    },
  ];

  return base;
}

// ---- expansion ----

function buildExpansionSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);

  if (looksLikeILineMoment(t, { lastSummary: ctx?.lastSummary ?? null })) {
    return buildILineSlots({ lastSummary: ctx?.lastSummary ?? null }, t);
  }

  const seed = norm(ctx?.lastSummary) || t;

  if (looksLikeThinReply(t) || looksLikeInnerConcern(seed + ' ' + t)) {
    return [
      { key: 'A', role: 'assistant', style: 'soft', content: `いまの話：${clamp(t, 90)}` },
      {
        key: 'EXPLAIN',
        role: 'assistant',
        style: 'neutral',
        content: pickOne(seed + t, [
          'ここで情報を増やすより、見方を一段変える方が早い。いま出てるのは“出来事”というより内側の重さの方。',
          '「日常」と言える時点で、問題は一点じゃなく“じわっと続く構造”になってる。だから質問で絞るより輪郭を先に出す。',
          'いまは結論を急がなくていい。まず“何が引っかかってるか”が言語化できると、次が勝手に湧く。',
        ]),
      },
      {
        key: 'NEXT',
        role: 'assistant',
        style: 'soft',
        content: pickOne(seed + t, [
          '続けて話していい。短い一言のままでも大丈夫。',
          'このまま、頭に浮かんだ順で置いてください。',
        ]),
      },
    ];
  }

  const base: NormalChatSlot[] = [
    { key: 'A', role: 'assistant', style: 'soft', content: `いまの話：${clamp(t, 90)}` },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: pickOne(t, [
        'いまは判断より、引っかかりを一度だけ言語化する方が早い。',
        'ここは結論を急がなくていい。引っかかりの正体を言葉にすると進む。',
        '分岐は正解探しじゃなくて、「反応が強くなる点」を押さえるだけで整う。',
      ]),
    },
  ];

  const alreadyHasIrritation = containsAny(t, ['嫌', '無理', '怖い', '不安', 'しんどい', 'つらい', 'きつい', 'モヤ', '違和感']);
  if (!alreadyHasIrritation) {
    base.push({
      key: 'Q',
      role: 'assistant',
      style: 'neutral',
      content: 'いま一番引っかかってるのは、どこ？（一言でOK）',
    });
  }

  return base;
}

// ✅ phase11 branch helpers (minimal)
function buildStabilizeSlots(userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const t = norm(userText);
  const last = norm(ctx?.lastSummary);

  const seed = last || t;

  return [
    { key: 'A', role: 'assistant', style: 'soft', content: last ? `いまの流れ：${clamp(last, 90)}` : `いまの言葉：${clamp(t, 90)}` },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: pickOne(seed, [
        'ここは詰めない。いま出てるのは整理不足じゃなくて、負荷が先に立ってる感じ。',
        '進め方の工夫より、いったん“負荷の位置”を落ち着かせた方が会話が動く。',
        '同じ所を回る時は、情報不足じゃなくて圧が先にある。まず圧を薄くする。',
      ]),
    },
    {
      key: 'NEXT',
      role: 'assistant',
      style: 'soft',
      content: pickOne(seed, [
        '続けて置いていい。短くてもいい。',
        '途切れても大丈夫。いま浮かぶ順で。',
      ]),
    },
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
  const stamp = 'normalChat.ts@2026-01-11#conversation-first-no-box-no-choices-v2.2';
  const userText = norm(args.userText);
  const ctx = args.context;

  // ✅ Build a usable “lastSummary” even when ctx.lastSummary is null
  // recentUserTexts は「過去ユーザー発話」想定（最大3つ使う）
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

  // ✅ signals/branch
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
    // ✅ branch優先（signals由来のrepairも拾う）
    reason = 'repair';
    slots = buildRepairSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'STABILIZE') {
    reason = 'stabilize';
    slots = buildStabilizeSlots(userText, { lastSummary: effectiveLastSummary });
  } else if (branch === 'DETAIL') {
    // detail は expansion に寄せる（質問攻めを防ぐ）
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
    slots: slots.map((s) => ({ key: s.key, len: s.content.length, head: s.content.slice(0, 22) })),
  });

  return {
    kind: 'normal-chat',
    slotPlanPolicy: 'FINAL',
    stamp,
    reason,
    slots,
  };
}
