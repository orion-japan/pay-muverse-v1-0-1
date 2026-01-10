// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flexible slots, depth-invariants)
//
// ─────────────────────────────────────────────────────────────
// ✅ このファイルの責務（normalChat）
// - “雑談の最終保険”：空返答を防ぎ、会話の呼吸を止めない
// - ただし「深まらない」を放置しないため、最低限の深掘り不変条件を持つ
//
// ✅ 深まる不変条件（INVARIANTS）
// A) REPAIR（取りこぼし/ループ指摘）が来たら必ず「復元→具体化」へ進める
//    例: 「今言ったよね？」「さっき言った」「もう言った」など
//    - 1) 取りこぼしを認める（短く）
//    - 2) 直前要点を復元（context があれば提示。なければ“今の要点”を聞く）
//    - 3) “場面/瞬間” を聞く（どの瞬間に起きてる？）
//
// B) 価値語（自由/望み/大事/安心…）が出たら必ず「定義→摩擦点」へ進める
//    - 1) 価値の種類を1語で選ばせる（時間/場所/裁量/人間関係/お金 など）
//    - 2) 削られる“瞬間”を聞く（どの場面で削られる？）
//
// C) 結論要求（「結論」「先に結論」）は “確認質問をやめて” まず結論の型で返す
//    - 対象不明なら “名詞だけ” を求める（二択にしない）
//
// ✅ ルール
// - slots は「表示順」だけが意味を持つ
// - key は任意文字列でよい（ただし重複はしない）
// - slotPlanPolicy は常に FINAL
// - rephrase は inKeys と一致したときだけ採用（既存の検証思想を維持）
//
// 注意：
// - 深い判断/診断は orchestrator 側で plan を切り替える。
// - ここは“深掘りの最低保証”まで。過剰な分類質問はしない。
// ─────────────────────────────────────────────────────────────

import type { SlotPlanPolicy } from '../server/llmGate';

export type NormalChatSlot = {
  key: string; // ✅ 固定しない（任意キー）
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

// ---- helpers (small + safe) ----

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function hasQuestionMark(t: string) {
  return /[？\?]/.test(t);
}

function containsAny(t: string, words: string[]) {
  return words.some((w) => t.includes(w));
}

// ---- heuristics ----

function looksLikeWantsConclusion(text: string) {
  const t = norm(text);
  if (/^(結論|結論です|結論だけ|結論を|先に結論)$/.test(t)) return true;
  if (t.includes('先に結論')) return true;
  if (t.includes('結論だけ')) return true;
  if (t.includes('結論')) return true;
  return false;
}

function looksLikeNoEchoRequest(text: string) {
  const t = norm(text);
  return (
    t.includes('オウム返し') ||
    t.includes('復唱') ||
    t.includes('二択') ||
    t.includes('ただ話して') ||
    t.includes('雑談して') ||
    t.includes('質問しないで') ||
    t.includes('確認しないで')
  );
}

function looksLikePreferenceQuestion(text: string) {
  const t = norm(text);
  return (
    /好き[？\?]/.test(t) ||
    /嫌い[？\?]/.test(t) ||
    /どっち(派)?[？\?]/.test(t) ||
    /おすすめ[？\?]/.test(t) ||
    /どれ(が|を)[？\?]/.test(t)
  );
}

function looksLikeJustWondering(text: string) {
  const t = norm(text);
  return (
    t.includes('ただの疑問') ||
    t.includes('なんとなく') ||
    t.includes('気がする') ||
    t.includes('ふと思った') ||
    t.includes('気になるだけ')
  );
}

function isTinyTalk(text: string) {
  const t = norm(text);
  return (
    t.length <= 12 ||
    /^(え|うん|そう|なるほど|まじ|ほんと|へぇ|はい|ok|OK|hai|konnbanha)[\!！\?？]*$/i.test(t) ||
    /^(今日|今|さっき|だよね)[\!！\?？]*$/.test(t)
  );
}

function looksLikeWeatherSmallTalk(text: string) {
  const t = norm(text);
  return (
    t.includes('風が強い') ||
    t.includes('寒い') ||
    t.includes('暑い') ||
    t.includes('雨') ||
    t.includes('雪') ||
    t.includes('台風') ||
    t.includes('花粉') ||
    t.includes('この時期') ||
    t.includes('毎年') ||
    t.includes('季節')
  );
}

function looksLikeSmallTalkFact(text: string) {
  const t = norm(text);
  return (
    /春一番/.test(t) ||
    /いつ(頃|ごろ)/.test(t) ||
    /何月/.test(t) ||
    /何日/.test(t) ||
    /何回/.test(t) ||
    /今日は/.test(t) ||
    /今は/.test(t) ||
    /1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月/.test(t)
  );
}

// ---- NEW: depth invariants triggers ----

// A) REPAIR trigger: “言ったよね/さっき/もう言った/それ今言った” etc
function looksLikeRepair(text: string) {
  const t = norm(text);
  if (!t) return false;
  // ✅ 「? が無い」でも repair 扱いにする（ループ拒否を逃さない）
  return containsAny(t, [
    '今言った',
    'いま言った',
    'さっき言った',
    'もう言った',
    '言ったよね',
    '言ったでしょ',
    'それ言った',
    '同じこと',
    '繰り返し',
    'またそれ',
  ]);
}

// B) VALUE trigger: value words that usually need definition → friction point
function extractValueKeyword(text: string): string | null {
  const t = norm(text);
  const values = ['自由', '望み', '大事', '安心', '幸せ', '充実', '成長', '誇り', 'やりがい'];
  for (const v of values) {
    if (t.includes(v)) return v;
  }
  return null;
}

function looksLikeValueStatement(text: string) {
  const t = norm(text);
  const v = extractValueKeyword(t);
  if (!v) return false;
  // “価値語っぽい”の最低条件：名詞で語っている or 望む/大事/したい が近い
  return (
    t.length >= 6 &&
    (t.includes('ほしい') ||
      t.includes('望') ||
      t.includes('したい') ||
      t.includes('でいたい') ||
      t.includes('が大事') ||
      t.endsWith('かな') ||
      t.endsWith('です') ||
      t.endsWith('だ'))
  );
}

// ---- identity / capability (micro FAQ) ----

function looksLikeWhoAreYou(text: string) {
  const t = norm(text);
  return (
    /あなたは誰|誰ですか|だれ|誰\?|\?誰|who are you/i.test(t) ||
    /自己紹介/.test(t)
  );
}

function looksLikeWhatCanYouDo(text: string) {
  const t = norm(text);
  return (
    /何ができ|何ができます|できること|what can you do/i.test(t) ||
    /使い方|どう使う/.test(t)
  );
}

// ---- “echo gate” ----
// オウム返しは “理解の担保” になる時だけ。
// ただし A/B のトリガー時は、echo より invariant を優先する。
function shouldEcho(userText: string) {
  const t = norm(userText);
  if (!t) return false;

  if (looksLikeRepair(t)) return false; // invariant優先
  if (looksLikeValueStatement(t)) return false; // invariant優先

  if (looksLikeNoEchoRequest(t)) return false;
  if (isTinyTalk(t)) return false;
  if (looksLikeSmallTalkFact(t)) return false;
  if (looksLikeWeatherSmallTalk(t)) return false;
  if (looksLikeWantsConclusion(t)) return false;
  if (looksLikePreferenceQuestion(t)) return false;
  if (looksLikeJustWondering(t)) return false;

  const hasQM = hasQuestionMark(t);
  const longer = t.length >= 18;
  return hasQM && longer;
}

// ---- optional soft signature (rare) ----

function buildSoftSignature(opts: { userText: string; allow: boolean }): string | null {
  if (!opts.allow) return null;
  const r = Math.random();
  if (r > 0.22) return null; // 78%は出さない

  const t = norm(opts.userText);
  const candidates: string[] = [];

  if (looksLikeWantsConclusion(t)) candidates.push('先に結論からいく。');
  if (looksLikeJustWondering(t)) candidates.push('そのままの疑問で大丈夫。');
  if (looksLikeWeatherSmallTalk(t)) candidates.push('体感の違和感って、けっこう当たってる。');

  candidates.push('迷いを増やさない。');
  candidates.push('静かにいこう。');

  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

// ---- slot builders ----

function buildConclusionFirstSlots(): NormalChatSlot[] {
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'OK。先に結論からいく。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: '結論がほしいテーマは何？（名詞だけでOK）' },
  ];
}

function buildWhoAreYouSlots(): NormalChatSlot[] {
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: '私は iros。会話を「いまの一点」と「次の一手」に整える。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: 'まず、今日いちばん詰まってる一言だけ置いて。🪔' },
  ];
}

function buildWhatCanYouDoSlots(): NormalChatSlot[] {
  return [
    {
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: 'できることは3つだけ。①一点を残す ②次の一手に落とす ③流れ（Q/深度/位相）を整える。',
    },
    { key: 'B', role: 'assistant', style: 'neutral', content: 'いま扱いたいテーマを一語で。🪔' },
  ];
}

function buildRepairSlots(_userText: string, ctx?: { lastSummary?: string | null }): NormalChatSlot[] {
  const last = norm(ctx?.lastSummary);

  // contextがあるなら “復元” を明示して戻す
  if (last) {
    return [
      { key: 'A', role: 'assistant', style: 'soft', content: 'ごめん、取りこぼした。戻すね。' },
      { key: 'B', role: 'assistant', style: 'neutral', content: `いま残す一点はこれ：${clamp(last, 54)}` },
      {
        key: 'C',
        role: 'assistant',
        style: 'neutral',
        content: 'それが“削られる瞬間”はどこ？（仕事のどの場面？）',
      },
    ];
  }

  // contextがない時：復元できないので“今の要点”を一語で出させて復元する
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'ごめん、取りこぼした。' },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: '今あなたが言った“一点”を、もう一回だけ置いて。（短文でOK）',
    },
    {
      key: 'C',
      role: 'assistant',
      style: 'neutral',
      content: 'それが削られる“瞬間”はどこ？（仕事のどの場面？）',
    },
  ];
}

function buildValueDeepenSlots(userText: string): NormalChatSlot[] {
  const t = norm(userText);
  const v = extractValueKeyword(t) ?? 'それ';

  // “定義→摩擦点” の最小保証
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: `いい。いま出てる芯は「${v}」。` },
    { key: 'B', role: 'assistant', style: 'neutral', content: `${v}って、どの種類？（時間 / 場所 / 裁量 / 人間関係 / お金）` },
    {
      key: 'C',
      role: 'assistant',
      style: 'neutral',
      content: `それが仕事の“どの瞬間”で削られてる？（例：朝会/締切/上司/評価/通勤…）`,
    },
  ];
}

function buildPreferenceSlots(userText: string): NormalChatSlot[] {
  const t = norm(userText);

  if (/もも/.test(t) && /好き[？\?]/.test(t)) {
    return [
      { key: 'A', role: 'assistant', style: 'soft', content: '好き。香りが強くて、甘さの立ち上がりがきれい。' },
      { key: 'B', role: 'assistant', style: 'neutral', content: '白桃派？黄桃派？（一語でOK）' },
    ];
  }

  return [
    { key: 'A', role: 'assistant', style: 'soft', content: '直球で答えるよ。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: `いま聞いてるのは：${clamp(t, 28)}` },
  ];
}

function buildSmallTalkFactSlots(userText: string): NormalChatSlot[] {
  const t = norm(userText);

  if (/春一番/.test(t) && /いつ(頃|ごろ)|何月/.test(t)) {
    return [
      { key: 'A', role: 'assistant', style: 'soft', content: '春一番は、だいたい2〜3月に吹くことが多い（年や地域で前後する）。' },
      { key: 'B', role: 'assistant', style: 'neutral', content: 'いま1月なら「まだ先」って感覚は合ってる。' },
    ];
  }

  return [{ key: 'A', role: 'assistant', style: 'soft', content: '目安はあるけど、年や場所で前後するよ。' }];
}

function buildWeatherSmallTalkSlots(): NormalChatSlot[] {
  return [
    {
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: '体感としては合ってる。この時期は寒気の入り方で風が強まって「毎年この感じ」になりやすい。',
    },
  ];
}

function buildJustWonderingSlots(): NormalChatSlot[] {
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'うん、そのままの疑問で大丈夫。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: 'もし続けるなら：その疑問が出た“きっかけ”だけ教えて。' },
  ];
}

function buildTinyTalkSlots(userText: string): NormalChatSlot[] {
  const t = norm(userText);
  // ✅ “名詞だけ置いて” 固定はやめる：tiny でも会話が進む最小二択
  return [
    { key: 'A', role: 'assistant', style: 'soft', content: 'うん。' },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content:
        hasQuestionMark(t)
          ? '問いとして受け取った。いま欲しいのはどっち？（A:短い答え / B:整理して次の一手）🪔'
          : '次はどっちでいく？（A:状況を1行 / B:気持ちを1行）🪔',
    },
  ];
}

function buildDefaultSlots(userText: string): NormalChatSlot[] {
  const t = norm(userText);
  const echo = shouldEcho(t);
  const isQ = hasQuestionMark(t);

  if (echo) {
    return [
      {
        key: 'A',
        role: 'assistant',
        style: 'neutral',
        content: isQ ? `うん、「${clamp(t, 38)}」の問いだね。` : `うん、「${clamp(t, 38)}」だね。`,
      },
      {
        key: 'B',
        role: 'assistant',
        style: 'soft',
        content: isQ ? '短く答える。必要な条件だけ、あとで聞く。' : 'そのまま進めていい。続けて。',
      },
    ];
  }

  // tiny-talk でも “深まり停止” を避ける：固定誘導は禁止
  if (isTinyTalk(t)) return buildTinyTalkSlots(t);

  return [
    { key: 'A', role: 'assistant', style: 'soft', content: isQ ? 'うん。短く返すね。' : 'うん。続けて。' },
    { key: 'B', role: 'assistant', style: 'neutral', content: isQ ? '必要な条件だけ聞く。' : 'いまの温度感のまま話して。' },
  ];
}

// ---- main ----

export function buildNormalChatSlotPlan(args: {
  userText: string;
  context?: {
    lastSummary?: string | null;
  };
}): NormalChatSlotPlan {
  const stamp = 'normalChat.ts@2026-01-10#flex-slots-v5-depth-invariants';
  const userText = norm(args.userText);
  const ctx = args.context;

  let slots: NormalChatSlot[] = [];
  let reason = 'default';

  if (!userText) {
    reason = 'empty';
    slots = [
      { key: 'A', role: 'assistant', style: 'soft', content: 'うん。空でも大丈夫。いまの気配だけ、続けて。' },
    ];
  } else if (looksLikeWantsConclusion(userText)) {
    reason = 'conclusion-first';
    slots = buildConclusionFirstSlots();
  } else if (looksLikeWhoAreYou(userText)) {
    reason = 'who-are-you';
    slots = buildWhoAreYouSlots();
  } else if (looksLikeWhatCanYouDo(userText)) {
    reason = 'what-can-you-do';
    slots = buildWhatCanYouDoSlots();
  } else if (looksLikeRepair(userText)) {
    reason = 'repair';
    slots = buildRepairSlots(userText, { lastSummary: ctx?.lastSummary ?? null });
  } else if (looksLikeValueStatement(userText)) {
    reason = 'value-deepen';
    slots = buildValueDeepenSlots(userText);
  }

  // ✅ X) 退職/仕事の相談は「続けて」ループを起こしやすいので二択に固定（←早めに判定）
  else if (looksLikeQuitWorkConsult(userText)) {
    reason = 'quit-work-two-choice';
    const last = (ctx?.lastSummary ?? '').trim();
    slots = [
      {
        key: 'A',
        role: 'assistant',
        style: 'soft',
        content:
          `受け取った。${last ? `いまの一点：「${last}」` : 'いまの一点は残す。'}\n` +
          `「意図に合ってない」と「生活」の両方が同時にある。ここが本題だね。`,
      },
      {
        key: 'B',
        role: 'assistant',
        style: 'neutral',
        content:
          `次は二択だけに絞る。\n` +
          `①辞める前提で「生活の設計」（期限/貯金/収入/次の仕事）を作る\n` +
          `②残る前提で「条件変更」（役割/時間/部署/副業）を試す\n` +
          `まずどっちを先にやる？`,
      },
    ];
  }

  // ✅ 追加：ユーザーが「相談してるんだけど？」と“ループ拒否”を明示したら、必ず二択に戻す
  else if (looksLikeConsultComplaint(userText)) {
    reason = 'consult-complaint-break';
    slots = [
      { key: 'A', role: 'assistant', style: 'soft', content: '了解。もう「続けて」には戻さない。相談として受け取る。' },
      {
        key: 'B',
        role: 'assistant',
        style: 'neutral',
        content:
          `いまは二択で進める。\n` +
          `①「辞める前提」で設計（期限/貯金/収入/次の手）\n` +
          `②「残る前提」で条件変更（役割/時間/部署/副業）\n` +
          `どっちで進める？`,
      },
    ];
  }

  // 明示的に「オウム返し/確認やめて」
  else if (looksLikeNoEchoRequest(userText)) {
    reason = 'no-echo';
    slots = [
      { key: 'A', role: 'assistant', style: 'soft', content: '了解。復唱もしないし、二択にも寄せない。' },
      { key: 'B', role: 'assistant', style: 'neutral', content: 'じゃあ、そのまま話そう。いま何が一番ひっかかってる？' },
    ];
  } else if (looksLikePreferenceQuestion(userText)) {
    reason = 'preference';
    slots = buildPreferenceSlots(userText);
  } else if (looksLikeSmallTalkFact(userText)) {
    reason = 'small-fact';
    slots = buildSmallTalkFactSlots(userText);
  } else if (looksLikeWeatherSmallTalk(userText)) {
    reason = 'weather';
    slots = buildWeatherSmallTalkSlots();
  } else if (looksLikeJustWondering(userText)) {
    reason = 'just-wondering';
    slots = buildJustWonderingSlots();
  } else {
    slots = buildDefaultSlots(userText);
  }

  // ✅ 署名（ごく稀）
  const sig = buildSoftSignature({ userText, allow: true });
  if (sig && slots.length >= 1) {
    slots = [
      { ...slots[0], content: `${sig}\n${slots[0].content}` },
      ...slots.slice(1),
    ];
  }

  const plan: NormalChatSlotPlan = {
    kind: 'normal-chat',
    slotPlanPolicy: 'FINAL',
    stamp,
    reason,
    slots,
  };

  return plan;
}

// ---- helpers ----

// ✅ X) 退職/仕事の相談検出（強化版）
function looksLikeQuitWorkConsult(userText: string) {
  const t = String(userText ?? '').trim();
  if (!t) return false;

  const hasWork = /会社|仕事|職場|上司|部署|勤務|働/.test(t);
  const hasQuit = /辞め|辞めよう|辞めたい|退職|転職|合ってない|向いてない|限界/.test(t);

  // ✅ 「どう思う？」も consult 扱いにする（ここが効く）
  const hasConsult =
    /どうしたら|どうすれば|相談|決められない|迷う|不安|悩|どう思う|意見|助けて/.test(t);

  // 退職系は「会社+辞め」だけでも相談として扱う（ループ防止優先）
  return (hasWork && hasQuit) || (hasWork && hasQuit && hasConsult);
}

// ✅ 追加：ループ拒否/相談の明示
function looksLikeConsultComplaint(userText: string) {
  const t = String(userText ?? '').trim();
  if (!t) return false;
  return /相談してる|相談なんだけど|答えて|結論|もういいから/.test(t);
}
