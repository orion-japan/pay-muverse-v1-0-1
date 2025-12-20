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

export type ITWriterInput = {
  userText: string;

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
   * 次の一手（C）候補（最大2件まで使う）
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
  };
};

/* ---------------------------
   small utils
---------------------------- */

function norm(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clampLines(lines: string[], min: number, max: number): string[] {
  const cleaned = lines.map((x) => norm(x)).filter(Boolean);
  if (cleaned.length <= max && cleaned.length >= min) return cleaned;

  if (cleaned.length > max) return cleaned.slice(0, max);

  // 足りない場合は、最後の余韻を増やすより「一手の明確化」を足す
  const out = cleaned.slice();
  while (out.length < min) out.push('いまは「整える」ではなく「通す」だけでいい。');
  return out.slice(0, max);
}

function takeActions(xs: Array<string | null | undefined> | null | undefined): string[] {
  const arr = Array.isArray(xs) ? xs : [];
  const cleaned = arr.map((x) => norm(x)).filter(Boolean);
  return cleaned.slice(0, 2);
}

/* ---------------------------
   文タイプ（○○な文）ジェネレータ
---------------------------- */

function makeStateDefinitionLine(userText: string): string {
  const t = norm(userText);
  if (!t) return 'いま起きていることを、先に一度だけ言語化する局面です。';
  // “原因分析”にせず「状態確定」へ寄せる
  return `いま起きていることは、${t} という出来事そのものより、“止まっている感覚”が残っていることです。`;
}

function makeMisalignmentLine(userText: string): string {
  const t = norm(userText);
  if (!t) return '守りたいものと、取ろうとしている手段がずれている。';
  // userText をそのまま繰り返さないために“ズレ”へ抽象化
  return '守りたいものと、動き方の形が一致していない。だから迷いとして現れている。';
}

function makeStuckReasonLine(): string {
  return '選択肢の問題ではなく、焦点がまだ一点に結晶化していないだけです。';
}

function makeFutureDirectionLine(): string {
  return '次の1週間は、正解探しより先に「守りたいものが守られる形」を先に作る。';
}

function makeFutureStateLine(): string {
  return '未来は「不安が消える」より、「迷っても進める足場がある」状態へ。';
}

function makeActionLine1(): string {
  return '今夜は、最初の一手だけを切り出して、1分で置く。';
}

function makeActionLine2(): string {
  return '相手がいるなら、境界線を短い一通で先に置く。説明は増やさない。';
}

function makeStopDoingLine(): string {
  return '代わりに、比較と反省で時間を溶かすのはやめる。';
}

function makeClosingLine1(): string {
  return 'もう変化は起きています。あとは、その変化に沿って歩くだけ。🪔';
}

function makeClosingLine2(): string {
  return '“できる側”のあなたに、戻っています。';
}

/* ---------------------------
   MAIN
---------------------------- */

export function writeIT(input: ITWriterInput): ITWriterOutput {
  const density: 'compact' | 'normal' = (input.density ?? 'normal') === 'compact' ? 'compact' : 'normal';
  const minLines = density === 'compact' ? 10 : 12;
  const maxLines = density === 'compact' ? 12 : 16;

  const userText = norm(input.userText);

  // --- I（意図確定ブロック：2〜3行）
  // 「○○な文 / ○○的な文」の役割で作る
  const insight = norm(input.stateInsightOneLine);
  const i1 = insight || makeStateDefinitionLine(userText); // 状態定義文
  const i2 = makeMisalignmentLine(userText); // ズレ言語化文
  const i3 = makeStuckReasonLine(); // 停滞理由を締める文

  // --- T（未来方向ブロック：2〜3行）
  const t1 = norm(input.futureDirection) || makeFutureDirectionLine(); // 方向提示文
  const t2 = makeFutureStateLine(); // 未来状態描写文

  // --- C（具体化ブロック：3〜5行）
  const actions = takeActions(input.nextActions);
  const c1 = actions[0] || makeActionLine1(); // 一手提示文
  const c2 = actions[1] || makeActionLine2(); // 補助行動文（任意）
  const stopDoing = norm(input.stopDoing) || makeStopDoingLine(); // やらないこと

  // --- F（確信・余韻ブロック：2〜3行）
  const f1 = norm(input.closing) || makeClosingLine1(); // すでに変わった側の文
  const f2 = makeClosingLine2(); // 余韻文

  // 文章組み立て（改行設計：2〜3行ごとに空行）
  const lines: string[] = [];

  // I
  lines.push(i1);
  lines.push(i2);
  lines.push(i3);
  lines.push(''); // 空行

  // T
  lines.push(t1);
  lines.push(t2);
  lines.push(''); // 空行

  // C
  lines.push(c1);
  // compact のときは c2 を省略しやすく
  if (density === 'normal') lines.push(c2);
  lines.push(stopDoing);
  lines.push(''); // 空行

  // F
  lines.push(f1);
  if (density === 'normal') lines.push(f2);

  // 行数調整（空行は count から除外したいが、表示は残す）
  const nonEmpty = lines.filter((x) => norm(x));
  const adjustedNonEmpty = clampLines(nonEmpty, minLines, maxLines);

  // 空行を再注入：I/T/C/F の塊感を維持
  // ※ 簡易：3-2-3-2 のブロックに近い位置で空行を入れる
  const out: string[] = [];
  for (let i = 0; i < adjustedNonEmpty.length; i++) {
    out.push(adjustedNonEmpty[i]);
    // ブロック境界（だいたい I(3) / T(2) / C(3) / F(2)）
    if (i === 2 || i === 4 || i === 7) out.push('');
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    text,
    meta: {
      lineCount: text.split('\n').filter((x) => x.trim().length > 0).length,
      charCount: text.replace(/\s/g, '').length,
      density,
      hasInsight: !!insight,
      hasFuture: !!norm(input.futureDirection),
      hasActions: actions.length > 0,
    },
  };
}
