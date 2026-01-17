// src/lib/iros/slotPlans/flagReply.ts
// iros — flag reply slot plan (GPT-like normal conversation)
//
// 目的：
// - テンプレ（箱/整理/手順/観察点）を一切出さず、通常会話として成立させる
// - 返答は「短い会話文」(1–2段落) に寄せる
// - 質問は最大1つ（0でもOK）
// - A/B二択は禁止
//
// 方針：
// - scaffold（PREFACE/PURPOSE/ONE_POINT/POINTS_3/NEXT_1）は **型として残すが出力しない**
//   （既存の依存を壊さず、テンプレ暴発を止める）
// - “旗印”の骨格（CONCLUSION/DYNAMICS/DEBLAME/TRUE_QUESTION/NEXT_INVITATION）も
//   会話文として自然に見えるように最小限にする（説明口調を避ける）

export type FlagCategory =
  // --- flagship ---
  | 'CONCLUSION'
  | 'DYNAMICS'
  | 'DEBLAME'
  | 'TRUE_QUESTION'
  | 'NEXT_INVITATION'

  // --- scaffold (legacy / keep type only; DO NOT OUTPUT) ---
  | 'PREFACE'
  | 'PURPOSE'
  | 'ONE_POINT'
  | 'POINTS_3'
  | 'NEXT_1';

export type FlagReplySlot = {
  key: `FLAG_${FlagCategory}_${number}`;
  kind: FlagCategory;
  role: 'assistant';
  style: 'soft' | 'neutral';
  content: string;
};

export type BuildFlagReplyArgs = {
  userText: string;

  // 直近の状況があれば（露出禁止の前提で）入れてOK
  hasHistory?: boolean;

  // 既に別スロットで質問を使う予定があるなら true（質問0に寄せる）
  questionAlreadyPlanned?: boolean;

  // 直タスク（文面作成/手順/要点）なら true（“問い”を減らしやすい）
  directTask?: boolean;

  // legacy: 受け取るが、このファイルでは使わない（テンプレ暴発源）
  forceOnePoint?: boolean;
};

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function clamp(s: string, n: number) {
  const t = norm(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}

function hasAny(t: string, re: RegExp) {
  return re.test(t);
}

function keyOf(kind: FlagCategory, n: number): FlagReplySlot['key'] {
  const idx = Math.max(1, Math.floor(n || 1));
  return `FLAG_${kind}_${idx}` as const;
}

function pushOne(
  slots: FlagReplySlot[],
  kind: FlagCategory,
  style: 'soft' | 'neutral',
  content: string | null | undefined,
) {
  const c = norm(content ?? '');
  if (!c) return;
  slots.push({
    key: keyOf(kind, slots.filter((s) => s.kind === kind).length + 1),
    kind,
    role: 'assistant',
    style,
    content: c,
  });
}

function finalizeSlots(slots: FlagReplySlot[]) {
  return slots
    .map((s) => ({ ...s, content: clamp(s.content, 240) }))
    .filter((s) => !!norm(s.content));
}

// 安定pick（同じ入力で毎回ランダムに揺れない）
function pickOne(seed: string, list: string[]) {
  const arr = Array.isArray(list) ? list.filter((x) => !!norm(x)) : [];
  if (arr.length <= 1) return arr[0] ?? '';
  let h = 0;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return arr[h % arr.length]!;
}

// -----------------------------
// Signals (very light, non-templating)
// -----------------------------

function isShortOrThin(t: string) {
  const s = norm(t);
  if (!s) return true;
  if (s.length <= 8) return true;
  return hasAny(s, /^(うん|はい|そう|なるほど|わかった|OK|了解|たしかに|えー|まじ)+[。！？!?…]*$/);
}

function looksLikeQuestion(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /[？?]/.test(s) || hasAny(s, /(どう(すれば|したら)|なぜ|なんで|何が|何を|どこ|いつ|どれ)/);
}

function hasInnerFriction(t: string) {
  return hasAny(
    t,
    /(やりたいのに|なのに|でも|一方で|止ま(る|っ)|進ま(ない|なく)|怖(い|く)|モヤ|引っかか(る|り)|ブレーキ|重くなる)/,
  );
}

function overloadOrPanic(t: string) {
  return hasAny(t, /(パンク|限界|しんどい|つらい|疲れた|もうやだ|息が|崩れそう|耐えられない)/);
}

function selfBlameOrCollapse(t: string) {
  return hasAny(t, /(自分が悪い|自分のせい|ダメだ|向いてない|才能がない|もう無理|終わり|詰んだ)/);
}

function wantsClarity(t: string) {
  return hasAny(
    t,
    /(どれ|どっち|どう|どうしたら|どうすれば|何から|決め(られ|れ)ない|迷(う|い)|悩(む|み)|整理|要点|まとめ|結論|優先|順番)/,
  );
}

// -----------------------------
// Build parts (GPT-like conversational prose)
// - NO boxes / NO steps / NO bullet points
// - NO “まず整理しよう”
// - Keep it short, human, forward
// -----------------------------

function buildConclusion(t: string, args: BuildFlagReplyArgs): string {
  const seed = `c:${t}:${args.directTask ? 'task' : 'chat'}`;

  if (args.directTask) {
    return pickOne(seed, [
      'わかった。いまの内容で、外に出せる形に整える。',
      'OK。言い方を自然な文にして、送れる形に寄せよう。',
      '了解。目的に合わせて、ちゃんと使える文にする。',
    ]);
  }

  if (isShortOrThin(t)) {
    return pickOne(seed, [
      'うん、短くて十分。',
      '了解。いまの一言だけでも拾える。',
      'OK。まずはその一言を起点にする。',
    ]);
  }

  if (overloadOrPanic(t)) {
    return pickOne(seed, [
      'いまは頭で片づけようとすると、余計に固まるやつだね。',
      'その感じだと、整理より先に“重さ”が前に出てる。',
      '今は頑張って結論を作らなくていい。',
    ]);
  }

  if (wantsClarity(t)) {
    return pickOne(seed, [
      '決めたいのに決まらない感じ、そこがいまの中心だね。',
      '迷いが増える方向じゃなくて、いったん核を小さくしたい。',
      'いまは選択肢を増やすより、迷いの芯を拾う方が早い。',
    ]);
  }

  if (hasInnerFriction(t)) {
    return pickOne(seed, [
      '進もうとした瞬間にブレーキが入る、その感じが見えてる。',
      '動きたいのに止まる…その“止まり方”が鍵になってる。',
      '答えより先に、止まる地点を見た方が前に進む。',
    ]);
  }

  return pickOne(seed, [
    'うん、そこまで含めて今の話だね。',
    'なるほど。今の言い方の中に、もう大事な点が入ってる。',
    'OK。いま出てる感触をそのまま扱おう。',
  ]);
}

function buildDynamics(t: string, args: BuildFlagReplyArgs): string | null {
  const seed = `d:${t}:${args.hasHistory ? 'hist' : 'nohist'}`;

  // “見取り図”は短く、説明口調にしない。不要なら出さない。
  if (args.directTask) return null;

  if (hasInnerFriction(t)) {
    return pickOne(seed, [
      '「やりたい」と「止まる」が同時に出てる。',
      '前に進む直前で、重さが差し込んでくる感じ。',
      '気持ちは動いてるのに、手前で止める反応が出てる。',
    ]);
  }

  if (wantsClarity(t)) {
    return pickOne(seed, [
      '迷いが“情報不足”じゃなくて“優先の揺れ”っぽい。',
      '決め手が見つからないというより、軸が揺れてる感じ。',
      '選べるのに決められない、そこに引っかかりがある。',
    ]);
  }

  // 何でもかんでも出さない（テンプレ臭を避ける）
  return null;
}

function buildDeblame(t: string): string | null {
  const seed = `b:${t}`;

  if (selfBlameOrCollapse(t)) {
    return pickOne(seed, [
      'それを“自分の欠陥”にすると、話が進まなくなるやつだよ。',
      'いまは能力の判定にしない方がいい。まず起きてることを扱おう。',
      '自分を責める方向に寄せなくていい。状況の切り分けからで大丈夫。',
    ]);
  }

  if (overloadOrPanic(t)) {
    return pickOne(seed, [
      '弱さの話じゃなくて、負荷が大きすぎるだけに見える。',
      '今は“正しく考える”より、負荷を下げる方が先だね。',
      'しんどい時に結論を作ろうとすると、余計に消耗する。',
    ]);
  }

  return null;
}

function buildQuestion(t: string, args: BuildFlagReplyArgs): string | null {
  if (args.questionAlreadyPlanned) return null;
  if (args.directTask) return null;

  // 短文 or 質問入力には追い質問しすぎない
  if (isShortOrThin(t)) return pickOne(`qthin:${t}`, [
    'どんな相談？',
    '何について？',
    'いま一番ひっかかってるのはどこ？',
  ]);

  if (looksLikeQuestion(t)) {
    // ユーザーが質問している時は、こちらの質問を控えめに
    return null;
  }

  if (wantsClarity(t)) {
    return pickOne(`qclar:${t}`, [
      'いま「決めたいこと」は何？（一言でOK）',
      'いま決めたいのは、方向？条件？それとも期限？',
      'いま一番迷ってる点だけ、短く教えて。',
    ]);
  }

  if (hasInnerFriction(t)) {
    return pickOne(`qfric:${t}`, [
      '止まるのって、どの瞬間？（直前／最中／直後）',
      'ブレーキが入るのは、何をしようとした時？',
      'いちばん重くなる場面だけ教えて。',
    ]);
  }

  // 基本は質問しない（テンプレ質問地獄を避ける）
  return null;
}

function buildNextInvitation(t: string, args: BuildFlagReplyArgs): string | null {
  const seed = t;

  // ✅ “推量”を誘発しない。質問テンプレにも寄せない。
  // ✅ ユーザー発話に含まれる要素から「一点だけ」返させる足場を置く。
  // - 目的：HEDGE（〜かもしれない）を出させない
  // - 目的：GENERIC（汎用テンプレ）を避ける
  //
  // ここでの「次へ」は “行動指示” ではなく “観測の固定” にする。

  // すでに十分具体なら、短く返す
  if (seed.length >= 18 && /[。！？]/.test(seed)) {
    return pickOne(seed, [
      'いまの文の中で、いちばん引っかかってる語だけ残して。',
      'いま言った内容のうち「残る一語」だけ指定して。',
      'いまの言い方の中で、気になる部分を一つだけ切り出して。',
    ]);
  }

  // 短文・確認系（例：覚えてる？）は、具体化を“促す”のではなく“選ばせる”
  // ここで「具体的な出来事〜」のような誘導をすると generic/hedge を踏みやすい。
  if (seed.length < 18) {
    return pickOne(seed, [
      'いまの一文の中で、引っかかりはどの語？（一語だけ）',
      'その言い方のまま、引っかかる部分を一つだけ指して。',
      'いまの文で、残したいところを一つだけ選んで。',
    ]);
  }

  // デフォルト：観測一点
  return pickOne(seed, [
    'いま言った中で、引っかかりを一つだけ置いて。',
    'いまの文の中から、残る一点だけ抜き出して。',
    'そのまま、気になる箇所を一つだけ指定して。',
  ]);
}

/**
 * 旗印ブロックを「通常会話」に寄せて組む
 * - scaffoldは出力しない（テンプレ排除）
 * - 1〜4ブロック程度に抑える
 */
export function buildFlagReplySlots(args: BuildFlagReplyArgs): FlagReplySlot[] {
  const t = norm(args.userText);

  const slots: FlagReplySlot[] = [];

  // 1) まず会話として受ける（短い）
  pushOne(slots, 'CONCLUSION', 'neutral', buildConclusion(t, args));

  // 2) 必要な時だけ、短い見取り図（説明しない）
  const dyn = buildDynamics(t, args);
  if (dyn) pushOne(slots, 'DYNAMICS', 'neutral', dyn);

  // 3) 必要な時だけ、責めを外す（慰めで閉じない）
  const de = buildDeblame(t);
  if (de) pushOne(slots, 'DEBLAME', 'soft', de);

  // 4) 質問は0-1（最小）
  const q = buildQuestion(t, args);
  if (q) pushOne(slots, 'TRUE_QUESTION', 'neutral', q);

  // 5) 次へ（命令しない）
  const next = buildNextInvitation(t, args);
  if (next) pushOne(slots, 'NEXT_INVITATION', 'soft', next);

  return finalizeSlots(slots);
}
