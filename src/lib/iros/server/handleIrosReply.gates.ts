// src/lib/iros/quality/flagshipGuard.ts
// iros — Flagship Quality Guard
//
// 目的：
// - 旗印「読み手が“自分で答えを出せる場所”」から外れる“汎用応援文”を落とす
// - ただし「文字列っぽい判定」より、slot/構造（must-haveの保全）で落とせるようにする
//
// 返すもの：
// { ok, level, score, reasons, qCount, bulletLike, shouldRaiseFlag }
// - ok=false なら rephraseEngine が reject する想定
//
// 注意：ここは“安全・汎用”ではなく “旗印” のための品質ゲート。

export type FlagshipVerdict = {
  ok: boolean;
  level: 'OK' | 'WARN' | 'FATAL';
  qCount: number;
  score: {
    fatal: number;
    warn: number;
    qCount: number;
    bulletLike: number;
    hedge: number;
    cheer: number;
    generic: number;
  };
  reasons: string[];

  // ✅ WARNでも“停滞/体験崩れ”なら、上位で介入させるためのフラグ
  shouldRaiseFlag: boolean;
};

type GuardSlot = { key?: string; text?: string; content?: string; value?: string };

export type FlagshipGuardContext = {
  // ✅ slotKeys（inKeys）
  slotKeys?: string[] | null;

  // ✅ extracted.slots 等（ONE_POINT/PURPOSE/POINTS_3 の素材を拾う）
  slotsForGuard?: GuardSlot[] | null;
};

function norm(s: unknown) {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normLite(s: unknown) {
  return norm(s).toLowerCase();
}

function countMatches(text: string, patterns: RegExp[]) {
  let c = 0;
  for (const p of patterns) {
    // /g が無い場合もあるので、安全に global 化して match
    const re = p.global ? p : new RegExp(p.source, p.flags + 'g');
    const m = text.match(re);
    if (m) c += m.length;
  }
  return c;
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((p) => p.test(text));
}

function toSlotText(s: GuardSlot | null | undefined): string {
  if (!s) return '';
  return String(s.text ?? s.content ?? s.value ?? '').trim();
}

// ✅ “構造 must-have” を needle に落とす（完全一致要求はしない）
// - 文章が整形されても残りやすい “短い核” を取る
// - 長すぎると揺れるので 10〜22 文字程度に丸める
function makeNeedle(raw: string, opts?: { min?: number; max?: number }): string | null {
  const min = Math.max(6, Number(opts?.min ?? 10));
  const max = Math.min(40, Math.max(min, Number(opts?.max ?? 18)));

  const t = norm(raw)
    // 句読点や引用符の揺れを吸収
    .replace(/[「」『』【】\[\]（）\(\)"'’‘]/g, '')
    .replace(/[、,。\.]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!t) return null;
  if (t.length < min) return null;

  return t.slice(0, Math.min(max, t.length));
}

function includesNeedle(out: string, needle: string | null): boolean {
  if (!needle) return false;
  const o = normLite(out);
  const n = normLite(needle);
  if (!o || !n) return false;
  return o.includes(n);
}

function keyHas(k: string, word: string) {
  return String(k ?? '').toUpperCase().includes(word.toUpperCase());
}

// ✅ slots から must-have（purpose / one-point / points3）を抽出
function extractScaffoldMustHave(ctx?: FlagshipGuardContext | null): {
  scaffoldLike: boolean;
  purposeNeedle: string | null;
  onePointNeedle: string | null;
  points3Needles: string[];
} {
  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map((x) => String(x)) : [];
  const slots = Array.isArray(ctx?.slotsForGuard) ? (ctx!.slotsForGuard as GuardSlot[]) : [];

  // scaffoldLike:
  // - ONE_POINT pack / flagReply（FLAG_*）/ must-have guard が動く系の keys を検知したら “構造維持が必要” とみなす
  const scaffoldLike =
    slotKeys.some((k) => keyHas(k, 'ONE_POINT')) ||
    slotKeys.some((k) => keyHas(k, 'POINTS_3')) ||
    slotKeys.some((k) => keyHas(k, 'PURPOSE')) ||
    (slotKeys.length > 0 && slotKeys.every((k) => String(k).startsWith('FLAG_')));

  let purposeNeedle: string | null = null;
  let onePointNeedle: string | null = null;
  const points3Needles: string[] = [];

  for (const s of slots) {
    const k = String(s?.key ?? '').toUpperCase();
    const txt = toSlotText(s);
    if (!txt) continue;

    if (!purposeNeedle && (k.includes('PURPOSE') || k.includes('FLAG_PURPOSE'))) {
      purposeNeedle = makeNeedle(txt, { min: 10, max: 20 });
      continue;
    }

    if (!onePointNeedle && (k.includes('ONE_POINT') || k.includes('FLAG_ONE_POINT'))) {
      onePointNeedle = makeNeedle(txt, { min: 10, max: 22 });
      continue;
    }

    if (k.includes('POINTS_3') || k.includes('FLAG_POINTS_3')) {
      // points3 は “3点の箇条” が元なので、行ごとに needle を作る
      const lines = norm(txt)
        .split('\n')
        .map((x) => x.replace(/^\s*[-*•]\s+/, '').trim())
        .filter(Boolean);

      for (const line of lines) {
        const nd = makeNeedle(line, { min: 8, max: 20 });
        if (nd && points3Needles.length < 3) points3Needles.push(nd);
      }
    }
  }

  return { scaffoldLike, purposeNeedle, onePointNeedle, points3Needles };
}

// ✅ 「?」だけでなく、?なし疑問文も qCount に入れる
// - 旗印上「質問逃げ」を拾うのが目的（厳密な日本語解析はしない）
// - “1行=1疑問” くらいの粗さで十分（ループを止めるため）
function countQuestionLike(text: string): number {
  const t = norm(text);

  // 1) 記号は従来どおり
  const markCount = (t.match(/[？?]/g) ?? []).length;

  // 2) ?なし疑問文（日本語）を検出して加算
  // - 「ですか/ますか/でしょうか/かな/か/の」など
  // - WH語（どう/なぜ/何/どこ/いつ/どれ/どんな/誰）
  // - 「教えて/聞かせて/話して」系（質問逃げになりやすい）
  const lines = t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let likeCount = 0;

  for (const line of lines) {
    const s = line;

    const hasWh =
      /(どう(すれば|したら)?|なぜ|なんで|何(が|を|の)?|どこ|いつ|どれ|どんな|誰|誰が|誰に)/.test(s);

    const endsLikeQuestion = /(ですか|ますか|でしょうか|かな|か\W*$|の\W*$)/.test(s);

    const askLike =
      /(教えて|教えてください|聞かせて|聞かせてください|話して|話してみて|詳しく)/.test(s);

    if (hasWh || endsLikeQuestion || askLike) likeCount += 1;
  }

  return markCount + likeCount;
}

export function flagshipGuard(input: string, ctx?: FlagshipGuardContext | null): FlagshipVerdict {
  const t = norm(input);

  const reasons: string[] = [];
  const qCount = countQuestionLike(t);

  // 箇条書きっぽさ（旗印というより“助言テンプレ”になりがち）
  const bulletLike = /(^|\n)\s*[-*•]\s+/.test(t) || /(^|\n)\s*\d+\.\s+/.test(t) ? 1 : 0;

  // ---------------------------------------------
  // ✅ 構造（must-have）ベース判定
  // ---------------------------------------------
  const mh = extractScaffoldMustHave(ctx);
  const hasPurpose = includesNeedle(t, mh.purposeNeedle);
  const hasOnePoint = includesNeedle(t, mh.onePointNeedle);
  const hasPoints3 =
    mh.points3Needles.length === 0 ? true : mh.points3Needles.every((nd) => includesNeedle(t, nd));

  // scaffoldLike なのに must-have が欠けたら「汎用化/薄逃げ」として落とす
  // ※ これが “文字判断じゃなく構造で修復” の中核
  if (mh.scaffoldLike) {
    if (mh.purposeNeedle && !hasPurpose) reasons.push('SCAFFOLD_PURPOSE_MISSING');
    if (mh.onePointNeedle && !hasOnePoint) reasons.push('SCAFFOLD_ONE_POINT_MISSING');
    if (mh.points3Needles.length > 0 && !hasPoints3) reasons.push('SCAFFOLD_POINTS3_NOT_PRESERVED');
  }

  // ---------------------------------------------
  // 補助：文字列判定（最後の手段）
  // - 構造判定が弱い/slotsが無い時の保険
  // ---------------------------------------------
  const CHEER = [
    /ワクワク/g,
    /素晴らしい/g,
    /いいですね/g,
    /応援/g,
    /大丈夫/g,
    /少しずつ/g,
    /焦らなくていい/g,
    /前向き/g,
    /きっと/g,
    /新しい発見/g,
    /一歩/g,
    /進展/g,
    /大きな一歩/g,
    /積み重ね/g,
    /無理しない/g,
    /安心して/g,
  ];

  const HEDGE = [
    /かもしれません/g,
    /かもしれない/g,
    /(?:見えて|分かって)くるかもしれない/g,
    /と思います/g,
    /ように/g,
    /できるかもしれ/g,
  ];

  // 日本語 “無難テンプレ” の最小セット（slotsが無い時に効く）
  const GENERIC = [
    // --- “無難テンプレ” （今回の実例を確実に拾う） ---
    /ことがある/u, // 「〜ことがある」
    /一つの手/u, // 「一つの手だ」
    /整理してみる/u, // 「整理してみると」
    /きっかけになる/u, // 「きっかけになる」
    /自然に/u, // 「自然に〜」
    /考えてみると/u, // 「考えてみると」

    // --- 似た逃げ口上（今後も出やすい） ---
    /見えてくる/u, // 「見えてくる」
    /明確にする/u, // 「明確にする」
    /〜?みると/u, // 「〜してみると」（雑に増えやすい）
    /〜?かもしれ/u, // 「かもしれません」系（hedgeと別でも拾う）
    /〜?と思い/u, // 「と思います」系
    /〜?でしょう/u, // 「でしょう」系
    /〜?可能性/u, // 「可能性」系

    // --- “感じがある”系（あなたが潰したい口癖） ---
    /感じがある/u,
    /感じがする/u,
    /感じがします/u,
  ];

  // 旗印側の「視点を一段変える」兆候（補助）
  const FLAGSHIP_SIGNS = [
    /見方/g,
    /視点/g,
    /角度/g,
    /言い換えると/g,
    /いま大事なのは/g,
    /ここでやることは/g,
    /まず切り分ける/g,
    /焦点/g,
    /輪郭/g,
  ];

  const cheer = countMatches(t, CHEER);
  const hedge = countMatches(t, HEDGE);
  const generic = countMatches(t, GENERIC);
  const hasFlagshipSign = hasAny(t, FLAGSHIP_SIGNS);

  // ---------------------------------------------
  // スコア化
  // ---------------------------------------------
  let fatal = 0;
  let warn = 0;

  // ルール1: 質問は最大1（既存ポリシーと整合）
  if (qCount >= 2) {
    fatal += 2;
    reasons.push('QCOUNT_TOO_MANY');
  } else if (qCount === 1) {
    warn += 1;
    reasons.push('QCOUNT_ONE');
  }

  // ✅ ルール2: scaffoldLike で must-have が欠けたら FATAL（構造維持失敗）
  if (mh.scaffoldLike) {
    const missingMustHave =
      reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
      reasons.includes('SCAFFOLD_ONE_POINT_MISSING') ||
      reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED');

    if (missingMustHave) {
      fatal += 2;
      reasons.push('SCAFFOLD_MUST_HAVE_BROKEN');
    }
  }

  // 補助ルール（最後の保険）
  if (cheer >= 2) {
    warn += 2;
    reasons.push('CHEER_MANY');
  } else if (cheer === 1) {
    warn += 1;
    reasons.push('CHEER_PRESENT');
  }

  if (hedge >= 2) {
    warn += 2;
    reasons.push('HEDGE_MANY');
  } else if (hedge === 1) {
    warn += 1;
    reasons.push('HEDGE_PRESENT');
  }

  if (generic >= 2) {
    warn += 2;
    reasons.push('GENERIC_MANY');
  } else if (generic === 1) {
    warn += 1;
    reasons.push('GENERIC_PRESENT');
  }

  if (bulletLike) {
    warn += 1;
    reasons.push('BULLET_LIKE');
  }

  // 重要：汎用圧が高いのに視点兆候ゼロ（slotsが無い時の保険）
  const blandPressure = cheer + hedge + generic;
  if (!mh.scaffoldLike && !hasFlagshipSign && blandPressure >= 4) {
    fatal += 2;
    reasons.push('NO_FLAGSHIP_SIGN_WITH_BLAND_PRESSURE');
  }

  // 短文で「励まし＋一般質問」だけ（slotsが無い時の保険）
  if (!mh.scaffoldLike && t.length <= 160 && qCount === 1 && !hasFlagshipSign && cheer + hedge >= 2) {
    fatal += 2;
    reasons.push('SHORT_GENERIC_CHEER_WITH_QUESTION');
  }

  // 最終判定（FLAG_* / scaffoldLike は “薄さ” に敏感にする）
  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  const isFlagReplyLike = slotKeys.length > 0 && slotKeys.every((k) => String(k).startsWith('FLAG_'));

  let level: FlagshipVerdict['level'] = 'OK';

  // ✅ FLAG_* / scaffoldLike は “warn>=2” で WARN に上げる（＝HEDGE_MANY単独でも拾う）
  const warnThreshold = mh.scaffoldLike || isFlagReplyLike ? 2 : 3;

  if (fatal >= 2) level = 'FATAL';
  else if (warn >= warnThreshold) level = 'WARN';

  const ok = level !== 'FATAL';

  // ✅ WARNでも“停滞/体験崩れ”なら上位で介入させたい
  const shouldRaiseFlag =
    level === 'FATAL' ||
    (level === 'WARN' &&
      (reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED') ||
        reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
        hedge >= 3 ||
        generic >= 2 ||
        (!hasFlagshipSign && blandPressure >= 3)));

  return {
    ok,
    level,
    qCount,
    score: {
      fatal,
      warn,
      qCount,
      bulletLike,
      hedge,
      cheer,
      generic,
    },
    reasons,
    shouldRaiseFlag,
  };
}
export async function runGreetingGate(args: any): Promise<{
  ok: boolean;
  result: string | null;
  metaForSave: any | null;
}> {
  const norm = (s: any) =>
    String(s ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const userText = norm(args?.userText ?? args?.text ?? args?.input_text ?? args?.lastUserText ?? '');

  // 記号・空白・絵文字を落として「挨拶だけ」かを見る
  const core = userText
    .replace(/[。．.!！?？\s]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '');

  if (!core) return { ok: false, result: null, metaForSave: null };

  const hit =
    (/^(こんばんは|今晩は)$/u.test(core) && 'こんばんは。') ||
    (/^(こんにちは)$/u.test(core) && 'こんにちは。') ||
    (/^(おはよう|おはようございます)$/u.test(core) && 'おはようございます。') ||
    (/^(はじめまして|初めまして)$/u.test(core) && 'はじめまして。') ||
    (/^(hi|hello)$/iu.test(core) && 'こんにちは。') ||
    null;

  if (!hit) return { ok: false, result: null, metaForSave: null };

  // ✅ 固定テンプレを避ける：ここは「素材」だけ返す（判断しない）
  // - 「続けてどうぞ。」は機械っぽいので撤去
  // - 質問は 0〜1 に収める（今回は 1）
  // - iros語は出しすぎず、Sofia寄せの余白で
  const seed = `${hit}\n今日はどんなところから始めます？🪔`;

  return {
    ok: true,
    result: seed,
    metaForSave: {
      gate: 'greeting',
      // 上位で「このターンもLLM整形に流す」判定に使えるよう、印だけ残す
      prefer_llm_writer: true,
    },
  };
}

