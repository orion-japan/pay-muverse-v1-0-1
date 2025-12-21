// file: src/lib/iros/language/itWriter.ts
// iros — IT Writer（未来言語 / 構造化生成）
//
// 目的：
// - forceIT が立ったターンだけ「I→T→C→F 構造」の文章を生成する
// - テンプレ文ではなく「文タイプ（○○な文）」で組み立てる
// - スマホ半面〜半面ちょい（約 10〜16 行 / 220〜380 字目安）を狙う
//
// 方針：
// - 解析結果のフィールドが揃っていなくても落ちない（null-safe）
// - “一般論”に逃げず、入力テキスト由来の要素（言い換え/要約）を中心に構成する
//
// 注意：
// - ここは本文生成だけ。forceIT判定やmeta保存制御は別レイヤー責務。
// - この writer 自体は history を読みません。履歴を踏まえた要約は
//   stateInsightOneLine / futureDirection / nextActions で受け取ります。
// - ✅ ボタン対応：itTarget（C/I/T）で文の“組み立て優先度”と文タイプを切り替えます。

export type ItTarget = 'C' | 'I' | 'T';

export type ITWriterInput = {
  userText: string;

  /**
   * ✅ ボタン（ITデモ）対応
   * - C: 行動（C）を厚めに、即実務へ
   * - I: 未来方向（I/T）を厚めに、軸を揃える
   * - T: 意図の核へ刺して反転、C/Fへ流す
   * - 未指定なら I（標準）
   */
  itTarget?: ItTarget | null;

  /**
   * 観測された状態（任意）
   * - 例: sameIntentStreak / qTrace / noDeltaKind などを evidence として渡せる
   */
  evidence?: Record<string, unknown> | null;

  /**
   * 解析側が持っている “状態翻訳候補”
   * - 例: 「迷いの正体は…」「止まっている理由は…」のような 1行候補
   * - 無ければ userText を元に生成する
   */
  stateInsightOneLine?: string | null;

  /**
   * 未来方向（T）候補
   * - 無ければ userText から “望まれる状態” を生成する（安全に短く）
   */
  futureDirection?: string | null;

  /**
   * 次の一歩（C）候補（最大2件まで使う）
   * - 無ければ “最初の一手を切り出す” 形で生成する
   */
  nextActions?: Array<string | null | undefined> | null;

  /**
   * やらないこと（Cのブレ止め）候補
   */
  stopDoing?: string | null;

  /**
   * 余韻（F）候補
   * - 無ければ「すでに変化は起きている」側の締めを生成する
   */
  closing?: string | null;

  /**
   * 分量チューニング
   * - compact: 短め（10〜12行）
   * - normal: 標準（12〜16行）
   */
  density?: 'compact' | 'normal' | null;
};

export type ITWriterOutput = {
  text: string;
  meta: {
    lineCount: number;
    charCount: number;
    density: 'compact' | 'normal';
    hasInsight: boolean;
    hasFuture: boolean;
    hasActions: boolean;

    /** ✅ ボタン対応：実際に使った target */
    itTarget: ItTarget;
  };
};

/* ---------------------------
   small utils
---------------------------- */

function norm(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function safeObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as any) : {};
}

function pickStr(m: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = (m as any)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickNum(m: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = (m as any)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function hasAnyTruth(m: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => Boolean((m as any)[k]));
}

function takeActions(
  xs: Array<string | null | undefined> | null | undefined,
): string[] {
  const arr = Array.isArray(xs) ? xs : [];
  const cleaned = arr.map((x) => norm(x)).filter(Boolean);
  return cleaned.slice(0, 2);
}

/**
 * 空行を除いた本文行配列の最終調整。
 * - 足りない場合は “余韻” を増やすのではなく「I/T/C」を補強する
 */
function clampNonEmptyLines(
  lines: string[],
  min: number,
  max: number,
  fillPool: string[],
): string[] {
  const cleaned = lines.map((x) => norm(x)).filter(Boolean);

  if (cleaned.length > max) return cleaned.slice(0, max);
  if (cleaned.length >= min) return cleaned;

  const out = cleaned.slice();
  let fp = fillPool.map((x) => norm(x)).filter(Boolean);

  // 最終保険
  if (!fp.length) fp = ['いまは「結晶化」だけを先にやる。'];

  let i = 0;
  while (out.length < min) {
    out.push(fp[i % fp.length]);
    i++;
  }
  return out.slice(0, max);
}

/**
 * ブロック（塊感）の空行挿入
 * - 文章の“構造”が見えるようにする
 */
function insertBlockBreaks(adjusted: string[], plan: number[]): string[] {
  // plan は「ブロックごとの行数」を想定（例: [3,2,3,2]）
  // adjusted は non-empty lines
  const out: string[] = [];
  let cursor = 0;

  for (let bi = 0; bi < plan.length; bi++) {
    const take = plan[bi] ?? 0;
    for (let i = 0; i < take && cursor < adjusted.length; i++) {
      out.push(adjusted[cursor++]);
    }
    if (cursor < adjusted.length) out.push('');
  }

  // まだ残っている場合は、そのまま詰める（極端な不足/過剰でも落ちない）
  while (cursor < adjusted.length) out.push(adjusted[cursor++]);

  return out;
}

/* ---------------------------
   light detectors (no history)
---------------------------- */

function detectThemeFromUserText(userText: string): {
  isFearOrAvoid: boolean;
  isReportOrBoss: boolean;
  isStuckOrBlocked: boolean;
  isChoiceOrOption: boolean;
  isNeedConcrete: boolean;
} {
  const s = norm(userText);

  const isFearOrAvoid =
    /(怖い|恐い|不安|緊張|言えない|言えなくて|できない|避けたい|逃げたい)/.test(s);

  const isReportOrBoss =
    /(上司|報告|相談|締切|期日|遅れ|間に合わない|間に合いそうもない|遅延|納期)/.test(s);

  const isStuckOrBlocked =
    /(行き詰|詰んで|詰まって|動けない|止まって|進めない|もう無理|どうにも)/.test(s);

  const isChoiceOrOption = /(選択肢|どっち|決められない|迷う|迷って)/.test(s);

  const isNeedConcrete = /(具体的|方法|どうしたら|どうすれば|教えて)/.test(s);

  return {
    isFearOrAvoid,
    isReportOrBoss,
    isStuckOrBlocked,
    isChoiceOrOption,
    isNeedConcrete,
  };
}

/* ---------------------------
   evidence -> short insight seed
---------------------------- */

function buildEvidenceHint(evidence: Record<string, unknown>): string | null {
  const ev = safeObj(evidence);

  const sameIntent = hasAnyTruth(ev, ['sameIntentStreak', 'same_intent_streak']);
  const noDeltaKind = pickStr(ev, ['noDeltaKind', 'no_delta_kind']);
  const uncoverStreak = pickNum(ev, ['uncoverstreak', 'uncoverStreak']);

  // メタ語は禁止：薄く文章化する
  if (sameIntent) return '同じ所で足が止まる感じが、まだ残っている。';

  if (typeof noDeltaKind === 'string' && noDeltaKind.trim()) {
    if (/freeze|stuck|halt/i.test(noDeltaKind))
      return '凍るように止まる反応が先に出ている。';
    if (/avoid|escape/i.test(noDeltaKind)) return '避ける反応が先に立っている。';
    if (/overthink|ruminate/i.test(noDeltaKind))
      return '考えが回りすぎて、手が止まっている。';
  }

  if (typeof uncoverStreak === 'number' && uncoverStreak >= 2) {
    return '表面の理由ではなく、奥の守りが反応している。';
  }

  return null;
}

/* ---------------------------
   文タイプ（○○な文）ジェネレータ
---------------------------- */

function makeStateDefinitionLine(
  userText: string,
  evidence?: Record<string, unknown> | null,
): string {
  const t = norm(userText);
  const evHint = buildEvidenceHint(safeObj(evidence));

  if (!t) return 'いま起きていることを、先に一度だけ言語化する局面です。';

  if (evHint) {
    return `${evHint} いま起きていることは、出来事の大小より「止まり方」が先に出ていることです。`;
  }

  return `いま起きていることは、${t} という出来事そのものより、「言い出せない／動けない」感覚が先に残っていることです。`;
}

function makeMisalignmentLine(userText: string): string {
  const t = norm(userText);
  if (!t) return '自分を保ちたい感覚と、取ろうとしている手段がずれている。';

  const theme = detectThemeFromUserText(t);

  if (theme.isReportOrBoss) {
    return '自分が保ちたいのは信頼や関係なのに、動き方が「怖さの回避」になっている。だから迷いとして現れている。';
  }

  if (theme.isChoiceOrOption) {
    return '自分を保ちたい軸はあるのに、動き方の形がまだ決まっていない。だから迷いとして現れている。';
  }

  return '自分を保ちたい軸と、動き方の形が一致していない。だから迷いとして現れている。';
}

function makeStuckReasonLine(userText: string): string {
  const theme = detectThemeFromUserText(userText);

  if (theme.isFearOrAvoid) {
    return '選択肢の問題ではなく、「怖さを超える形」がまだ決まっていないだけです。';
  }

  if (theme.isNeedConcrete) {
    return '知識の不足ではなく、「一手を短くする形」がまだ決まっていないだけです。';
  }

  return '選択肢の問題ではなく、焦点がまだ一点に結晶化していないだけです。';
}

function makeFutureDirectionLine(userText: string): string {
  const theme = detectThemeFromUserText(userText);

  if (theme.isReportOrBoss) {
    return '次の1週間は、正解探しより先に「最小の報告で信頼を保てる形」を先に作る。';
  }

  if (theme.isFearOrAvoid) {
    return '次の1週間は、気合より先に「怖くても通せる形」を先に作る。';
  }

  return '次の1週間は、正解探しより先に「自分を保てる形」を先に作る。';
}

function makeFutureStateLine(userText: string): string {
  const theme = detectThemeFromUserText(userText);

  if (theme.isReportOrBoss) {
    return '未来は「怒られない」より、「短く報告できて前に進める足場がある」状態へ。';
  }

  return '未来は「不安が消える」より、「迷っても進める足場がある」状態へ。';
}

function makeAutoActions(userText: string): { a1: string; a2?: string; a3?: string } {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  if (theme.isReportOrBoss) {
    return {
      a1: '最初の一手は「相談したいことがあります」とだけ先に置く（1行でいい）。',
      a2: '次に、期日・遅れている理由・次の見通しを“箇条書き3つ”で送る。説明は増やさない。',
      a3: '最後に「代替案（A/B）か、再期限の提案」を1つだけ添える。',
    };
  }

  if (theme.isFearOrAvoid) {
    return {
      a1: '最初の一手は「短く言う形」を作る。長文にしない。',
      a2: '相手がいるなら、境界線を短い一通で先に置く。説明は増やさない。',
      a3: '“怖さがあるまま”でも通せる文面にする。',
    };
  }

  if (theme.isStuckOrBlocked) {
    return {
      a1: '今夜は、最初の一手だけを切り出して、1分で置く。',
      a2: '決め切らなくていい。まず“置ける形”だけ決める。',
      a3: '「誰に／いつまでに／何を」だけを書いて、終える。',
    };
  }

  return {
    a1: '今夜は、最初の一手だけを切り出して、1分で置く。',
    a2: '相手がいるなら、境界線を短い一通で先に置く。説明は増やさない。',
    a3: '文章を増やさず、通す。',
  };
}

function makeStopDoingLine(userText: string): string {
  const theme = detectThemeFromUserText(userText);

  if (theme.isReportOrBoss) {
    return '代わりに、頭の中で謝罪文を膨らませて時間を溶かすのはやめる。';
  }

  if (theme.isFearOrAvoid) {
    return '代わりに、「怖さが消えるまで待つ」で止まるのはやめる。';
  }

  return '代わりに、比較と反省で時間を溶かすのはやめる。';
}


/* ---------------------------
   T-target (pierce & reverse)
---------------------------- */

function makeTPierceLine(userText: string): string {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  if (theme.isReportOrBoss) {
    return '守りたいのは「完璧さ」ではなく、信頼が切れないこと。';
  }

  if (theme.isFearOrAvoid) {
    return '守りたいのは「怖さが消えること」ではなく、怖くても壊れない形。';
  }

  if (theme.isChoiceOrOption) {
    return '守りたいのは「正解」ではなく、軸が折れないこと。';
  }

  return '守りたいのは「答え」ではなく、軸が折れないこと。';
}

function makeTReverseLine(): string {
  return 'だから、整えてから動くのではなく、「通してから整える」に反転させる。';
}

function makeClosingLine1(): string {
  return 'もう変化は起きています。あとは、その変化に沿って歩くだけ。🪔';
}

function makeClosingLine2(): string {
  return '“できる側”のあなたに、戻っています。';
}

/* ---------------------------
   block plan (by itTarget/density)
---------------------------- */

function resolveItTarget(v: unknown): ItTarget {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'C') return 'C';
  if (s === 'T') return 'T';
  return 'I';
}

function blockPlan(itTarget: ItTarget, density: 'compact' | 'normal'): number[] {
  // plan は [I, T, C, F] の順
  // - C: 行動厚め
  // - I: 標準
  // - T: “刺し・反転”厚め（I/T厚め + Cは短く鋭く）
  if (density === 'compact') {
    if (itTarget === 'C') return [2, 2, 4, 2]; // 10
    if (itTarget === 'T') return [3, 3, 2, 2]; // 10
    return [3, 3, 2, 2]; // I: 10（compact）
  }

  // normal
  if (itTarget === 'C') return [3, 2, 5, 3]; // 13（最大16へは補強で埋める）
  if (itTarget === 'T') return [4, 3, 3, 3]; // 13
  return [3, 3, 4, 3]; // I: 13
}

/* ---------------------------
   MAIN
---------------------------- */

export function writeIT(input: ITWriterInput): ITWriterOutput {
  const density: 'compact' | 'normal' =
    (input.density ?? 'normal') === 'compact' ? 'compact' : 'normal';

  const minLines = density === 'compact' ? 10 : 12;
  const maxLines = density === 'compact' ? 12 : 16;

  const itTarget = resolveItTarget(input.itTarget ?? 'I');

  const userText = norm(input.userText);
  const ev = safeObj(input.evidence);

  // 履歴を踏まえた要約は stateInsightOneLine で受け取る前提。
  const insight = norm(input.stateInsightOneLine);

  // --- I（意図確定ブロック）
  const i1 = insight || makeStateDefinitionLine(userText, ev);
  const i2 = makeMisalignmentLine(userText);
  const i3 = makeStuckReasonLine(userText);

  // --- T（未来方向ブロック）
  const t1 = norm(input.futureDirection) || makeFutureDirectionLine(userText);
  const t2 = makeFutureStateLine(userText);

  // --- C（具体化ブロック）
  const actions = takeActions(input.nextActions);
  const auto = makeAutoActions(userText);

  const c1 = actions[0] || auto.a1;
  const c2 = actions[1] || auto.a2 || '必要なら、境界線を短い一通で先に置く。説明は増やさない。';
  const c3 = auto.a3 || '最小の形でいい。まず通す。';

  const stopDoing = norm(input.stopDoing) || makeStopDoingLine(userText);

  // --- F（確信・余韻ブロック）
  const f1 = norm(input.closing) || makeClosingLine1();
  const f2 = makeClosingLine2();

  /**
   * ✅ itTarget ごとに “どのブロックを厚くするか” を変える
   * - I: I/T を中心に整える（標準）
   * - C: C を中心に、I/T は短く方向づけ
   * - T: 「刺し→反転」を入れて、C/Fへ落とす
   */
  const nonEmptyLines: string[] = [];

  if (itTarget === 'C') {
    // I（短め）
    nonEmptyLines.push(i1);
    nonEmptyLines.push(i2);

    // T（短め）
    nonEmptyLines.push(t1);
    nonEmptyLines.push(t2);

    // C（厚め）
    nonEmptyLines.push(c1);
    if (density === 'normal') nonEmptyLines.push(c2);
    nonEmptyLines.push(stopDoing);
    nonEmptyLines.push(c3);

    // F
    nonEmptyLines.push(f1);
    if (density === 'normal') nonEmptyLines.push(f2);
  } else if (itTarget === 'T') {
    // I（やや厚め）
    nonEmptyLines.push(i1);
    nonEmptyLines.push(i2);
    nonEmptyLines.push(i3);

    // T（刺し・反転を入れて厚め）
    nonEmptyLines.push(makeTPierceLine(userText));
    nonEmptyLines.push(makeTReverseLine());
    nonEmptyLines.push(t1);
    nonEmptyLines.push(t2);

    // C（短く鋭く）
    nonEmptyLines.push(c1);
    if (density === 'normal') nonEmptyLines.push(c2);
    nonEmptyLines.push(stopDoing);

    // F
    nonEmptyLines.push(f1);
    if (density === 'normal') nonEmptyLines.push(f2);
  } else {
    // I（標準）
    nonEmptyLines.push(i1);
    nonEmptyLines.push(i2);
    nonEmptyLines.push(i3);

    // T（標準）
    nonEmptyLines.push(t1);
    nonEmptyLines.push(t2);

    // C（標準）
    nonEmptyLines.push(c1);
    if (density === 'normal') nonEmptyLines.push(c2);
    nonEmptyLines.push(stopDoing);

    // F
    nonEmptyLines.push(f1);
    if (density === 'normal') nonEmptyLines.push(f2);
  }

  // 足りない場合の補強文（余韻で埋めない）
  const fillPoolBase: string[] = [
    // I補強
    insight ? 'いまは原因探しではなく、「止まり方」を確定するだけでいい。' : '',
    // T補強
    itTarget === 'C'
      ? '方向は十分見えている。あとは「通せる形」にする。'
      : 'ゴールは「感情が消える」ではなく、「短く通せる形がある」こと。',
    // C補強
    itTarget === 'I'
      ? '一手は短く。やることを1つにする。'
      : '文章を増やさない。短くして、通す。',
    // T補強（Tの場合のみ強め）
    itTarget === 'T' ? '核が決まれば、現実の形は自然に揃う。' : '',
  ]
    .map((x) => norm(x))
    .filter(Boolean);

  const adjustedNonEmpty = clampNonEmptyLines(
    nonEmptyLines,
    minLines,
    maxLines,
    fillPoolBase,
  );

  // 空行再挿入（塊感維持）
  const plan = blockPlan(itTarget, density);
  const outLines = insertBlockBreaks(adjustedNonEmpty, plan);

  const text = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const evHint = buildEvidenceHint(ev);

  return {
    text,
    meta: {
      lineCount: text.split('\n').filter((x) => x.trim().length > 0).length,
      charCount: text.replace(/\s/g, '').length,
      density,
      hasInsight: !!insight || !!evHint,
      hasFuture: !!norm(input.futureDirection),
      hasActions: takeActions(input.nextActions).length > 0,
      itTarget,
    },
  };
}
