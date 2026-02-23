// src/lib/iros/quality/flagshipGuard.ts
// iros — Flagship Quality Guard (Lenient / Flow-First)
//
// ✅ 目的
// - “意味” を判断しない（意図/正解/説教に踏み込まない）
// - UX品質の最低ラインだけ守る（薄逃げ/過剰ヘッジ/汎用文/質問過多/必須欠落）
// - normalChat は「会話を流す」を最優先（落としにくい）
// - scaffoldLike / flagReplyLike は must-have を守る（ここだけ厳格）
//
// ✅ 重要（設計固定）
// - 見出しの再追加/再生成はこのガードの責務ではない
//   → 見出し有無の検出/強制/加点は一切しない
// - このファイルは本文を書き換えない。返すのは verdict（判定）だけ。

// ------------------------------------------------------------
// Revision + feature flags
// ------------------------------------------------------------

// ✅ 実行ファイル同一性の証明（.next の別チャンク / 古い版混入を潰す）
const IROS_FLAGSHIP_GUARD_REV = 'guard-rev-2026-02-23-a';

// ✅ ガード全体のON/OFF（OFFなら必ずOKで素通し）
const FLAGSHIP_GUARD_ENABLED = (() => {
  const v = String(process.env.IROS_FLAGSHIP_GUARD_ENABLED ?? '').trim().toLowerCase();
  // 未設定は true（既定ON）
  if (!v) return true;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

// ✅ DEBUGログは明示ONのときだけ（本番ログ汚染/観測ノイズ防止）
const FLAGSHIP_DEBUG_ON = (() => {
  const v = String(process.env.IROS_FLAGSHIP_DEBUG ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

function dlog(tag: string, obj?: any) {
  if (!FLAGSHIP_DEBUG_ON) return;
  if (obj === undefined) console.log(tag);
  else console.log(tag, obj);
}
function dwarn(tag: string, obj?: any) {
  if (!FLAGSHIP_DEBUG_ON) return;
  if (obj === undefined) console.warn(tag);
  else console.warn(tag, obj);
}

dwarn('[IROS/FLAGSHIP_GUARD][MODULE_LOADED]', {
  rev: IROS_FLAGSHIP_GUARD_REV,
  enabled: FLAGSHIP_GUARD_ENABLED,
  at: new Date().toISOString(),
});

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
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
  return patterns.some((p) => {
    if (p.global) p.lastIndex = 0;
    return p.test(text);
  });
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

// “must-have” を needle に落とす（完全一致要求はしない）
function makeNeedle(raw: string, opts?: { min?: number; max?: number }): string | null {
  const min = Math.max(6, Number(opts?.min ?? 10));
  const max = Math.min(48, Math.max(min, Number(opts?.max ?? 24)));

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
      purposeNeedle = makeNeedle(txt, { min: 10, max: 24 });
      continue;
    }

    if (!onePointNeedle && (k.includes('ONE_POINT') || k.includes('FLAG_ONE_POINT'))) {
      onePointNeedle = makeNeedle(txt, { min: 10, max: 26 });
      continue;
    }

    if (k.includes('POINTS_3') || k.includes('FLAG_POINTS_3')) {
      const lines = norm(txt)
        .split('\n')
        .map((x) => x.replace(/^\s*[-*•]\s+/, '').trim())
        .filter(Boolean);

      for (const line of lines) {
        const nd = makeNeedle(line, { min: 8, max: 24 });
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
 * strict: ?なし疑問文も数える（過敏にならないよう最小限）
 * - normalChat は “? / ？” のみ
 */
function countQuestionLikeStrict(text: string): number {
  const t = norm(text);

  const markCount = (t.match(/[？?]/g) ?? []).length;

  const lines = t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let likeCount = 0;

  // 文末ベースで “軽く” 判定（誤爆しにくい範囲だけ）
  const reEndsLikeQuestion = /(ですか|ますか|でしょうか|かな|か\W*$)$/;
  const reAskLike =
    /(教えて(ください)?|聞かせて(ください)?|説明して(ください)?|理由を|根拠を|意味を)/;

  for (const line of lines) {
    if (/[？?]/.test(line)) continue;

    if (reAskLike.test(line)) {
      likeCount += 1;
      continue;
    }
    if (reEndsLikeQuestion.test(line)) {
      likeCount += 1;
      continue;
    }
  }

  return markCount + likeCount;
}

/**
 * normalChat 判定（キーで判断）
 * - OBS があり、SHIFT か writer系キー（TASK/DRAFT/CONSTRAINTS）が同居するなら normalChat
 */
function isNormalChatLite(ctx?: FlagshipGuardContext | null): boolean {
  const keys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  if (keys.length === 0) return false;

  // flagReply は FLAG_ だらけ
  const isFlag = keys.every((k) => String(k).startsWith('FLAG_'));
  if (isFlag) return false;

  const hasObs = keys.includes('OBS');
  if (!hasObs) return false;

  const hasShift = keys.includes('SHIFT');
  const hasTask = keys.includes('TASK');
  const hasDraft = keys.includes('DRAFT');
  const hasConstraints = keys.includes('CONSTRAINTS');

  return hasShift || hasTask || hasDraft || hasConstraints;
}

// ------------------------------------------------------------
// patterns (meaning-free, expression-only)
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
  /一歩/g,
  /進展/g,
  /積み重ね/g,
  /無理しない/g,
  /安心して/g,
  /少しだけ/g,
  /ちょっとだけ/g,
];

const HEDGE = [
  /かもしれません/g,
  /かもしれない/g,
  /と思います/g,
  /ように/g,
  /できるかもしれ/g,
];

const GENERIC = [
  /整理してみる/u,
  /きっかけになる/u,
  /自然に/u,
  /見えてくる/u,
  /明確にする/u,
  /(?:して|やって|取って|試して|見つめて|眺めて|置いて)みる/u,
  /〜?かもしれ/u,
  /〜?と思い/u,
  /〜?でしょう/u,
  /可能性/u,
  /感じがする/u,
  /感じがします/u,
];

const FLAGSHIP_SIGNS = [
  /見方/g,
  /視点/g,
  /角度/g,
  /言い換えると/g,
  /いま大事なのは/g,
  /まず切り分ける/g,
  /焦点/g,
  /輪郭/g,
];

// ------------------------------------------------------------
// main
// ------------------------------------------------------------
export function flagshipGuard(input: string, ctx?: FlagshipGuardContext | null): FlagshipVerdict {
  // ✅ OFFなら完全素通し（切れるように）
  if (!FLAGSHIP_GUARD_ENABLED) {
    return {
      ok: true,
      level: 'OK',
      qCount: 0,
      score: {
        fatal: 0,
        warn: 0,
        qCount: 0,
        bulletLike: 0,
        hedge: 0,
        cheer: 0,
        generic: 0,
        runaway: 0,
        exaggeration: 0,
        mismatch: 0,
        retrySame: 0,
      },
      reasons: ['GUARD_DISABLED'],
      shouldRaiseFlag: false,
    };
  }

  const t = norm(input);

  // 監視ログ（debug時のみ）
  dlog('[IROS/FLAGSHIP_GUARD][DEBUG_IN]', {
    rev: IROS_FLAGSHIP_GUARD_REV,
    inputLen: String(input ?? '').length,
    inputHead: String(input ?? '').slice(0, 120),
    slotKeys: Array.isArray(ctx?.slotKeys) ? ctx?.slotKeys : null,
  });

  const reasons: string[] = [];
  const normalLite = isNormalChatLite(ctx);

  // qCount
  const qCountMark = (t.match(/[？?]/g) ?? []).length;
  const qCountRaw = normalLite ? qCountMark : countQuestionLikeStrict(t);

  // ✅ 0問扱いに倒す（誤爆防止）：「?が0なら質問として数えない」
  const qCount = qCountMark === 0 ? 0 : qCountRaw;

  // bulletLike（箇条書き寄り）
  const bulletLike = /(^|\n)\s*[-*•]\s+/.test(t) || /(^|\n)\s*\d+\.\s+/.test(t) ? 1 : 0;

  // scaffold must-have（strict only）
  const mh = extractScaffoldMustHave(ctx);

  // pressure counts
  const cheer = countMatches(t, CHEER);
  const hedge = countMatches(t, HEDGE);
  const generic = countMatches(t, GENERIC);
  const hasFlagshipSign = hasAny(t, FLAGSHIP_SIGNS);
  const blandPressure = cheer + hedge + generic;

  dlog('[IROS/FLAGSHIP_GUARD][DEBUG_SCORE]', {
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
  // scoring (lenient)
  // ------------------------------------------------------------
  let fatal = 0;
  let warn = 0;

  // 0) scaffold must-have 抽出（strict only）
  if (!normalLite && mh.scaffoldLike) {
    const hasPurpose = mh.purposeNeedle ? includesNeedle(t, mh.purposeNeedle) : true;
    const hasOnePoint = mh.onePointNeedle ? includesNeedle(t, mh.onePointNeedle) : true;
    const hasPoints3 =
      mh.points3Needles.length === 0 ? true : mh.points3Needles.every((nd) => includesNeedle(t, nd));

    if (mh.purposeNeedle && !hasPurpose) reasons.push('SCAFFOLD_PURPOSE_MISSING');
    if (mh.onePointNeedle && !hasOnePoint) reasons.push('SCAFFOLD_ONE_POINT_MISSING');
    if (mh.points3Needles.length > 0 && !hasPoints3) reasons.push('SCAFFOLD_POINTS3_NOT_PRESERVED');

    const missingMustHave =
      reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
      reasons.includes('SCAFFOLD_ONE_POINT_MISSING') ||
      reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED');

    // ✅ must-have だけは落とす（ここが “厳格ゾーン”）
    if (missingMustHave) {
      fatal += 2;
      reasons.push('SCAFFOLD_MUST_HAVE_BROKEN');
    }
  }

  // 1) 質問の扱い
  if (normalLite) {
    // ✅ normalChatは基本素通し：極端な質問連打だけ抑える
    if (qCount >= 7) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount >= 5) {
      warn += 1;
      reasons.push('QCOUNT_MANY');
    }
  } else {
    // strict: 連問だけ軽く抑える（FATALは 3+ から）
    if (qCount >= 3) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount === 2) {
      warn += 1;
      reasons.push('QCOUNT_TWO');
    } else if (qCount === 1) {
      // 1問は通常。ここでは理由だけ（warn加点しない）
      reasons.push('QCOUNT_ONE');
    }
  }

  // 2) 薄逃げ（normalChatはほぼ抑制しない）
  // - “会話が止まる” のを避けるため、FATALは strict のみ、しかも極端条件のみ
  if (!mh.scaffoldLike && t.length > 0) {
    if (!normalLite) {
      // strict: 短くて汎用圧が高く、視点兆候ゼロ、質問ゼロ → 体験崩れとしてFATAL
      if (t.length <= 140 && qCount === 0 && blandPressure >= 4 && !hasFlagshipSign) {
        fatal += 2;
        reasons.push('SHORT_BLAND_NO_SIGN');
      } else if (t.length <= 180 && qCount === 0 && blandPressure >= 3 && !hasFlagshipSign) {
        warn += 1;
        reasons.push('BLAND_NO_SIGN');
      }
    } else {
      // normalChat: “極端に薄い” ときだけ WARN
      if (t.length <= 100 && qCount === 0 && blandPressure >= 5) {
        warn += 1;
        reasons.push('NORMAL_EXTREME_BLAND');
      }
    }
  }

  // 3) strict only: 箇条書き/ヘッジ/汎用は WARN に寄せる（落とさない）
  if (!normalLite) {
    if (bulletLike) {
      // 見出し強制はしない。ただ箇条書きが多すぎると読み味が崩れるので軽WARN
      warn += 1;
      reasons.push('BULLET_LIKE');
    }
    if (hedge >= 3) {
      warn += 1;
      reasons.push('HEDGE_MANY');
    } else if (hedge === 2) {
      reasons.push('HEDGE_SOME');
    }
    if (generic >= 3) {
      warn += 1;
      reasons.push('GENERIC_MANY');
    } else if (generic === 2) {
      reasons.push('GENERIC_SOME');
    }

    // “汎用圧が極端で視点兆候ゼロ” のときだけ最終WARN（FATALにはしない）
    if (!mh.scaffoldLike && !hasFlagshipSign && blandPressure >= 6) {
      warn += 1;
      reasons.push('NO_SIGN_WITH_HIGH_BLAND');
    }
  }

  // ------------------------------------------------------------
  // verdict thresholds
  // ------------------------------------------------------------
  // normalChat は “流す”：WARNも拾いすぎない
  // strict は scaffold/flag なら介入しやすく（warnThreshold低め）
  const warnThreshold = normalLite ? 2 : mh.scaffoldLike || isFlagReplyLike ? 2 : 3;

  let level: FlagshipVerdict['level'] = 'OK';
  if (fatal >= 2) level = 'FATAL';
  else if (warn >= warnThreshold) level = 'WARN';

  const ok = level !== 'FATAL';

  // ------------------------------------------------------------
  // shouldRaiseFlag
  // ------------------------------------------------------------
  // ✅ normalChat は基本 raise しない（流れ優先）
  let shouldRaiseFlag = false;
  if (!normalLite) {
    // must-have欠落 or “極端に薄い” のときだけ上位介入
    shouldRaiseFlag =
      level === 'FATAL' ||
      (level === 'WARN' &&
        (reasons.includes('SCAFFOLD_MUST_HAVE_BROKEN') ||
          reasons.includes('SHORT_BLAND_NO_SIGN') ||
          reasons.includes('NO_SIGN_WITH_HIGH_BLAND')));
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
