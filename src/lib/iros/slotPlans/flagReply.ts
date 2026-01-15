// src/lib/iros/slotPlans/flagReply.ts
// iros — flag reply slot plan (concept blocks, adaptive, multi-block-per-category)
//
// 目的：
// - 「旗印」= 読み手が“自分で答えを出せる場所”に立つ文章を、ブロックで可変生成する
// - 5カテゴリ（CONCLUSION / DYNAMICS / DEBLAME / TRUE_QUESTION(0–1) / NEXT_INVITATION）を
//   会話に応じて「数・順・使い方」を変えて組む（固定テンプレ禁止）
//
// ✅ 変更点（今回）
// - 同カテゴリを複数回 push できるように、key を "FLAG_<CAT>_<N>" 形式に拡張
//   例: FLAG_DYNAMICS_1, FLAG_DYNAMICS_2 ...
//
// 注意：
// - ここは “意味・判断” を決めない。あくまで「話法の骨格」だけを置く。
// - 質問は最大1つ。不要なら0。
// - A/B二択は禁止。
// - 「受け取った/呼吸を戻す/一手に落とす」等の口癖テンプレは禁止。

export type FlagCategory =
  | 'CONCLUSION'
  | 'DYNAMICS'
  | 'DEBLAME'
  | 'TRUE_QUESTION'
  | 'NEXT_INVITATION';

export type FlagReplySlot = {
  // ✅ 同カテゴリ複数化のため key を拡張（安定・衝突回避）
  key: `FLAG_${FlagCategory}_${number}`;
  kind: FlagCategory;
  role: 'assistant';
  style: 'soft' | 'neutral';
  content: string;
};

type BuildFlagReplyArgs = {
  userText: string;

  // 直近の状況があれば（露出禁止の前提で）入れてOK
  // ※ここでは “ある/なし” をトリガーにする程度で、内容で断言しない
  hasHistory?: boolean;

  // 既に別スロットで質問を使う予定があるなら true（質問0に寄せる）
  questionAlreadyPlanned?: boolean;

  // 直タスク（文面作成/手順/要点）なら true（“問い”を減らしやすい）
  directTask?: boolean;
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

// --- ブロック採用の“ゆるい”判定（ここは増やしてOK） ---
function wantsClarity(t: string) {
  return hasAny(
    t,
    /(どれ|どっち|どう|どうしたら|どうすれば|何から|決められない|迷う|悩む|整理|要点|まとめ|結論)/,
  );
}

function hasInnerFriction(t: string) {
  return hasAny(t, /(やりたいのに|なのに|でも|一方で|止まる|進まない|怖い|モヤ|引っかか)/);
}

function selfBlameOrCollapse(t: string) {
  return hasAny(t, /(自分が悪い|自分のせい|ダメだ|向いてない|才能がない|もう無理|終わり)/);
}

function overloadOrPanic(t: string) {
  return hasAny(t, /(パンク|無理|限界|しんどい|つらい|疲れた|もうやだ|息が)/);
}

// --- 各カテゴリの本文生成（1本返し/複数返し） ---
function buildConclusionParts(t: string): string[] {
  // 「答え」ではなく「軸」。断言で押し切らない。
  // 必要なら2本まで（軸→補助軸）に増やせるが、基本は1本でよい。
  if (wantsClarity(t)) return ['いま必要なのは、情報を増やすことより「焦点を1つに戻すこと」だと思う。'];
  if (hasInnerFriction(t)) return ['いま起きてるのは、結論の問題というより「動きが止まる構造」だと思う。'];
  if (overloadOrPanic(t)) return ['いまは正しさより、まず「戻れる場所」を作るのが先だと思う。'];
  return ['いまの話は、答えを急ぐより「どこがズレているか」を見つけると進みやすい。'];
}

function buildDynamicsParts(t: string): string[] {
  // “状態説明”ではなく “見取り図”
  // ※診断メタ（phase/depth/q）は出さない
  const out: string[] = [];

  if (hasInnerFriction(t)) {
    out.push(
      '進みたい気持ちはあるのに、決めた瞬間に失うものが見えて、身体の方がブレーキを踏んでる感じがある。',
    );
    // 追加の見取り図（同カテゴリ2本目）
    out.push('だから「考えが足りない」ではなく、同じ地点で引き返す“仕組み”が働いてる。');
    return out;
  }

  if (wantsClarity(t)) {
    out.push('材料が多いというより、判断の軸が揺れていて、どれを拾っても決め手にならない状態に見える。');
    out.push('軸が揺れると、どの情報も“正しさ”に見えてしまって、逆に止まりやすい。');
    return out;
  }

  out.push('表の話題の奥で、同じところを何度も通ってしまう“回り道”が起きてる感じがある。');
  return out;
}

function buildDeblameParts(t: string): string[] {
  // 慰めで閉じない。「責めの矢印」を外すだけ。
  const out: string[] = [];

  if (selfBlameOrCollapse(t)) {
    out.push('ここを「自分の欠陥」にすると動けなくなる。いまは能力の話じゃなくて、守ろうとしてるものの話に近い。');
    // 2本目（必要なときだけ）
    out.push('責めを強めるほど、選択は細くなる。まず矢印を外していい。');
    return out;
  }

  if (overloadOrPanic(t)) {
    out.push('いまの重さは、弱さの証明じゃない。情報量か責任の密度が、手元の容量を超えてるだけ。');
    out.push('容量を超えた状態で“正解”を探すと、余計に固まる。ここは順番の問題でもある。');
    return out;
  }

  if (hasInnerFriction(t)) {
    out.push('ここは“正しさ”で自分を締めるほど、選択が細くなる。まず矢印を外していい。');
    // 2本目（摩擦がある時は入れても良い）
    out.push('止まってるのは、弱さじゃなくて、境界を守ろうとしてる反応かもしれない。');
    return out;
  }

  out.push('ここは“正しさ”で自分を締めるほど、選択が細くなる。まず矢印を外していい。');
  return out;
}

function buildTrueQuestion(t: string, args: BuildFlagReplyArgs): string | null {
  // 質問は最大1つ。不要なら0。
  if (args.questionAlreadyPlanned) return null;

  const allow = wantsClarity(t) || hasInnerFriction(t);
  if (!allow) return null;

  if (args.directTask) {
    // 直タスク時は “選ばせない” 問い（短く、答えやすく）
    return 'この件で、いま一番「戻したい一点」はどれ？';
  }

  // 通常時：場面を切る（recall-checkの @Q ではなく、人間文）
  return 'どの場面を指してる？（辞めたい理由／次の職場像／人間関係／条件など）';
}

function buildNextInvitationParts(t: string, args: BuildFlagReplyArgs): string[] {
  // “行動命令”にしない。主権を残して次へ。
  const out: string[] = [];

  if (args.directTask) {
    out.push('必要なら、いま言える範囲だけで“送れる文面”に整えて出せる。最後はあなたの言い方に合わせて丸めよう。');
    // 2本目（直タスクの時だけ薄く追加してOK）
    out.push('いまは完成を急がなくていい。まず一回、外に出せる形にしてから整える方が早い。');
    return out;
  }

  if (args.hasHistory) {
    out.push('焦点が決まれば、そこから自然に次の一手は見えてくる。まずは一点だけでいい。');
    return out;
  }

  out.push('焦点が決まったら、その一点だけを短く扱って、次に進める。');
  return out;
}

function decideCounts(t: string, args: BuildFlagReplyArgs): {
  conclusion: number;
  dynamics: number;
  deblame: number;
  invitation: number;
} {
  const conclusion = 1;

  const strong = hasInnerFriction(t) && wantsClarity(t); // ← 2本目を出す“強い条件”
  const dynamics = strong ? 2 : 1;

  const deblame =
    selfBlameOrCollapse(t) || overloadOrPanic(t) ? 2 :
    hasInnerFriction(t) ? 1 :
    1;

  const invitation = args.directTask ? 2 : 1;

  return { conclusion, dynamics, deblame, invitation };
}


/**
 * 旗印ブロックを「可変」で組む
 * - 同カテゴリを複数回採用できる
 * - 順番は「軸→見取り図→矢印外し→問い(0–1)→余白」の基本を保ちつつ、各カテゴリ内は増やせる
 */
export function buildFlagReplySlots(args: BuildFlagReplyArgs): FlagReplySlot[] {
  const t = norm(args.userText);

  const q = buildTrueQuestion(t, args);
  const counts = decideCounts(t, args);

  const conclusionParts = buildConclusionParts(t).slice(0, counts.conclusion);
  const dynamicsParts = buildDynamicsParts(t).slice(0, counts.dynamics);
  const deblameParts = buildDeblameParts(t).slice(0, counts.deblame);
  const invitationParts = buildNextInvitationParts(t, args).slice(0, counts.invitation);

  const slots: FlagReplySlot[] = [];

  // 1) CONCLUSION（軸）(1)
  conclusionParts.forEach((content, i) => {
    slots.push({
      key: keyOf('CONCLUSION', i + 1),
      kind: 'CONCLUSION',
      role: 'assistant',
      style: 'neutral',
      content,
    });
  });

  // 2) DYNAMICS（見取り図）(1〜2)
  dynamicsParts.forEach((content, i) => {
    slots.push({
      key: keyOf('DYNAMICS', i + 1),
      kind: 'DYNAMICS',
      role: 'assistant',
      style: 'neutral',
      content,
    });
  });

  // 3) DEBLAME（矢印を外す）(1〜2)
  deblameParts.forEach((content, i) => {
    slots.push({
      key: keyOf('DEBLAME', i + 1),
      kind: 'DEBLAME',
      role: 'assistant',
      style: 'soft',
      content,
    });
  });

  // 4) TRUE_QUESTION（0–1）
  if (q) {
    slots.push({
      key: keyOf('TRUE_QUESTION', 1),
      kind: 'TRUE_QUESTION',
      role: 'assistant',
      style: 'neutral',
      content: q,
    });
  }

  // 5) NEXT_INVITATION（余白で次へ）(1〜2)
  invitationParts.forEach((content, i) => {
    slots.push({
      key: keyOf('NEXT_INVITATION', i + 1),
      kind: 'NEXT_INVITATION',
      role: 'assistant',
      style: 'soft',
      content,
    });
  });

  // 最終セーフ：空が混ざらないように / 1ブロックの暴走を抑える
  return slots
    .map((s) => ({ ...s, content: clamp(s.content, 220) }))
    .filter((s) => !!norm(s.content));
}
