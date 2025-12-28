// file: src/lib/iros/language/itWriter.ts
// iros — IT Writer（未来言語 / 構造化生成）
//
// 目的：
// - forceIT が立ったターンだけ「I→T→C→F 構造」を “見える書式” で出す
// - 重複行（同じ一手の連打）をゼロにする
// - スマホ半面〜半面ちょい（約 10〜16 行 / 220〜380 字目安）を狙う
//
// 方針：
// - null-safe（値がなくても落ちない）
// - 解析メタ語（streak等）を本文に出さない
// - 原文の丸ごと再掲はしない（核は短く）

export type ItTarget = 'C' | 'I' | 'T';

export type ITWriterInput = {
  userText: string;
  itTarget?: ItTarget | null;
  evidence?: Record<string, unknown> | null;
  stateInsightOneLine?: string | null;
  futureDirection?: string | null;
  nextActions?: Array<string | null | undefined> | null;
  stopDoing?: string | null;
  closing?: string | null;
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

function uniqNonEmpty(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const s = norm(raw);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function takeActions(xs: Array<string | null | undefined> | null | undefined): string[] {
  const arr = Array.isArray(xs) ? xs : [];
  return uniqNonEmpty(arr.map((x) => norm(x))).slice(0, 2);
}

function shortCore(s: string, max = 48): string {
  const t = norm(s);
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 空行を除いた本文行配列の最終調整。
 * - 不足時は “余韻” ではなく Cライン（行動）を優先して埋める
 */
function clampNonEmptyLines(
  lines: string[],
  min: number,
  max: number,
  fillPool: string[],
): string[] {
  const cleaned = uniqNonEmpty(lines);

  if (cleaned.length > max) return cleaned.slice(0, max);
  if (cleaned.length >= min) return cleaned;

  const out = cleaned.slice();
  let fp = uniqNonEmpty(fillPool);

  if (!fp.length) fp = ['Cライン：', '・1分だけ着手する（タイマー）'];

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
function insertBlockBreaks(nonEmpty: string[], plan: number[]): string[] {
  const out: string[] = [];
  let cursor = 0;

  for (let bi = 0; bi < plan.length; bi++) {
    const take = plan[bi] ?? 0;
    for (let i = 0; i < take && cursor < nonEmpty.length; i++) {
      out.push(nonEmpty[cursor++]);
    }
    if (cursor < nonEmpty.length) out.push('');
  }
  while (cursor < nonEmpty.length) out.push(nonEmpty[cursor++]);
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
} {
  const s = norm(userText);

  const isFearOrAvoid =
    /(怖い|恐い|不安|緊張|言えない|言えなくて|できない|避けたい|逃げたい)/.test(s);

  const isReportOrBoss =
    /(上司|報告|相談|締切|期日|遅れ|間に合わない|遅延|納期)/.test(s);

  const isStuckOrBlocked =
    /(行き詰|詰んで|詰まって|動けない|止まって|進めない|もう無理|どうにも)/.test(s);

  const isChoiceOrOption = /(選択肢|どっち|決められない|迷う|迷って)/.test(s);

  return { isFearOrAvoid, isReportOrBoss, isStuckOrBlocked, isChoiceOrOption };
}

/* ---------------------------
   action generator (short)
---------------------------- */

function makeAutoActions(userText: string): { a1: string; a2: string } {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  if (theme.isReportOrBoss) {
    return {
      a1: '・「相談したいことがあります」とだけ先に送る（1行）',
      a2: '・期日／現状／次の見通しを “箇条書き3つ” にして送る',
    };
  }

  if (theme.isFearOrAvoid) {
    return {
      a1: '・長文にしない（短い一通で通す）',
      a2: '・最小の一歩を “1分だけ” で着手する（タイマー）',
    };
  }

  if (theme.isStuckOrBlocked) {
    return {
      a1: '・最初の一歩だけを書いて終える（誰に／いつ／何を）',
      a2: '・1分だけ着手する（タイマー）',
    };
  }

  if (theme.isChoiceOrOption) {
    return {
      a1: '・今日の開始時刻だけ決める（例：21:30）',
      a2: '・1分だけ着手する（タイマー）',
    };
  }

  return {
    a1: '・今日の開始時刻だけ決める（例：21:30）',
    a2: '・1分だけ着手する（タイマー）',
  };
}

function resolveItTarget(v: unknown): ItTarget {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'C') return 'C';
  if (s === 'T') return 'T';
  return 'I';
}

function blockPlan(itTarget: ItTarget, density: 'compact' | 'normal'): number[] {
  // [Header/I], [T], [C], [Q/F]
  if (density === 'compact') {
    if (itTarget === 'C') return [3, 2, 4, 2]; // 11
    if (itTarget === 'T') return [3, 3, 3, 2]; // 11
    return [3, 3, 3, 2]; // 11
  }
  // normal（10〜16非空行に着地させる）
  if (itTarget === 'C') return [4, 2, 6, 2]; // 14
  if (itTarget === 'T') return [4, 3, 5, 2]; // 14
  return [4, 3, 5, 2]; // 14
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

  // evidence から拾えるもの（あれば使う）
  const itxStep =
    pickStr(ev, ['itx_step', 'itxStep', 'tLayerHint', 't_layer_hint']) ?? null;

  const tVector = (ev as any)?.tVector ?? null;
  const tvCore = norm(tVector?.core);
  const tvDemand = norm(tVector?.demand);
  const tvNextC = norm(tVector?.nextC);

  const insight = norm(input.stateInsightOneLine);
  const future = norm(input.futureDirection);
  const stopDoing = norm(input.stopDoing);
  const closing = norm(input.closing);

  // 核（短い）
  const coreFinal = shortCore(tvCore || insight || userText, 48);

  // Cライン（最大2）
  const actions = takeActions(input.nextActions);
  const auto = makeAutoActions(userText);

  const c1 = actions[0] ? `・${actions[0].replace(/^・/, '')}` : auto.a1;
  const c2 = actions[1] ? `・${actions[1].replace(/^・/, '')}` : auto.a2;

  // 問い（tVector優先）
  const question =
    tvNextC ||
    (coreFinal
      ? `この核心「${coreFinal}」を、いま一つ形にするなら何にする？`
      : 'いま確定する一言（または一手）は？');

  // ✅ “時間の押し付け”をしない標準問い（あなたの案を採用）
  const timingQuestion =
    '今すぐでなくても大丈夫です。\nもし動かすとしたら、いつ頃が自然ですか？';

  // --- build non-empty lines (no duplicates) ---
  const lines: string[] = [];

  // Header / I
  lines.push(`IT${itxStep ? ` ${itxStep}` : ''}`);
  if (coreFinal) lines.push(`核：${coreFinal}`);
  if (tvDemand) lines.push(`確定：${shortCore(tvDemand, 42)}`);

  if (itTarget !== 'C' && insight && insight !== coreFinal)
    lines.push(`観測：${shortCore(insight, 60)}`);
  if (itTarget !== 'C' && future)
    lines.push(`行き先：${shortCore(future, 60)}`);

  // T（刺し・反転）
  if (itTarget === 'T') {
    lines.push('刺し：怖さが消えるより、壊れない形。');
    lines.push('反転：整えてから動く → 通してから整える。');
  } else {
    // うっすら入れる（テンションは上げない）
    lines.push('反転：迷いを終わらせて、反復に入る。');
  }

  // C
  lines.push('Cライン：');
  lines.push(c1);
  lines.push(c2);

  const stopLine =
    stopDoing ||
    (detectThemeFromUserText(userText).isFearOrAvoid
      ? 'ブレ止め：怖さが消えるまで待たない（保留はOK、停止はしない）。'
      : 'ブレ止め：考えを増やして止まらない。');
  lines.push(stopLine);

  // Q（確定を“要求”しない）
  lines.push(`問い：${question}`);

  // ✅ 時間の主権をユーザーに戻す
  lines.push(timingQuestion);

  // ✅ 確定は「ボタンを押す/押さない」をユーザーが選ぶ前提で“案内”だけ
  lines.push('確定（任意）：この核で進む / いったん保留');

  // closing（ユーザー思想：変化は完了）
  lines.push(closing || '書き換えは完了。あとは同じ形で反復する。');
  lines.push('🪔');

  // --- clamp (non-empty) ---
  // ✅ fillPool から「開始時刻(例:21:30)」など “押し付け時間” を撤去
  const fillPool = [
    'Cライン：',
    '・開始の条件を1つだけ決める（場所 / 合図 / 回数 / タイミング）。',
    '・1分だけ着手する（区切って終える）。',
    'ブレ止め：迷いを増やさない。',
    '書き換えは完了。反復で固定する。',
  ];

  const nonEmpty = clampNonEmptyLines(lines, minLines, maxLines, fillPool);
  const planned = insertBlockBreaks(nonEmpty, blockPlan(itTarget, density));
  const text = planned.join('\n').trim();

  return {
    text,
    meta: {
      lineCount: text.split('\n').filter((x) => x.trim().length > 0).length,
      charCount: text.replace(/\s/g, '').length,
      density,
      hasInsight: !!insight,
      hasFuture: !!future,
      hasActions: takeActions(input.nextActions).length > 0,
      itTarget,
    },
  };
}
