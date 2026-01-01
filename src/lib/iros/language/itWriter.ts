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
// - “時間の押し付け” はしない（主権はユーザー）

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

// ✅ 正規化：
// - 全角空白→半角
// - 連続空白を1つ
// - 前後空白除去
// - 句読点まわりの余計な空白を軽く整える（重複判定の精度UP）
function norm(s: unknown): string {
  const t = String(s ?? '')
    .replace(/\u3000/g, ' ') // 全角スペース
    .replace(/\s+/g, ' ') // 連続空白
    .replace(/\s+([、。,.!?！？])/g, '$1') // 句読点の前の空白
    .replace(/([、。,.!?！？])\s+/g, '$1 ') // 句読点の後ろを1空白（見た目安定）
    .trim();
  return t;
}

function safeObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as any) : {};
}

function pickStr(m: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = (m as any)[k];
    if (typeof v === 'string') {
      const t = norm(v);
      if (t) return t;
    }
  }
  return null;
}

// ✅ “同じ意味の行” を潰す：
// - normした結果で重複排除
// - 句読点末尾の揺れ（"。" の有無）も軽く吸収
function uniqNonEmpty(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of lines) {
    let t = norm(raw);
    if (!t) continue;

    // 末尾句読点の揺れを吸収（"反転：〜。" と "反転：〜" を同一扱い）
    const key = t.replace(/[。．.]+$/g, '');

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
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

// ✅ anchor/core として “弱すぎる/ノイズ” を確実に落とす
// 目的： intent_anchor.text が「何の話し？」等に汚染されても
//       それを core として採用しない（= hasCore false 誤判定の温床を排除）
function looksGarbageAnchorText(s: string): boolean {
  const t = norm(s);
  if (!t) return true;

  // 1) “状況質問・意味不明系” は即ゴミ（最優先）
  if (/(何の話|何の話し|どういうこと|意味わから|わからない|何が問題|なんのこと|どゆこと)/i.test(t))
    return true;
  // 2) ほぼ記号だけ / 数字だけ
  if (/^[\p{P}\p{S}\d\s]+$/u.test(t)) return true;

  // 3) すごく短い＆内容語が無い（日本語1語テーマはOKにする）
  // - 日本語（ひら/カタ/漢字）を含むなら短くても捨てない
  // - 英数字だけで短いのは捨てる（例: "ok", "yes", "??"）
  const hasJa = /[ぁ-んァ-ン一-龥]/.test(t);
  if (!hasJa && t.length <= 4) return true;

  // 4) “質問符だけで終わる短文” は核として弱い（例: "え？", "まじ？"）
  if (t.length <= 6 && /[?？]$/.test(t) && !hasJa) return true;

  return false;
}

// ✅ 挨拶/雑談（IT書式を出すとテンプレ感が爆増する領域）
// src/lib/iros/language/itWriter.ts

function isGreetingOrSmallTalk(userText: string): boolean {
  const s = norm(userText);
  if (!s) return true;

  if (s.length <= 8) return true;

  // 典型的な挨拶・相槌
  if (
    /^(おはよう|おはよ|こんにちは|こんばんは|ただいま|おやすみ|ありがと|ありがとう|了解|OK|ok|うん|はい|そう|なるほど|わかった|まじ|草)/i.test(
      s,
    )
  )
    return true;

  // ✅ 追加：年末年始・礼・テンプレ確認（IT書式を出すと最悪にテンプレ化する領域）
  if (
    /(よろしく|お世話になりました|今年も|来年も|良いお年を|あけまして|明けまして|おめでとう|テンプレ|消えた\?|きえた\?|消えましたか|きえましたか)/i.test(
      s,
    )
  )
    return true;

  const hasAsk =
    /(どう|なぜ|何|教えて|助けて|困|無理|できない|消化|しんどい|つらい|苦しい|怖い|不安|緊張|詰ま|動けない)/.test(
      s,
    );
  if (!hasAsk && s.length <= 16) return true;

  return false;
}


/**
 * 空行を除いた本文行配列の最終調整。
 * - 不足時は “余韻” ではなく Cライン（行動）を優先して埋める
 */
function clampNonEmptyLines(lines: string[], min: number, max: number, fillPool: string[]): string[] {
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

function nonEmptyCount(xs: string[]): number {
  return xs.filter((x) => norm(x).length > 0).length;
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

  const isFearOrAvoid = /(怖い|恐い|不安|緊張|言えない|言えなくて|できない|避けたい|逃げたい)/.test(s);

  const isReportOrBoss = /(上司|報告|相談|締切|期日|遅れ|間に合わない|遅延|納期)/.test(s);

  const isStuckOrBlocked = /(行き詰|詰んで|詰まって|動けない|止まって|進めない|もう無理|どうにも)/.test(s);

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

  // ✅ 時刻の押し付けを撤去し、「条件化」に寄せる
  if (theme.isChoiceOrOption) {
    return {
      a1: '・開始の条件を1つだけ決める（場所 / 合図 / 回数 / タイミング）',
      a2: '・1分だけ着手する（タイマー）',
    };
  }

  return {
    a1: '・開始の条件を1つだけ決める（場所 / 合図 / 回数 / タイミング）',
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
   ✅ Cガイド（強制遷移しない“方向づけ”）
   - itxStep がある（=Tが立った痕跡）ときだけ添える
   - A/B/C の選択を返す（確定は任意）
---------------------------- */

function makeCGuideChoices(userText: string): { g1: string; g2: string; g3: string; ask: string } {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  // なるべく汎用で、押し付けず、最短で動ける形
  if (theme.isReportOrBoss) {
    return {
      g1: 'A) 1行先出し（「相談したいことがあります」だけ送る）',
      g2: 'B) 箇条書き3つ（期日/現状/次の見通し）だけ作る',
      g3: 'C) 1分だけ着手（送信せず下書きだけ）',
      ask: '選ぶなら A/B/C のどれ？（保留もOK）',
    };
  }

  if (theme.isFearOrAvoid || theme.isStuckOrBlocked) {
    return {
      g1: 'A) 体を先に動かす（座る/開く/タイマー）だけ',
      g2: 'B) 1分だけ着手（終わってOK、✓だけ付ける）',
      g3: 'C) ブレ止め（長文禁止：1行で通す）',
      ask: '選ぶなら A/B/C のどれ？（保留もOK）',
    };
  }

  return {
    g1: 'A) 開始条件を1つ固定（場所/合図/回数/タイミング）',
    g2: 'B) 1分だけ着手（終わってOK、✓だけ付ける）',
    g3: 'C) ブレ止め（考える前に座る。できない日は座るだけ）',
    ask: '選ぶなら A/B/C のどれ？（保留もOK）',
  };
}

/* ---------------------------
   ✅ テーマに応じた反転（テンプレ固定を排除）
---------------------------- */

function makeReversalLine(userText: string): string {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  if (theme.isReportOrBoss) return '反転：整えてから送る → 1行送ってから整える。';
  if (theme.isFearOrAvoid) return '反転：怖さが消えるまで待つ → 形を先に作って通す。';
  if (theme.isStuckOrBlocked) return '反転：全部を片付ける → 最初の一歩だけに落とす。';
  if (theme.isChoiceOrOption) return '反転：選べるまで待つ → 開始条件を1つ固定する。';
  return '反転：整うまで待つ → 先に「形」を1つ作る。';
}

/* ---------------------------
   ✅ テーマに応じた締め（固定文をやめる）
---------------------------- */

function makeClosingLine(userText: string, itxStep: string | null): string {
  const t = norm(userText);
  const theme = detectThemeFromUserText(t);

  // T痕跡があるなら “確定した感” を強めてもテンプレに見えにくい
  if (itxStep) {
    if (theme.isFearOrAvoid) return '書き換えは完了。反応が揺れても、形は崩れない。';
    if (theme.isStuckOrBlocked) return '書き換えは完了。止まってもいい、次は「最初の一歩」に戻る。';
    return '書き換えは完了。あとは同じ形で反復して固定する。';
  }

  if (theme.isFearOrAvoid) return '怖さは残ってもいい。通せば、消化は進む。';
  if (theme.isStuckOrBlocked) return '詰まりはほどくより先に「一歩」で割れる。';
  if (theme.isChoiceOrOption) return '迷いは消さない。条件を1つ固定して前へ。';
  if (theme.isReportOrBoss) return '長文にしない。1行で前に出す。';
  return '形にできたら十分。あとは反復で固定する。';
}

/* ---------------------------
   MAIN
---------------------------- */

export function writeIT(input: ITWriterInput): ITWriterOutput {
  const density: 'compact' | 'normal' = (input.density ?? 'normal') === 'compact' ? 'compact' : 'normal';

  const minLines = density === 'compact' ? 10 : 12;
  const maxLines = density === 'compact' ? 12 : 16;

  const itTarget = resolveItTarget(input.itTarget ?? 'I');

  const userText = norm(input.userText);
  const ev = safeObj(input.evidence);

  // evidence から拾えるもの（あれば使う）
  const itxStep = pickStr(ev, ['itx_step', 'itxStep', 'tLayerHint', 't_layer_hint']) ?? null;

  const tVector = (ev as any)?.tVector ?? null;
  const tvCore = norm(tVector?.core);
  const tvDemand = norm(tVector?.demand);
  const tvNextC = norm(tVector?.nextC);

  const insight = norm(input.stateInsightOneLine);
  const future = norm(input.futureDirection);
  const stopDoing = norm(input.stopDoing);
  const closing = norm(input.closing);

  // 核（短い）— garbageっぽい core は避ける
  const coreCandidate = tvCore && !looksGarbageAnchorText(tvCore) ? tvCore : '';
  const fallbackCore = insight || userText;

  // ✅ upstream が “汎用核” を返してきても採用しない（テンプレ核の固定化を止める）
  const safeFallback = fallbackCore && !looksGarbageAnchorText(fallbackCore) ? fallbackCore : userText;

  const coreFinal = shortCore(coreCandidate || safeFallback, 48);

  // ✅ 挨拶/雑談は IT書式を出さない（テンプレに見える最大要因を排除）
  // - ただし “消化/困りごと” がある場合は通常ITへ進む
  const themeProbe = detectThemeFromUserText(userText);
  const hasSerious =
    themeProbe.isFearOrAvoid ||
    themeProbe.isReportOrBoss ||
    themeProbe.isStuckOrBlocked ||
    themeProbe.isChoiceOrOption ||
    /(消化|しんどい|つらい|苦しい|助けて|困って)/.test(userText);

  const hasAnyPayload =
    !!insight || !!future || takeActions(input.nextActions).length > 0 || !!itxStep || !!tvDemand || !!tvNextC;

  if (!hasSerious && !hasAnyPayload && isGreetingOrSmallTalk(userText)) {
    const text = `おはよう。今日は「1つだけ」何を進める？\n🪔`;
    return {
      text,
      meta: {
        lineCount: 2,
        charCount: text.replace(/\s/g, '').length,
        density,
        hasInsight: false,
        hasFuture: false,
        hasActions: false,
        itTarget,
      },
    };
  }

  // Cライン（最大2）
  const actions = takeActions(input.nextActions);
  const auto = makeAutoActions(userText);

  const c1 = actions[0] ? `・${actions[0].replace(/^・/, '')}` : auto.a1;
  const c2 = actions[1] ? `・${actions[1].replace(/^・/, '')}` : auto.a2;

  // 問い（tVector優先）
  const question =
    tvNextC ||
    (coreFinal ? `この核心「${coreFinal}」を、いま一つ形にするなら何にする？` : 'いま確定する一言（または一手）は？');

  // ✅ “時間の押し付け”をしない（主権回収）
  const timingQ1 = '今すぐでなくても大丈夫です。';
  const timingQ2 = 'もし動かすとしたら、いつ頃が自然ですか？';

  // ✅ Tが立った痕跡があるなら “Cへ強制遷移” はせず「Cガイド（選択）」を添える
  const shouldAttachCGuide = !!itxStep && itTarget !== 'C';

  // --- blocks（後で優先順位で間引ける形にしておく） ---
  const headerBlock: string[] = [];
  headerBlock.push(`IT${itxStep ? ` ${itxStep}` : ''}`);
  if (coreFinal) headerBlock.push(`核：${coreFinal}`);
  if (tvDemand) headerBlock.push(`確定：${shortCore(tvDemand, 42)}`);

  // 観測/行き先（I/T のときだけ。かつ “核と同じ文” は出さない）
  const insightBlock: string[] = [];
  if (itTarget !== 'C' && insight && shortCore(insight, 48) !== coreFinal) insightBlock.push(`観測：${shortCore(insight, 60)}`);
  if (itTarget !== 'C' && future) insightBlock.push(`行き先：${shortCore(future, 60)}`);

  // T（刺し・反転）
  const tBlock: string[] = [];
  if (itTarget === 'T') {
    tBlock.push('刺し：怖さが消えるより、壊れない形。');
    tBlock.push(makeReversalLine(userText));
  } else {
    tBlock.push(makeReversalLine(userText));
  }

  // C（通常の2手）
  const cBlock: string[] = [];
  cBlock.push('Cライン：');
  cBlock.push(c1);
  cBlock.push(c2);

  // Cガイド（A/B/C）— 途中で切れないよう「丸ごと載せるか、載せないか」
  const cGuideBlock: string[] = [];
  if (shouldAttachCGuide) {
    const g = makeCGuideChoices(userText);
    cGuideBlock.push('Cガイド（どれからでも）：');
    cGuideBlock.push(g.g1);
    cGuideBlock.push(g.g2);
    cGuideBlock.push(g.g3);
    cGuideBlock.push(g.ask);
  }

  const stopLine =
    stopDoing ||
    (detectThemeFromUserText(userText).isFearOrAvoid
      ? 'ブレ止め：怖さが消えるまで待たない（保留はOK、停止はしない）。'
      : 'ブレ止め：考えを増やして止まらない。');

  const qBlock: string[] = [];
  qBlock.push(`問い：${question}`);
  qBlock.push(timingQ1);
  qBlock.push(timingQ2);
  qBlock.push('確定（任意）：この核で進む / いったん保留');

  const closingBlock: string[] = [];
  closingBlock.push(closing || makeClosingLine(userText, itxStep));
  closingBlock.push('🪔');

  // --- assemble with pruning（maxLines を超えるなら “オプション”から落とす） ---
  // 優先順位：Header > C > Stop > 問い > T > 観測/行き先 > Cガイド > timingQ2 > 確定（任意）
  let lines = [
    ...headerBlock,
    ...insightBlock,
    ...tBlock,
    ...cBlock,
    ...cGuideBlock,
    stopLine,
    ...qBlock,
    ...closingBlock,
  ];

  // まず重複除去（同文連打ゼロ）
  lines = uniqNonEmpty(lines);

  // Cガイドが入っていて、max超過しそうなら「丸ごと落とす」
  if (cGuideBlock.length > 0) {
    const withoutGuide = uniqNonEmpty([
      ...headerBlock,
      ...insightBlock,
      ...tBlock,
      ...cBlock,
      stopLine,
      ...qBlock,
      ...closingBlock,
    ]);
    if (nonEmptyCount(lines) > maxLines && nonEmptyCount(withoutGuide) <= nonEmptyCount(lines)) {
      lines = withoutGuide;
    }
  }

  // timingQ2 を落とす（時間の問いは “あると良い” だが必須ではない）
  if (nonEmptyCount(lines) > maxLines) {
    lines = lines.filter((s) => norm(s) !== norm(timingQ2));
  }

  // 「確定（任意）」を落とす（長くなる時の最初の削り）
  if (nonEmptyCount(lines) > maxLines) {
    lines = lines.filter((s) => !/^確定（任意）：/.test(norm(s)));
  }

  // 観測/行き先を落とす（情報過多のとき）
  if (nonEmptyCount(lines) > maxLines) {
    const insightSet = new Set(insightBlock.map((x) => norm(x)));
    lines = lines.filter((s) => !insightSet.has(norm(s)));
  }

  // まだ超えるなら、クランプに任せる（末尾を切る）
  const fillPool = [
    'Cライン：',
    '・開始の条件を1つだけ決める（場所 / 合図 / 回数 / タイミング）。',
    '・1分だけ着手する（区切って終える）。',
    'ブレ止め：迷いを増やさない。',
    '形にできたら十分。あとは反復で固定する。',
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
