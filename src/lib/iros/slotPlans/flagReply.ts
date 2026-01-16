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

function shouldUseOnePointScaffold(t: string, args: BuildFlagReplyArgs) {
  // ✅ “仮置き一点セット”を出す条件（まずはシンプルに）
  // - 内的摩擦（進みたいのに止まる/引き返す）がある
  // - もしくは「薄い/進まない/同じ」等の停滞が露出している
  // ※ hasHistory は “確信” ではなく、背中押しの弱い補助としてのみ使う
  const stagnation = hasAny(t, /(薄い|進まない|変わらない|同じ|テンプレ|オウム返し|分からない|狙いが見えない)/);
  return hasInnerFriction(t) || stagnation || (!!args.hasHistory && wantsClarity(t));
}

function buildScaffoldPreface(): string {
  // ✅ 押し付け回避：確定ではなく“仮置き”宣言を先に置く
  // ※「受け取った」「呼吸」系は使わない
  return 'いまの足場として一つだけ置く。違ったら捨てていい。';
}

function buildScaffoldPurpose(): string {
  // ✅ 旗印の一文（あなた指定の“冒頭に足す一文”）
  return 'この文章は“答えを渡す”ためじゃなく、あなたが答えを出すための足場を置く。';
}

function buildOnePointLine(t: string): string {
  // ✅ “一点”は新しい解釈を足さず、今この会話で既に出ている素材の並べ替えだけで言う
  if (hasInnerFriction(t)) {
    // 既存の見取り図1行目を「一点」に昇格
    return '進みたい気持ちはあるのに、決めた瞬間に失うものが見えて、身体の方がブレーキを踏んでる感じがある。';
  }
  if (wantsClarity(t)) {
    return '決めたいのに決められないのは、情報が足りないというより、判断の軸が揺れて止まっている感じがある。';
  }
  return 'いま起きてるのは、結論の問題というより「動きが止まる一点」が残っている感じがある。';
}

function buildPoints3Lines(t: string): string[] {
  // ✅ “見るべき3点”＝助言ではなく、視点（観察点）だけを渡す
  if (hasInnerFriction(t)) {
    return ['失うものとして浮かんでいるもの（何を手放すのが怖いか）', '守ろうとしている境界（何を守りたい反応か）', '引き返す合図（いつ/どこでブレーキが入るか）'];
  }
  if (wantsClarity(t)) {
    return ['判断の軸（何を優先したいか）', '譲れない条件（最低限これがいる、の一点）', '怖いコスト（決めた瞬間に失う気がするもの）'];
  }
  return ['いま止めている一点（何が引っかかっているか）', 'その一点が出るタイミング（前/最中/後）', 'その一点を守る理由っぽいもの（失いたくない何か）'];
}

function buildPoints3Block(t: string): string {
  const lines = buildPoints3Lines(t);
  return `見る場所は3つだけ。\n・${lines[0]}\n・${lines[1]}\n・${lines[2]}`;
}

function buildNext1Line(t: string, args: BuildFlagReplyArgs): string {
  // ✅ “今できる一手”＝行動命令になりすぎない、軽い確認/言語化
  if (args.directTask) {
    return 'いま出来る一手は1つ：相手に「最初の一文」だけ書いてみて。そこから整える。';
  }
  if (hasInnerFriction(t)) {
    return 'いま出来る一手は1つ：失う側に見えているものを、名詞で1個だけ書いて終わりでいい。';
  }
  return 'いま出来る一手は1つ：引っかかっている一点を、短い言葉で1つだけ置いてみて。';
}

function decideCounts(t: string, args: BuildFlagReplyArgs): {
  conclusion: number;
  dynamics: number;
  deblame: number;
  invitation: number;
} {
  // ✅ “仮置き一点セット”が出るときは、CONCLUSIONを2本にする（宣言→軸）
  const useScaffold = shouldUseOnePointScaffold(t, args);

  const conclusion = useScaffold ? 2 : 1;

  const strong = hasInnerFriction(t) && wantsClarity(t); // ← 2本目を出す“強い条件”
  const dynamics = strong ? 2 : 1;

  const deblame =
    selfBlameOrCollapse(t) || overloadOrPanic(t) ? 2 :
    hasInnerFriction(t) ? 1 :
    1;

  // ✅ scaffold時は NEXT_INVITATION を2本にして「3点→一手」を必ず入れる
  const invitation = useScaffold ? 2 : args.directTask ? 2 : 1;

  return { conclusion, dynamics, deblame, invitation };
}


/**
 * 旗印ブロックを「可変」で組む
 * - 同カテゴリを複数回採用できる
 * - 順番は「軸→見取り図→矢印外し→問い(0–1)→余白」の基本を保ちつつ、各カテゴリ内は増やせる
 */
export function buildFlagReplySlots(args: BuildFlagReplyArgs): FlagReplySlot[] {
  const t = norm(args.userText);

  const useScaffold = shouldUseOnePointScaffold(t, args);

  const q = buildTrueQuestion(t, args);
  const counts = decideCounts(t, args);

  // --- 既存生成 ---
  let conclusionParts = buildConclusionParts(t).slice(0, Math.max(1, counts.conclusion));
  const dynamicsParts = buildDynamicsParts(t).slice(0, counts.dynamics);
  const deblameParts = buildDeblameParts(t).slice(0, counts.deblame);
  let invitationParts = buildNextInvitationParts(t, args).slice(0, counts.invitation);

  // --- ✅ ここが今回の追加：仮置き一点セット ---
  // カテゴリは増やせないので、既存カテゴリ内で「順番と中身」を固定する
  // CONCLUSION: 先頭2本（仮置き宣言 → 旗印一文）を差し込む（counts.conclusion=2のとき）
  // DYNAMICS: 先頭を“一点”に置き換える（見取り図の中で一点を立てる）
  // NEXT_INVITATION: 1本目を「見る3点」、2本目を「今できる一手」にする
  if (useScaffold) {
    conclusionParts = [buildScaffoldPreface(), buildScaffoldPurpose()];

    // “一点”はDYNAMICS_1に置く（既存の見取り図と役割が近い／露出も自然）
    const onePoint = buildOnePointLine(t);
    const dyn = [onePoint, ...dynamicsParts].slice(0, counts.dynamics);

    // invitationは「3点→一手」を固定（ここが“足場の順番”）
    invitationParts = [buildPoints3Block(t), buildNext1Line(t, args)];
    // dynamicsParts を上書きするため、以降で dyn を使う
    const slots: FlagReplySlot[] = [];

    // 1) CONCLUSION（仮置き→旗印）(2)
    conclusionParts.forEach((content, i) => {
      slots.push({
        key: keyOf('CONCLUSION', i + 1),
        kind: 'CONCLUSION',
        role: 'assistant',
        style: 'neutral',
        content,
      });
    });

    // 2) DYNAMICS（一点→必要なら補助見取り図）(1〜2)
    dyn.forEach((content, i) => {
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

    // 5) NEXT_INVITATION（3点→一手）(2固定)
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

  // --- 既存ルート（scaffoldなし） ---
  const slots: FlagReplySlot[] = [];

  // 1) CONCLUSION（軸）(1)
  conclusionParts.slice(0, counts.conclusion).forEach((content, i) => {
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
