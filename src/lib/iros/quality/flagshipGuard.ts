// src/lib/iros/quality/flagshipGuard.ts
// iros — Flagship Quality Guard
//
// 目的：
// - 旗印「読み手が“自分で答えを出せる場所”」から外れる“汎用応援文”を落とす
// - 「励まし＋一般質問」「〜かもしれません連発」「中身が薄い」などを WARN/FATAL
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
  // 例：HEDGE/GENERIC/汎用応援が強いのに、視点転換の兆候が弱い
  shouldRaiseFlag: boolean;
};

function norm(s: string) {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function countMatches(text: string, patterns: RegExp[]) {
  let c = 0;
  for (const p of patterns) {
    const m = text.match(p);
    if (m) c += m.length;
  }
  return c;
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((p) => p.test(text));
}

export function flagshipGuard(input: string): FlagshipVerdict {
  const t = norm(input);

  const reasons: string[] = [];
  const qCount = (t.match(/[？?]/g) ?? []).length;

  // 箇条書きっぽさ（旗印というより“助言テンプレ”になりがち）
  const bulletLike =
    /(^|\n)\s*[-*•]\s+/.test(t) || /(^|\n)\s*\d+\.\s+/.test(t) ? 1 : 0;

  // “汎用応援”の語彙（これが多いほど危険）
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

    // ✅ よくある“励まし締め”系
    /一歩/g,
    /進展/g,
    /大きな一歩/g,
    /積み重ね/g,
    /無理しない/g,
    /安心して/g,
  ];

  // “ぼかし/逃げ”の語彙（これが多いと「判断の責任を文章が回避」しやすい）
  const HEDGE = [
    /かもしれません/g,
    /かもしれない/g,
    /(?:見えて|分かって)くるかもしれない/g,
    /感じ(ています|ます)か/g,
    /〜?すると(?:.*)?(良い|上がる|見える|変わる)/g,
    /と思います/g,
    /ように/g,
    /できるかもしれ/g,
  ];

  // “一般化しすぎ”を示す語彙（誰にでも当てはまる）
  const GENERIC = [
    /全体の完成度/g,
    /鍵になる/g,
    /考えると/g,
    /役に立つ/g,
    /良くなる/g,
    /高まる/g,
    /上がる/g,

    // ✅ “抽象まとめ”系
    /全体像/g,
    /ステップ/g,
    /要素/g,
  ];

  // 旗印側の「視点を一段変える」「読み手の位置を作る」っぽい語彙
  // ※これがゼロで、かつ CHEER/HEDGE/GENERIC が多いと “汎用文” と判定する
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

  // スコア化
  let fatal = 0;
  let warn = 0;

  // ルール1: 質問は最大1（既存ポリシーと整合）
  if (qCount >= 2) {
    fatal += 2;
    reasons.push('QCOUNT_TOO_MANY');
  } else if (qCount === 1) {
    // 単体の質問でも“汎用質問”に寄りやすいので軽く加点
    warn += 1;
    reasons.push('QCOUNT_ONE');
  }

  // ルール2: 汎用応援＋ぼかしが多いほど危険
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

  // ルール3: “誰にでも言える”語彙が多い
  if (generic >= 2) {
    warn += 2;
    reasons.push('GENERIC_MANY');
  } else if (generic === 1) {
    warn += 1;
    reasons.push('GENERIC_PRESENT');
  }

  // ルール4: 箇条書きテンプレは warn
  if (bulletLike) {
    warn += 1;
    reasons.push('BULLET_LIKE');
  }

  // ルール5（重要）:
  // 「CHEER/HEDGE/GENERIC が強いのに、旗印シグナルがゼロ」なら “汎用応援文” として落とす
  const blandPressure = cheer + hedge + generic;
  if (!hasFlagshipSign && blandPressure >= 4) {
    fatal += 2;
    reasons.push('NO_FLAGSHIP_SIGN_WITH_BLAND_PRESSURE');
  }

  // ルール6:
  // 短文で「励まし＋一般質問」だけの形は “会話が進まない” ので落とす
  if (t.length <= 160 && qCount === 1 && !hasFlagshipSign && cheer + hedge >= 2) {
    fatal += 2;
    reasons.push('SHORT_GENERIC_CHEER_WITH_QUESTION');
  }

  // 最終判定
  let level: FlagshipVerdict['level'] = 'OK';
  if (fatal >= 2) level = 'FATAL';
  else if (warn >= 3) level = 'WARN';

  const ok = level !== 'FATAL';

  // ✅ WARNでも“停滞/体験崩れ”なら上位で介入させたい
  // - FATAL は当然 raise
  // - WARN は「ぼかし/汎用が強い」「旗印シグナルが弱い」などで raise
  const shouldRaiseFlag =
    level === 'FATAL' ||
    (level === 'WARN' && (hedge >= 3 || generic >= 2 || (!hasFlagshipSign && blandPressure >= 3)));

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
