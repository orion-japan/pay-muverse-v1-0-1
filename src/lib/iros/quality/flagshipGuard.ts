// src/lib/iros/quality/flagshipGuard.ts
// iros — Flagship Quality Guard
//
// ✅ 方針（2026-01 / “まず会話を流す”）
// - normalChat は「浅い会話/GPTっぽさ」を許し、LLMの自然文を通す（落としにくい）
// - flagReply / scaffoldLike は従来どおり厳格（must-have を守る／薄逃げを落とす）
// - normalChat で “質問っぽい推定” が過敏すぎて FATAL になるのを止める
//   → normalChat の qCount は「? / ？」の数だけ（疑問文推定はしない）
//
// 注意：このガードは “意味の判断” をしない。品質/体験維持のための表現ゲートのみ。
//
// ✅ 追加（2026-01-28）
// - 「とにかく会話を流す」優先で、normalChat の WARN/FATAL をさらに弱める
// - 採点の内訳ログ（hedge等）と、WARN加点後ログを固定して “版ズレ/反映漏れ” を即発見できるようにする
// ---------------------------------------------
// IMPORTANT — DESIGN GUARD (DO NOT REDEFINE)
//
// This guard must NOT judge meaning, intent, or make decisions.
// It ONLY protects UX quality (thin/hedge/generic) and stability.
//
// It must NOT:
// - introduce decision-making or “correct answer” behavior
// - change Sofia/Iros philosophical stance (user agency)
// - add meta leakage into output
// ---------------------------------------------

// ✅ 実行ファイル同一性の証明（.next の別チャンク / 古い版混入を潰す）
const IROS_FLAGSHIP_GUARD_REV = 'guard-rev-2026-01-28-b';
console.warn('[IROS/FLAGSHIP_GUARD][MODULE_LOADED]', {
  rev: IROS_FLAGSHIP_GUARD_REV,
  at: new Date().toISOString(),
});

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

    // 既存ログ互換（現状未使用でも0で返す）
    runaway: number;
    exaggeration: number;
    mismatch: number;
    retrySame: number;
  };
  reasons: string[];

  // ✅ WARNでも“停滞/体験崩れ”なら、上位で介入させるためのフラグ
  shouldRaiseFlag: boolean;
};

type GuardSlot = { key?: string; text?: string; content?: string; value?: string };

export type FlagshipGuardContext = {
  // slotKeys（inKeys）
  slotKeys?: string[] | null;

  // extracted.slots 等（PURPOSE / ONE_POINT / POINTS_3 の素材を拾う）
  slotsForGuard?: GuardSlot[] | null;
};

// ------------------------------------------------------------
// basics
// ------------------------------------------------------------
function norm(s: string) {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normLite(s: string) {
  return norm(s).toLowerCase();
}

function countMatches(text: string, patterns: RegExp[]) {
  let c = 0;
  for (const p of patterns) {
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

function keyHas(k: string, word: string) {
  return String(k ?? '').toUpperCase().includes(word.toUpperCase());
}

// ------------------------------------------------------------
// scaffold must-have (strict only)
// ------------------------------------------------------------

// “構造 must-have” を needle に落とす（完全一致要求はしない）
function makeNeedle(raw: string, opts?: { min?: number; max?: number }): string | null {
  const min = Math.max(6, Number(opts?.min ?? 10));
  const max = Math.min(40, Math.max(min, Number(opts?.max ?? 18)));

  const t = norm(raw)
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

// slots から must-have（purpose / one-point / points3）を抽出
function extractScaffoldMustHave(ctx?: FlagshipGuardContext | null): {
  scaffoldLike: boolean;
  purposeNeedle: string | null;
  onePointNeedle: string | null;
  points3Needles: string[];
} {
  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map((x) => String(x)) : [];
  const slots = Array.isArray(ctx?.slotsForGuard) ? (ctx!.slotsForGuard as GuardSlot[]) : [];

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

// ------------------------------------------------------------
// qCount
// ------------------------------------------------------------

/**
 * strict: ?なし疑問文も数える（ただし「何かが〜」等の “something” を疑問扱いしない）
 *
 * 重要：
 * - WH語だけで増やさない（「何かが…」を誤爆するため）
 * - 末尾の疑問終端（ですか/ますか/でしょうか/かな 等）と、
 *   “依頼/質問動詞” のみで加算する
 */
function countQuestionLikeStrict(text: string): number {
  const t = norm(text);

  // 1) 記号（? / ？）はそのまま数える
  const markCount = (t.match(/[？?]/g) ?? []).length;

  // 2) ?なし疑問文（日本語）を検出して加算
  //    ※ただし「?がある行」は除外して二重カウントを防止
  const lines = t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let likeCount = 0;

  // 末尾が疑問っぽい（文末で判断：誤爆を減らす）
  // - 「か」単体は誤爆しやすいので “文末の か” だけに限定（助詞の途中「何かが」は拾わない）
  const reEndsLikeQuestion = /(ですか|ますか|でしょうか|かな|の\W*$|か\W*$)$/;

  // “質問/依頼” の明示（文末でなくても質問として成立しやすい）
  const reAskLike =
    /(教えて(ください)?|聞かせて(ください)?|どう思う|どう思いますか|説明して(ください)?|理由を|根拠を|意味を)/;

  // WH語（参考）：単体では加算しない。末尾疑問 or askLike と組み合わせたときだけ。
  const reWh =
    /(どう(すれば|したら)?|なぜ|なんで|どこ|いつ|どれ|どんな|誰|誰が|誰に|何(が|を|の)?)/;

  for (const line of lines) {
    if (/[？?]/.test(line)) continue;

    const endsLikeQuestion = reEndsLikeQuestion.test(line);
    const askLike = reAskLike.test(line);
    const hasWh = reWh.test(line);

    // ✅ 誤爆防止：
    // - hasWh だけでは数えない（例:「何かが解けていく」）
    // - endsLikeQuestion / askLike がある場合だけ加算
    if (askLike) {
      likeCount += 1;
      continue;
    }
    if (endsLikeQuestion) {
      // endsLikeQuestion がある時点で質問として成立しているので加算（WH語の有無で分岐しない）
      likeCount += 1;
      continue;
    }

    // hasWh のみは加算しない（意図的）
    void hasWh;
  }

  return markCount + likeCount;
}

/**
 * normalChat 判定（キーで判断）
 *
 * ✅ 重要：rephrase最終の inKeys が [OBS, SHIFT] の形でも normalChat とみなす
 * （SEED_TEXT が guard に渡らないケースがあるため）
 */
function isNormalChatLite(ctx?: FlagshipGuardContext | null): boolean {
  const keys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  if (keys.length === 0) return false;

  // flagReply は FLAG_ だらけ
  const isFlag = keys.every((k) => String(k).startsWith('FLAG_'));
  if (isFlag) return false;

  // normalChat: OBS / SHIFT が中心（SEED_TEXT はある時もない時もある）
  const hasObs = keys.includes('OBS');
  const hasShift = keys.includes('SHIFT');

  // ※最小条件：OBS+SHIFT が揃っていれば normalChat 寄りとして扱う
  return hasObs && hasShift;
}

// ------------------------------------------------------------
// patterns
// ------------------------------------------------------------
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
  /少しだけ/g,
  /ちょっとだけ/g,
];

const HEDGE = [
  /かもしれません/g,
  /かもしれない/g,
  /(?:見えて|分かって)くるかもしれない/g,
  /と思います/g,
  /ように/g,
  /できるかもしれ/g,
];

const GENERIC = [
  /ことがある/u,
  /一つの手/u,
  /一つの道/u,
  /整理してみる/u,
  /きっかけになる/u,
  /自然に/u,
  /考えてみると/u,
  /見えてくる/u,
  /明確にする/u,
  /(?:して|やって|取って|試して|見つめて|眺めて|置いて)みる/u,
  /〜?みると/u,
  /〜?かもしれ/u,
  /〜?と思い/u,
  /〜?でしょう/u,
  /〜?可能性/u,
  /感じがある/u,
  /感じがする/u,
  /感じがします/u,
];

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

// ------------------------------------------------------------
// main
// ------------------------------------------------------------
export function flagshipGuard(input: string, ctx?: FlagshipGuardContext | null): FlagshipVerdict {
  const t = norm(input);

  // ✅ 何を採点しているかをログで固定（「headと実体が違う」事故も潰す）
  console.log('[IROS/FLAGSHIP_GUARD][DEBUG_IN]', {
    rev: IROS_FLAGSHIP_GUARD_REV,
    inputLen: String(input ?? '').length,
    inputHead: String(input ?? '').slice(0, 120),
    slotKeys: Array.isArray(ctx?.slotKeys) ? ctx?.slotKeys : null,
  });

  const reasons: string[] = [];
  const normalLite = isNormalChatLite(ctx);

  // qCount: normalChat は「? / ？」のみ。strict は疑問文推定込み。
  const qCountMark = (t.match(/[？?]/g) ?? []).length;
  const qCount = normalLite ? qCountMark : countQuestionLikeStrict(t);

  // bulletLike（箇条書き寄り）
  const bulletLike = /(^|\n)\s*[-*•]\s+/.test(t) || /(^|\n)\s*\d+\.\s+/.test(t) ? 1 : 0;

  // scaffold must-have（strict only）
  const mh = extractScaffoldMustHave(ctx);
  if (!normalLite && mh.scaffoldLike) {
    const hasPurpose = includesNeedle(t, mh.purposeNeedle);
    const hasOnePoint = includesNeedle(t, mh.onePointNeedle);
    const hasPoints3 =
      mh.points3Needles.length === 0 ? true : mh.points3Needles.every((nd) => includesNeedle(t, nd));

    if (mh.purposeNeedle && !hasPurpose) reasons.push('SCAFFOLD_PURPOSE_MISSING');
    if (mh.onePointNeedle && !hasOnePoint) reasons.push('SCAFFOLD_ONE_POINT_MISSING');
    if (mh.points3Needles.length > 0 && !hasPoints3) reasons.push('SCAFFOLD_POINTS3_NOT_PRESERVED');
  }

  // pressure counts
  const cheer = countMatches(t, CHEER);
  const hedge = countMatches(t, HEDGE);
  const generic = countMatches(t, GENERIC);
  const hasFlagshipSign = hasAny(t, FLAGSHIP_SIGNS);
  const blandPressure = cheer + hedge + generic;

  // ✅ 採点内訳ログ（版ズレ・反映漏れを即発見）
  console.log('[IROS/FLAGSHIP_GUARD][DEBUG_SCORE]', {
    rev: IROS_FLAGSHIP_GUARD_REV,
    normalLite,
    scaffoldLike: mh.scaffoldLike,
    len: t.length,
    qCount,
    qCountMark,
    cheer,
    hedge,
    generic,
    blandPressure,
    bulletLike,
    hasFlagshipSign,
  });

  // slot keys (flagReply 判定)
  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  const isFlagReplyLike = slotKeys.length > 0 && slotKeys.every((k) => String(k).startsWith('FLAG_'));

  // ------------------------------------------------------------
  // scoring
  // ------------------------------------------------------------
  let fatal = 0;
  let warn = 0;

  // 1) 質問の扱い（✅さらに緩める）
  if (normalLite) {
    // “まず会話を流す”：1〜2問は完全に素通し（warnも理由も付けない）
    if (qCount >= 5) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount === 4) {
      warn += 1;
      reasons.push('QCOUNT_FOUR');
    } else if (qCount === 3) {
      // 3問でも warn 1 に留める（会話流し優先）
      warn += 1;
      reasons.push('QCOUNT_THREE');
    }
  } else {
    // strict: 2以上は強め
    if (qCount >= 2) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount === 1) {
      warn += 1;
      reasons.push('QCOUNT_ONE');
    }
  }

  // 2) scaffold must-have が欠けたら strict では FATAL
  if (!normalLite && mh.scaffoldLike) {
    const missingMustHave =
      reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
      reasons.includes('SCAFFOLD_ONE_POINT_MISSING') ||
      reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED');

    if (missingMustHave) {
      fatal += 2;
      reasons.push('SCAFFOLD_MUST_HAVE_BROKEN');
    }
  }

  // 3) 短文薄逃げ（✅ normalChat は “ほぼ介入しない”）
  // - ここで normalChat を過敏にすると「会話が止まる」ので、相当悪い時だけ WARN
  if (!mh.scaffoldLike && t.length > 0 && t.length <= 160) {
    if (!normalLite) {
      // strict 側のみ従来寄り
      if (qCount === 0 && blandPressure >= 2) {
        if (!hasFlagshipSign) {
          fatal += 2;
          reasons.push('SHORT_GENERIC_NO_QUESTION');
        }
      }
      if (qCount === 1 && !hasFlagshipSign && cheer + hedge >= 2) {
        fatal += 2;
        reasons.push('SHORT_GENERIC_CHEER_WITH_QUESTION');
      }
    } else {
      // normalLite: blandPressure が極端（>=4）で短文（<=120）なら WARN 1
      if (t.length <= 120 && qCount === 0 && blandPressure >= 4) {
        warn += 1;
        reasons.push('NORMAL_SHORT_BLAND_PRESSURE');
      }
    }
  }

  // 4) strict only: 文字列品質（cheer/hedge/generic/bullets/flagshipSign）
  if (!normalLite) {
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

    // ✅ hedge 加点後ログ（今回の “hedge=1 なのに warn=0” を一発で潰す）
    console.log('[IROS/FLAGSHIP_GUARD][DEBUG_AFTER_HEDGE]', {
      rev: IROS_FLAGSHIP_GUARD_REV,
      warn,
      fatal,
      reasons: reasons.slice(0, 12),
    });

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

    // 汎用圧が高いのに視点兆候ゼロ（strictの最終FATAL）
    if (!mh.scaffoldLike && !hasFlagshipSign && blandPressure >= 4) {
      fatal += 2;
      reasons.push('NO_FLAGSHIP_SIGN_WITH_BLAND_PRESSURE');
    }
  }

  // ------------------------------------------------------------
  // verdict thresholds
  // ------------------------------------------------------------
  // normalChat は “流す” が目的：WARNは拾うがFATALに寄せにくい（ただしQCOUNT極端などはFATAL）
  // strict は scaffold/flag で warnThreshold を低めにして早めに介入
  const warnThreshold = normalLite ? 2 : mh.scaffoldLike || isFlagReplyLike ? 2 : 3;

  let level: FlagshipVerdict['level'] = 'OK';
  if (fatal >= 2) level = 'FATAL';
  else if (warn >= warnThreshold) level = 'WARN';

  const ok = level !== 'FATAL';

  // ------------------------------------------------------------
  // shouldRaiseFlag
  // ------------------------------------------------------------
  // normalChat は基本 “上位介入” させない（流れ優先）
  let shouldRaiseFlag = false;
  if (!normalLite) {
    shouldRaiseFlag =
      level === 'FATAL' ||
      (level === 'WARN' &&
        (reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED') ||
          reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
          reasons.includes('SCAFFOLD_ONE_POINT_MISSING') ||
          hedge >= 3 ||
          generic >= 2 ||
          (!hasFlagshipSign && blandPressure >= 3)));
  }

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

      runaway: 0,
      exaggeration: 0,
      mismatch: 0,
      retrySame: 0,
    },
    reasons,
    shouldRaiseFlag,
  };
}
