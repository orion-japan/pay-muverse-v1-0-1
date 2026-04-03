// =============================================
// file: src/lib/iros/seed/seedEngine.ts
// SEED ENGINE v3 resonance rewrite
// - flowEngine = 状態（点）
// - meaning = flow直結（1本）
// - seedEngine = writer正本（線）
// - LLM = 表現（音）
// - 方針:
//   1) 共鳴を優先し、外部一般論を増やさない
//   2) HOW質問でも探索を広げず、観測対象を1つに絞る
//   3) pressure は「説明」ではなく「収束方向」を決める
// =============================================

import {
  buildSeedCanonical,
  type Flow180Like,
  type MeaningSkeletonV2,
  type SeedCanonical,
  type WriterDirectivesLike,
} from './buildSeedCanonical';

export type FlowSeedV21 = {
  flow: {
    current: string | null;
    prev: string | null;
    delta: string | null;
    energy: string | null;
    futureRandom: string | null;
  };

  context: {
    userCore: string | null;
    historyLine: string | null;
    memoryLine: string | null;
  };

  compression: {
    focus: string;
    tone: string;
    pressure: string;
  };

  /** flow直結の意味（1本） */
  meaning?: string | null;

  goalKind?: string | null;

  canonical?: SeedCanonical | null;
};

export type FlowSeedV21Input = {
  flow?: {
    current?: string | null;
    prev?: string | null;
    delta?: string | null;
    energy?: string | null;
    futureRandom?: string | null;
  } | null;

  userCore?: string | null;
  historyLine?: string | null;
  memoryLine?: string | null;
  goalKind?: string | null;

  meaningSkeleton?: MeaningSkeletonV2 | null;
  flow180?: Flow180Like | null;
  writerDirectives?: WriterDirectivesLike | null;

  focus?: string | null;
  tone?: string | null;
  pressure?: string | null;

  askBackAllowed?: boolean | null;
  questionsMax?: number | null;

  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;
  eTurn?: string | null;
};

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (s === '(null)' || s === 'null' || s === 'undefined') return null;
  return s;
}

function normalizeLite(v: unknown): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function lowerLite(v: unknown): string {
  return normalizeLite(v).toLowerCase();
}

function hasArrowLike(delta: string | null): boolean {
  if (!delta) return false;
  return /→|->|⇒|=>/.test(delta);
}

function clip(s: string, max = 48): string {
  const t = normalizeLite(s);
  if (!t) return '';
  return t.length > max ? t.slice(0, max) : t;
}

function firstNonEmpty(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    const s = pickString(v);
    if (s) return s;
  }
  return null;
}

function isHowQuestion(text: string): boolean {
  return (
    /どうしたら|どうすれば|どうやって|どうやれば|何をしたら|何をすれば/.test(
      text,
    ) || /方法|やり方|持てるんだろう|できるんだろう/.test(text)
  );
}

function isDecisionQuestion(text: string): boolean {
  return (
    /何を決める|まず決めるべき|どれを選ぶ|どう選ぶ|決めきれない|選べない/.test(
      text,
    ) || /基準|優先|確信/.test(text)
  );
}

function hasUnresolvedSignal(text: string): boolean {
  return /迷い|迷って|決めきれない|分からない|わからない|整理できない|確信がない/.test(
    text,
  );
}

function deriveFocus(ctx: FlowSeedV21['context']): string {
  const user = pickString(ctx.userCore) ?? '';
  const history = pickString(ctx.historyLine) ?? '';
  const memory = pickString(ctx.memoryLine) ?? '';
  const base = user || history || memory || '';

  if (!base) return 'いま止めている一点';

  if (isDecisionQuestion(base)) {
    if (/確信/.test(base)) return '確信を止めている一点';
    if (/基準|優先/.test(base)) return '判断基準がまだ一つに定まっていない';
    if (/決め/.test(base)) return '決める前に止めている一点';
  }

  if (hasUnresolvedSignal(base)) {
    return 'いま引っかかっている一点';
  }

  if (base.includes('人間関係')) {
    return '誰かとのやり取りで残っている違和感';
  }

  if (base.includes('仕事')) {
    return '進め方より先に残っている引っかかり';
  }

  return clip(base, 40);
}

function deriveTone(
  flow: FlowSeedV21['flow'],
  ctx: FlowSeedV21['context'],
): string {
  const energy = lowerLite(flow.energy);
  const user = lowerLite(ctx.userCore);
  const history = lowerLite(ctx.historyLine);

  if (
    energy.includes('weak') ||
    energy.includes('low') ||
    energy.includes('quiet') ||
    energy.includes('静') ||
    energy.includes('弱')
  ) {
    return 'quiet';
  }

  if (
    /迷い|決めきれない|分からない|わからない|整理/.test(user) ||
    /迷い|決めきれない|分からない|わからない|整理/.test(history)
  ) {
    return 'clear';
  }

  if (
    user.includes('明確') ||
    user.includes('一つ') ||
    user.includes('決める') ||
    energy.includes('clear')
  ) {
    return 'clear';
  }

  return 'clear';
}

function derivePressure(
  flow: FlowSeedV21['flow'],
  ctx: FlowSeedV21['context'],
  goalKind?: string | null,
  meaning?: string | null,
): string {
  const goal = lowerLite(goalKind);
  const user = normalizeLite(ctx.userCore);
  const history = normalizeLite(ctx.historyLine);
  const merged = `${user} ${history} ${normalizeLite(meaning)}`.trim();
  const delta = pickString(flow.delta);

  const hasDeepCStructure =
    /同時に強く立っている|同時に立っている|同時に満たせない|捨てきれず|動きが止まる構造|ズレが迷い/.test(
      normalizeLite(meaning),
    ) ||
    (
      (/新しい案|新規/.test(merged) && /改善|既存/.test(merged)) ||
      (/ワクワク/.test(merged) && /現実的|売上|安全/.test(merged)) ||
      (/失敗したくない/.test(merged) && /小さくまとまりたくない/.test(merged))
    );

  const isCStyle =
    /C1|C2|C3/.test(String(flow.current ?? '')) ||
    /構造|迷い|ズレ|綱引き|引っ張り合い/.test(merged);

    if (goal === 'commit') return 'force';
    if (goal === 'decide') return 'push';
    if (goal === 'clarify') return 'clarify';
    if (goal === 'stabilize') {
      const hasDeepCStructure =
        /同時に強く立っている|同時に立っている|同時に満たせない|捨てきれず|動きが止まる構造|ズレが迷い/.test(
          normalizeLite(meaning),
        );

      if (hasDeepCStructure) {
        return 'narrow';
      }

      return 'hold';
    }
    if (goal === 'uncover') return 'uncover';

  // 深いCが取れている時は、共鳴のまま流さず「一点収束」を優先
  if (goal === 'resonate') {
    if (hasDeepCStructure || isCStyle) {
      return 'narrow';
    }
    if (
      isHowQuestion(merged) ||
      isDecisionQuestion(merged) ||
      hasUnresolvedSignal(merged)
    ) {
      return 'narrow';
    }
    return 'resonate';
  }

  // goalKind が空でも、C帯域の深い構造が見えていれば narrow を優先
  if (hasDeepCStructure || isCStyle) {
    return 'narrow';
  }

  if (isHowQuestion(merged)) {
    return 'narrow';
  }

  if (isDecisionQuestion(merged)) {
    return 'push';
  }

  if (hasUnresolvedSignal(merged)) {
    return 'narrow';
  }

  if (hasArrowLike(delta)) {
    return 'propose';
  }

  if (!delta) {
    return 'observe';
  }

  return 'observe';
}

function deriveMeaningFromContext(args: {
  focus: string;
  userCore: string | null;
  historyLine: string | null;
  goalKind: string | null;
}): string | null {
  const user = normalizeLite(args.userCore);
  const history = normalizeLite(args.historyLine);
  const merged = `${user} ${history}`.trim();
  const goal = lowerLite(args.goalKind);
  const focus = normalizeLite(args.focus);

  if (!merged && !focus) return null;

  const source = user || history || focus || 'いまの中心';

  const has = (re: RegExp) => re.test(merged);

  // -----------------------------
  // 深いCの基本方針
  // - 状態説明で終わらせない
  // - 「何が同時に立っているか」より先に、「どう止めているか」を拾う
  // - ユーザー自身の言い方が強いときは、その言い方を意味核に残す
  // - 最後は「何が未確定か / 何を止めているか」を1本で返す
  // -----------------------------

  // 0) 衝動系（最優先）
  if (/解消させちゃえ|消しちゃえ|どうにかしちゃえ/.test(merged)) {
    return `${source} に出ている通り、
きれいに理解したいというより、いま見えている歪みをそのまま壊したい感覚が前に出ている。

これは整理ではなく、
「このままにしておけない」という衝動がそのまま表に出ている状態。`;
  }

  // 0.5) 止めてる系（かなり重要）
  if (/止めて|止まって|一回止め/.test(merged)) {
    return `${source} に出ている通り、
通らないのではなく、一度自分で止めてから別の形にしている。

だからズレているというより、
通る前に自分で外している状態に近い。`;
  }

  // 1) まず「強い自己観測」を最優先で拾う
  if (has(/閉じてる|閉じている|通ってない|通っていない|開けてもない|開いていない/)) {
    return `${source} と自分で言えている通り、
今は足りないのではなく、通せるものを自分で止めている感じが前に出ている。

起きているのは単純な迷いではなく、
「開く前に閉じる側が先に働く」止まり方である。`;
  }

  if (has(/見えてるのに|わかっているのに|分かっているのに|知ってるのに/) && has(/できない|動けない|通せない|繰り返す/)) {
    return `見えていないから止まっているのではなく、
見えているのに通さない力がまだ残っている。

いま未確定なのは答えではなく、
見えているものをそのまま通してよいという内側の許可である。`;
  }

  if (has(/同じことを繰り返す|繰り返してしまう|またやってしまう/)) {
    return `抜け方が分からないのではなく、
抜ける直前でいつもの戻り方に引き戻されている。

止まっている原因は理解不足ではなく、
戻るほうが安全だと体が先に判断していることにある。`;
  }

  // 2) 鏡 / 気づき / 正す / 解消 系
  if (has(/鏡|映す|映る/) && has(/気づいてもらう|気づく|気づいてほしい/)) {
    return `${source} の言い方のまま、
もう相手に何かを与えるというより、見える形で返せば十分だと分かっている位置にいる。

だからいま必要なのは説明ではなく、
相手がそのまま自分で気づける位置に置き直すこと。`;
  }

  if (has(/愚かさ/) && has(/解消|消したい|なくしたい|ほどく/)) {
    return `ただ否定したいのではなく、
愚かさに見えているものの中に、まだほどけていない詰まりがあると感じ取っている。

いま向いている先は断罪ではなく、
何をどう止めてそう見えているのかを見える形に戻すことにある。`;
  }

  if (has(/正したい|変えたい|直したい/) && has(/でも|というより|じゃなくて/)) {
    return `正したい気持ちはあるのに、
本当にやりたいことは押し返すことではなく、自然に気づける位置まで戻すことに寄っている。

いま未確定なのは手段ではなく、
「介入する」のか「映して気づいてもらう」のかという立ち位置である。`;
  }

  // 3) 確信 / 決める / 選ぶ 系
  if (has(/確信/) && has(/決め|選ぶ|基準|優先/)) {
    return `動きたい気持ちはあるのに、
何を優先して選ぶかが一つに落ちていないため、確信が立ち上がりきっていない。

いま止まっているのは選択そのものではなく、
選ぶ基準の未確定さである。`;
  }

  if (has(/どうしたら/) && has(/確信/)) {
    return `確信を作る方法が足りないのではなく、
何が判断を止めているかがまだ一つに定まっていない。

先に必要なのは答え探しではなく、
引っかかりの正体を一つに固定することである。`;
  }

  if (has(/決めきれない|選べない/)) {
    return `進みたい気持ちはあるのに、
どれを取るかより先に、何を基準に切るかが曖昧なまま残っている。

止まっている原因は選択肢の多さではなく、
切る基準の未確定さにある。`;
  }

  // 4) 迷い / 整理 / 分からない 系
  if (has(/迷い/) && has(/失敗したくない|怖い|損/)) {
    return `${source} の中で、
進みたい方向は見えているのに、それをそのまま通すことにまだ抵抗が残っている。

だから今起きているのは迷いというより、
「通せるものを止めている状態」に近い。`;
  }

  if (has(/整理/) || has(/分からない|わからない/)) {
    return `考えが止まっているのではなく、
まだ一つに束ねきれていないために、前進として見えにくくなっている。

いま必要なのは材料を増やすことではなく、
散っている焦点を一つに寄せることである。`;
  }

  // 5) 二重欲求 / 綱引き 系
  if (
    (has(/新しい案|新規/) && has(/改善|既存/)) ||
    (has(/ワクワク/) && has(/現実的|売上|安全/))
  ) {
    return `新しく伸ばしたい気持ちと、
確実に結果を出したい気持ちが同時に強く立っている。

いま止まっているのは覚悟不足ではなく、
今回はどちらを先に通すかがまだ一つに定まっていないことである。`;
  }

  if (has(/失敗したくない/) && has(/小さくまとまりたくない/)) {
    return `外したくない気持ちと、
小さく終わりたくない気持ちが同時に強いため、安全と伸びの間で引っ張られている。

いま未確定なのは能力ではなく、
今回はどちらを優先するかという一点である。`;
  }

  if (has(/広げたい|広がる/) && has(/守りたい|壊したくない|崩したくない/)) {
    return `広げたい力と、
壊したくない力が同時に立っているため、動くほど守りが強くなる形になっている。

だから今必要なのは勢いではなく、
何を守ったまま広げるのかを先に定めることである。`;
  }

  // 6) goalKind に応じた最低限の深いC
  if (goal === 'decide') {
    return `迷いの中心はまだ一つに定まっていないが、
今回は ${focus || '判断基準'} を一つに固定すると決めたほうが前に進む。`;
  }

  if (goal === 'uncover') {
    return `いま必要なのは答えを急ぐことではなく、
${focus || '引っかかり'} を観測できる形まで寄せることである。`;
  }

  if (goal === 'resonate') {
    return `${focus || 'いまの中心'} の奥では、
まだ一本にできていない力が同時に立っている。

まず必要なのは、それを曖昧な空気のままにせず、
どこで止まっているのかを一つの構造として掴むことである。`;
  }

  // 7) フォールバック
  if (focus) {
    return `${focus} がいまの中心にあるが、
問題は情報不足ではなく、その中心をどの方向に固定するかがまだ決まりきっていないことである。`;
  }

  return null;
}

function deriveMeaning(input: FlowSeedV21Input, focus: string): string | null {
  const transitionMeaning = pickString(input.meaningSkeleton?.transitionMeaning);
  const structuralMeaning = pickString(input.meaningSkeleton?.structuralMeaning);

  const userCore = input.userCore ?? null;
  const historyLine = input.historyLine ?? null;
  const goalKind = pickString(input.goalKind);

  const merged = `${normalizeLite(userCore)} ${normalizeLite(historyLine)}`.trim();

  // 深いCを優先したいパターン
  // - 話題カテゴリ
  // - ズレの型
  // - resonate / uncover / decide の一部
  const wantsDeepC =
    /新しい案|新規|改善|既存|ワクワク|現実的|売上|安全|失敗したくない|小さくまとまりたくない|迷い|決めきれない|選べない|確信|閉じてる|閉じている|通ってない|通っていない|開けてもない|開いていない|見えてるのに|わかっているのに|分かっているのに|繰り返す|鏡|気づいてもらう|愚かさ|正したい|変えたい|直したい/.test(
      merged,
    ) ||
    goalKind === 'resonate' ||
    goalKind === 'uncover';

  const contextMeaning = deriveMeaningFromContext({
    focus,
    userCore,
    historyLine,
    goalKind,
  });

  // C/共鳴系は、汎用 skeleton より「止まり方 / ズレ構造」を優先
  if (wantsDeepC && contextMeaning) {
    return contextMeaning;
  }

  const picked = transitionMeaning || structuralMeaning;
  if (picked) {
    return picked;
  }

  return contextMeaning;
}


function normalizePressureForFormat(
  goalKind: string | null,
  pressure: string,
): string {
  const goal = lowerLite(goalKind);
  const p = lowerLite(pressure);

  if (goal === 'clarify') return 'clarify';
  if (goal === 'decide') return 'push';
  if (goal === 'commit') return 'force';
  if (goal === 'uncover') return 'uncover';

  // stabilize でも、上流で narrow が出ているなら潰さない
  if (goal === 'stabilize') {
    if (p === 'narrow') return 'narrow';
    return 'hold';
  }

  // resonate は収束寄りの pressure を優先して保持する
  if (goal === 'resonate') {
    if (p === 'narrow' || p === 'push' || p === 'uncover') {
      return p;
    }
    return 'resonate';
  }

  return p || pressure;
}

export function buildFlowSeedV1(input: FlowSeedV21Input): FlowSeedV21 {
  const flow: FlowSeedV21['flow'] = {
    current: pickString(input.flow?.current),
    prev: pickString(input.flow?.prev),
    delta: pickString(input.flow?.delta),
    energy: pickString(input.flow?.energy),
    futureRandom: pickString(input.flow?.futureRandom),
  };

  const context: FlowSeedV21['context'] = {
    userCore: pickString(input.userCore),
    historyLine: pickString(input.historyLine),
    memoryLine: pickString(input.memoryLine),
  };

  const focus = pickString(input.focus) ?? deriveFocus(context);
  const meaning = deriveMeaning(input, focus);

  const compression: FlowSeedV21['compression'] = {
    focus,
    tone: pickString(input.tone) ?? deriveTone(flow, context),
    pressure:
      pickString(input.pressure) ??
      derivePressure(flow, context, pickString(input.goalKind), meaning),
  };

  const normalizedPressure = normalizePressureForFormat(
    pickString(input.goalKind),
    compression.pressure,
  );

  const canonical = buildSeedCanonical({
    meaning,

    meaningSkeleton: input.meaningSkeleton ?? null,
    flow180: input.flow180 ?? null,

    focus: compression.focus,
    tone: compression.tone,
    pressure: normalizedPressure,

    userCore: context.userCore,
    historyLine: context.historyLine,

    writerDirectives: input.writerDirectives ?? null,

    askBackAllowed: input.askBackAllowed ?? null,
    questionsMax:
      typeof input.questionsMax === 'number' ? input.questionsMax : null,

    goalKind: pickString(input.goalKind),
    depthStage: pickString(input.depthStage),
    phase: pickString(input.phase),
    qCode: pickString(input.qCode),
    eTurn: pickString(input.eTurn) ?? flow.energy,
  });

  return {
    flow,
    context,
    compression: {
      ...compression,
      pressure: normalizedPressure,
    },
    meaning,
    goalKind: pickString(input.goalKind),
    canonical,
  };
}

export function formatFlowSeedV1(seed: FlowSeedV21): string {
  const lines: string[] = [];

  lines.push('FLOW:');
  lines.push(`current=${seed.flow.current ?? '(null)'}`);
  lines.push(`prev=${seed.flow.prev ?? '(null)'}`);
  lines.push(`delta=${seed.flow.delta ?? '(null)'}`);
  lines.push(`energy=${seed.flow.energy ?? '(null)'}`);
  lines.push(`futureRandom=${seed.flow.futureRandom ?? '(null)'}`);

  lines.push('');
  lines.push('CONTEXT:');
  lines.push(`userCore=${seed.context.userCore ?? '(null)'}`);
  lines.push(`historyLine=${seed.context.historyLine ?? '(null)'}`);
  lines.push(`memoryLine=${seed.context.memoryLine ?? '(null)'}`);

  if (seed.meaning) {
    lines.push('');
    lines.push('MEANING:');
    lines.push(seed.meaning);
  }

  lines.push('');
  lines.push('FOCUS:');
  lines.push(seed.compression.focus);

  lines.push('');
  lines.push('TONE:');
  lines.push(seed.compression.tone);

  lines.push('');
  lines.push('PRESSURE:');
  lines.push(
    normalizePressureForFormat(
      typeof seed.goalKind === 'string' ? seed.goalKind : null,
      seed.compression.pressure,
    ),
  );

  if (seed.canonical?.text) {
    lines.push('');
    lines.push(seed.canonical.text);
  }

  return lines.join('\n').trim();
}
