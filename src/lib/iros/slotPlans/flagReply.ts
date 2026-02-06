// src/lib/iros/slotPlans/flagReply.ts
// iros — flag reply slot plan (GPT-like normal conversation / constitution-ready)
//
// 目的（新憲法）
// - writer は「自然文の生成」だけ（判断・診断・整理箱は禁止）
// - 内部の合図/材料は @TAG メタで渡す（露出しても事故らない）
// - ただし “最後の保険” として、ユーザーに出して成立する自然文 DRAFT を必ず1つ含める
//
// 方針
// - scaffold（PREFACE/PURPOSE/ONE_POINT/POINTS_3/NEXT_1）は型として残すが出力しない
// - 出力は 1〜2段落の短い会話文に寄せる
// - 質問は最大1つ（0でもOK）
// - A/B二択は禁止（「どっち？」の形にしない）

export type FlagCategory =
  // --- visible-ish (but still safe) ---
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

  // 直タスク（文面作成/要約など）なら true（“問い”を減らす）
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
    .map((s) => ({ ...s, content: clamp(s.content, 320) }))
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

// ----------------------------------------------------
// Meta packers（露出しても事故らない・読ませない）
// ----------------------------------------------------
function m(tag: string, payload: Record<string, unknown>) {
  let body = '';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ _err: 'stringify_failed' });
  }
  return `@${tag} ${body}`;
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
// Build parts (constitution-ready)
// - Visible output MUST remain conversational
// - Internal hints go into @TAG meta
// - Always include a natural DRAFT somewhere (final insurance)
// -----------------------------

function buildObsMeta(t: string, args: BuildFlagReplyArgs) {
  return m('OBS', {
    stamp: 'flagReply.ts@2026-02-06#constitution-v1',
    userText: clamp(t, 240),
    hasHistory: !!args.hasHistory,
    directTask: !!args.directTask,
    signals: {
      short: isShortOrThin(t),
      question: looksLikeQuestion(t),
      friction: hasInnerFriction(t),
      overload: overloadOrPanic(t),
      selfBlame: selfBlameOrCollapse(t),
      wantsClarity: wantsClarity(t),
    },
  });
}

function buildConstraintsMeta(args: BuildFlagReplyArgs) {
  return m('CONSTRAINTS', {
    avoid: ['boxes', 'steps', 'bullet_points', 'teacher_tone', 'meta_explaining', 'two_choice'],
    maxQuestions: args.questionAlreadyPlanned || args.directTask ? 0 : 1,
    maxParagraphs: 2,
    lengthGuide: 'short_conversation',
  });
}

// “最後の保険”：ユーザーに出して成立する自然文（ここは @TAG にしない）
function buildDraft(t: string, args: BuildFlagReplyArgs): string {
  const seed = `draft:${t}:${args.directTask ? 'task' : 'chat'}`;

  if (args.directTask) {
    return pickOne(seed, [
      'OK。いまの内容で、そのまま送れる文に整える。',
      '了解。用途に合わせて、外に出せる言い方に寄せよう。',
      'わかった。使える形にして返すね。',
    ]);
  }

  if (isShortOrThin(t)) {
    return pickOne(seed, [
      'うん、その一言で十分。',
      '了解。そこからでいける。',
      'OK。まずはその感触を起点にしよう。',
    ]);
  }

  if (overloadOrPanic(t)) {
    return pickOne(seed, [
      'いまは結論を作ろうとしなくていい。重さが先に出てる。',
      'その感じだと、整理より先に負荷を下げた方が早い。',
      '今は“正しく考える”より、まず固まりをゆるめよう。',
    ]);
  }

  if (wantsClarity(t)) {
    return pickOne(seed, [
      '決めたいのに決まらない、その一点がいまの中心だね。',
      '選択肢を増やすより、迷いの芯を小さくしたい。',
      'いまは答え探しより、迷いの核を拾う方が早い。',
    ]);
  }

  if (hasInnerFriction(t)) {
    return pickOne(seed, [
      '進もうとした瞬間にブレーキが入る、その感じが見えてる。',
      '動きたいのに止まる…その“止まり方”が鍵になってる。',
      '答えより先に、止まる地点を一つだけ見よう。',
    ]);
  }

  return pickOne(seed, [
    'うん、そこまで含めて今の話だね。',
    'なるほど。今の言い方の中に、もう大事な点が入ってる。',
    'OK。いま出てる感触をそのまま扱おう。',
  ]);
}

function buildDynamicsLine(t: string, args: BuildFlagReplyArgs): string | null {
  if (args.directTask) return null;

  const seed = `dyn:${t}:${args.hasHistory ? 'hist' : 'nohist'}`;

  if (hasInnerFriction(t)) {
    return pickOne(seed, [
      '「やりたい」と「止まる」が同時に出てる。',
      '前に進む直前で、重さが差し込んでくる感じ。',
      '気持ちは動いてるのに、手前で止める反応が出てる。',
    ]);
  }

  if (wantsClarity(t)) {
    return pickOne(seed, [
      '迷いが“情報不足”じゃなくて“軸の揺れ”っぽい。',
      '決め手がないというより、優先が揺れてる感じ。',
      '選べるのに決められない、そこに引っかかりがある。',
    ]);
  }

  return null;
}

function buildDeblameLine(t: string): string | null {
  const seed = `de:${t}`;

  if (selfBlameOrCollapse(t)) {
    return pickOne(seed, [
      'それを“自分の欠陥”にすると、話が進まなくなるやつだよ。',
      'いまは能力の判定にしない方がいい。起きてることを扱おう。',
      '自分を責める方向に寄せなくていい。まず状況の切り分けで大丈夫。',
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

function buildQuestionLine(t: string, args: BuildFlagReplyArgs): string | null {
  if (args.questionAlreadyPlanned) return null;
  if (args.directTask) return null;

  // ユーザーが質問してるなら、追い質問しない
  if (looksLikeQuestion(t)) return null;

  const seed = `q:${t}`;

  // 短文は “二択” にせず一点だけ
  if (isShortOrThin(t)) {
    return pickOne(seed, [
      'いま一番ひっかかってる語だけ、ひとつ教えて。',
      'いま残したいところを、一点だけ指して。',
      'どこが引っかかってる？一点だけでいい。',
    ]);
  }

  if (wantsClarity(t)) {
    return pickOne(seed, [
      'いま「決めたいこと」を一言だけ置いて。',
      'いま迷ってる点を一点だけ、短く教えて。',
      'いま動けない理由を一点だけ、言葉にすると何？',
    ]);
  }

  if (hasInnerFriction(t)) {
    return pickOne(seed, [
      'ブレーキが入るのって、どの瞬間？一点だけで。',
      '止まるのは、何をしようとした時？一点だけ。',
      'いちばん重くなる場面だけ、短く教えて。',
    ]);
  }

  return null;
}

function buildNextInvitationLine(t: string, args: BuildFlagReplyArgs): string | null {
  // 行動指示にしない／箱にしない／箇条書き誘導しない
  const seed = `next:${t}`;

  if (args.directTask) {
    return pickOne(seed, [
      '用途（誰に／どこで）だけ教えて。そこに合わせる。',
      '出したい先（相手 or 場面）だけ教えて。そこに寄せる。',
      'この文を使う場面だけ置いて。そこに合わせる。',
    ]);
  }

  if (t.length >= 18 && /[。！？]/.test(t)) {
    return pickOne(seed, [
      'いまの文の中で、残る一点だけ抜き出して。',
      'いま言った中で、いちばん引っかかる部分を一点だけ。',
      'その言い方のまま、残したいところを一点だけ。',
    ]);
  }

  return pickOne(seed, [
    'いまの一文の中で、引っかかりを一点だけ置いて。',
    'そのまま、残るところを一点だけ指して。',
    'いまの言い方で、残したいところを一点だけ選んで。',
  ]);
}

/**
 * flagReply slots（新憲法）
 * - 内部材料は @TAG で渡す
 * - ただし DRAFT は自然文で必ず1つ残す（空/削除事故を避ける）
 */
export function buildFlagReplySlots(args: BuildFlagReplyArgs): FlagReplySlot[] {
  const t = norm(args.userText);

  const slots: FlagReplySlot[] = [];

  // 0) 内部メタ（露出しても事故らない）
  pushOne(slots, 'PREFACE', 'neutral', buildObsMeta(t, args));
  pushOne(slots, 'PURPOSE', 'neutral', buildConstraintsMeta(args));

  // 1) 自然文の保険（必ず）
  pushOne(slots, 'CONCLUSION', 'neutral', buildDraft(t, args));

  // 2) 必要な時だけ短い補助（会話文として成立する短文）
  const dyn = buildDynamicsLine(t, args);
  if (dyn) pushOne(slots, 'DYNAMICS', 'neutral', dyn);

  const de = buildDeblameLine(t);
  if (de) pushOne(slots, 'DEBLAME', 'soft', de);

  // 3) 質問は最大1（0でもOK）
  const q = buildQuestionLine(t, args);
  if (q) pushOne(slots, 'TRUE_QUESTION', 'neutral', q);

  // 4) 次へ（命令しない）
  const next = buildNextInvitationLine(t, args);
  if (next) pushOne(slots, 'NEXT_INVITATION', 'soft', next);

  // scaffold（ONE_POINT/POINTS_3/NEXT_1）は出さない（型は残すがスロットを作らない）
  return finalizeSlots(slots);
}
