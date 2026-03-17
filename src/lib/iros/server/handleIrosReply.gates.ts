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

    // ✅ 既存ログ/参照互換（使っていなくても0で返す）
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
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const re = p.global ? p : new RegExp(p.source, flags);
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

// ✅ 「?」だけでなく、?なし疑問文も qCount に入れる（ただし暴発しないように厳密化）
// - JS の \W は日本語で暴発するので使わない
// - “文末” を正規化してから末尾だけを見る
// ✅ 二重カウント防止：その行に ?/？ があるなら like 判定しない
function countQuestionLike(text: string): number {
  const t = norm(text);

  // 1) 記号は従来どおり
  const markCount = (t.match(/[？?]/g) ?? []).length;

  // 2) ?なし疑問文（日本語）を検出して加算
  const lines = t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let likeCount = 0;

  for (const line of lines) {
    // ✅ この行に ? / ？ があるなら二重カウントしない
    if (/[？?]/.test(line)) continue;

    // ✅ 文末を正規化：句読点/感嘆/三点/全角半角スペース/絵文字っぽい記号を落とす
    const tail = line
      .replace(/[。．\.！!…]+$/g, '')
      .replace(/[ \t\u3000]+$/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}]+$/gu, '') // 絵文字レンジ（ざっくり）
      .trim();

    if (!tail) continue;

    const hasWh =
      /(どう(すれば|したら)?|なぜ|なんで|何(が|を|の)?|どこ|いつ|どれ|どんな|誰|誰が|誰に)/.test(tail);

    // ✅ “末尾だけ” で判定（\W を使わない）
    const endsLikeQuestion =
      /(ですか|ますか|でしょうか)$/.test(tail) ||
      /かな$/.test(tail) ||
      /か$/.test(tail) ||
      /の$/.test(tail);

    const askLike =
      /(教えて|教えてください|聞かせて|聞かせてください|話して|話してみて|詳しく)/.test(tail);

    if (hasWh || endsLikeQuestion || askLike) likeCount += 1;
  }

  return markCount + likeCount;
}


// ✅ normalChat 判定（キーで判断）
// - normalChat: SEED_TEXT / OBS / SHIFT が並ぶ（あなたの現行 normalChat.ts 構成）
// - flagReply は FLAG_ だらけ
function isNormalChatLite(ctx?: FlagshipGuardContext | null): boolean {
  const keys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  if (keys.length === 0) return false;

  const hasSeed = keys.includes('SEED_TEXT');
  const hasObs = keys.includes('OBS');
  const hasShift = keys.includes('SHIFT');

  const isFlag = keys.every((k) => String(k).startsWith('FLAG_'));

  return !isFlag && hasSeed && hasObs && hasShift;
}

export function flagshipGuard(input: string, ctx?: FlagshipGuardContext | null): FlagshipVerdict {
  const t = norm(input);

  const reasons: string[] = [];
  const normalLite = isNormalChatLite(ctx);

  // ✅ qCount: normalChat は「?の数だけ」/ それ以外は “疑問文推定込み”
  const qCountMark = (t.match(/[？?]/g) ?? []).length;
  const qCountStrict = countQuestionLike(t);
  const qCount = normalLite ? qCountMark : qCountStrict;

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

  // ✅ normalChat は scaffoldMustHave を強く当てない（浅い会話を通す）
  if (!normalLite && mh.scaffoldLike) {
    if (mh.purposeNeedle && !hasPurpose) reasons.push('SCAFFOLD_PURPOSE_MISSING');
    if (mh.onePointNeedle && !hasOnePoint) reasons.push('SCAFFOLD_ONE_POINT_MISSING');
    if (mh.points3Needles.length > 0 && !hasPoints3) reasons.push('SCAFFOLD_POINTS3_NOT_PRESERVED');
  }

  // ---------------------------------------------
  // 補助：文字列判定（最後の手段）
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
    /(?:^|[^\p{L}\p{N}])かも(?:$|[^\p{L}\p{N}])/gu,
    /可能性(?:がある|あります|があります)?/gu,
    /だろう/gu,
    /でしょう/gu,
    /気がする/gu,
    /気がします/gu,
    /と思う/gu,
    /と思います/g,
    /(?:見えて|分かって)くるかもしれない/g,
    /ように/g,
    /できるかもしれ/g,
    /してみて/gu,
    /してみる/gu,
    /してみると/gu,
    /考えてみて/gu,
    /考えてみる/gu,
    /考えてみると/gu,
    /見つめてみて/gu,
    /見つめてみる/gu,
  ];

  const GENERIC = [
    /ことがある/u,
    /一つの手/u,
    /整理してみる/u,
    /きっかけになる/u,
    /自然に/u,
    /考えてみると/u,
    /見えてくる/u,
    /明確にする/u,
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

  const cheer = countMatches(t, CHEER);
  const hedge = countMatches(t, HEDGE);
  const generic = countMatches(t, GENERIC);
  const hasFlagshipSign = hasAny(t, FLAGSHIP_SIGNS);

  // ---------------------------------------------
  // スコア化
  // ---------------------------------------------
  let fatal = 0;
  let warn = 0;

  // ✅ 質問の扱い
  if (normalLite) {
    if (qCount >= 3) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount === 2) {
      warn += 1;
      reasons.push('QCOUNT_TWO');
    } else if (qCount === 1) {
      reasons.push('QCOUNT_ONE');
    }
  } else {
    if (qCount >= 2) {
      fatal += 2;
      reasons.push('QCOUNT_TOO_MANY');
    } else if (qCount === 1) {
      warn += 1;
      reasons.push('QCOUNT_ONE');
    }
  }

  // ✅ scaffoldLike で must-have が欠けたら FATAL（構造維持失敗）
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

  // --- 補助ルール ---
  if (cheer >= 2) {
    warn += 2;
    reasons.push('CHEER_MANY');
  } else if (cheer === 1) {
    warn += 1;
    reasons.push('CHEER_PRESENT');
  }

  if (hedge >= 2) {
    if (!normalLite) fatal += 2;
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

  // ✅ hedge + generic の同居は “汎用逃げ”（normalChatは除外）
  if (!normalLite && hedge >= 1 && generic >= 1) {
    fatal += 2;
    reasons.push('HEDGE_GENERIC_PAIR');
  }

  const blandPressure = cheer + hedge + generic;

  if (!mh.scaffoldLike && !hasFlagshipSign && blandPressure >= 4) {
    fatal += 2;
    reasons.push('NO_FLAGSHIP_SIGN_WITH_BLAND_PRESSURE');
  }

  if (!mh.scaffoldLike && t.length <= 160 && qCount === 1 && !hasFlagshipSign && cheer + hedge >= 2) {
    fatal += 2;
    reasons.push('SHORT_GENERIC_CHEER_WITH_QUESTION');
  }

  const slotKeys = Array.isArray(ctx?.slotKeys) ? ctx!.slotKeys!.map(String) : [];
  const isFlagReplyLike = slotKeys.length > 0 && slotKeys.every((k) => String(k).startsWith('FLAG_'));

  let level: FlagshipVerdict['level'] = 'OK';

  const warnThreshold = normalLite ? 4 : mh.scaffoldLike || isFlagReplyLike ? 2 : 3;

  if (fatal >= 2) level = 'FATAL';
  else if (warn >= warnThreshold) level = 'WARN';

  const ok = level !== 'FATAL';

  const shouldRaiseFlag =
    level === 'FATAL' ||
    (level === 'WARN' &&
      (reasons.includes('SCAFFOLD_POINTS3_NOT_PRESERVED') ||
        reasons.includes('SCAFFOLD_PURPOSE_MISSING') ||
        reasons.includes('SCAFFOLD_ONE_POINT_MISSING') ||
        reasons.includes('HEDGE_GENERIC_PAIR') ||
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

      // ✅ 互換: 今は数えないので0
      runaway: 0,
      exaggeration: 0,
      mismatch: 0,
      retrySame: 0,
    },
    reasons,
    shouldRaiseFlag,
  };
}
// --- greeting gate -------------------------------------------------
// ✅ greeting-only input を “素材” に変換する（判断しない）
// - ここは gate 層（handleIrosReply.gates.ts）に示す
// - 上位で「このターンもLLM整形に流す」ための印も返す
export async function runGreetingGate(args: any): Promise<{
  ok: boolean;
  result: string | null;
  metaForSave: any | null;
}> {
  const norm2 = (s: any) =>
    String(s ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const userText = norm2(args?.userText ?? args?.text ?? args?.input_text ?? args?.lastUserText ?? '');

  // 記号・空白・絵文字を落とした core
  const core = userText
    .replace(/[。．.!！?？\s]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '');

  if (!core) return { ok: false, result: null, metaForSave: null };

  // =========================================================
  // 1) identity question gate
  // - 最優先で拾う
  // - 「あなたの名前は？」「お名前は？」「君の名前は？」系
  // =========================================================
  const isIdentityQuestion =
    /^(?:あなた|君|きみ|おまえ|あんた)?(?:の)?(?:お?名前|名前)(?:は|って)?$/u.test(core) ||
    /^(?:あなた|君|きみ|おまえ|あんた)(?:のお?名前|の名前|は誰|って誰)$/u.test(core) ||
    /^(?:name|yourname|whatsyourname|whatisyourname)$/iu.test(core);

  if (isIdentityQuestion) {
    const seed =
      `私は Iros。\n\n` +
      `あなたの言葉を整理して、いま起きていることを見える形にする対話エンジンだよ。`;

    const slots = [
      { key: 'OBS', role: 'assistant', style: 'soft', content: '私は Iros。' },
      { key: 'SEED_TEXT', role: 'assistant', style: 'soft', content: seed },
    ];

    const framePlan = {
      slotPlanPolicy: 'FINAL',
      slots,
    };

    return {
      ok: true,
      result: seed,
      metaForSave: {
        gate: 'identity',
        prefer_llm_writer: true,
        framePlan,
        slotPlan: {
          slotPlanPolicy: 'FINAL',
          slots,
        },
        slotPlanPolicy: 'FINAL',
        slotPlanLen: slots.length,
        extra: {
          slotPlanPolicy: 'FINAL',
          slotPlanLen: slots.length,
          ctxPack: {
            shortSummary: 'identity_question',
          },
          framePlan,
          slotPlan: {
            slotPlanPolicy: 'FINAL',
            slots,
          },
        },
      },
    };
  }

  // =========================================================
  // 2) greeting-only gate
  // =========================================================
  const hit =
    (/^(こんばんは|今晩は)$/u.test(core) && 'こんばんは。') ||
    (/^(こんにちは)$/u.test(core) && 'こんにちは。') ||
    (/^(おはよう|おはようございます)$/u.test(core) && 'おはようございます。') ||
    (/^(はじめまして|初めまして)$/u.test(core) && 'はじめまして。') ||
    (/^(よろしく|宜しく)$/u.test(core) && 'よろしく。') ||
    (/^(よろしくお願いします|宜しくお願いします)$/u.test(core) && 'よろしくお願いします。') ||
    (/^(よろしくお願いいたします|宜しくお願いいたします)$/u.test(core) && 'よろしくお願いいたします。') ||
    (/^(hi|hello)$/iu.test(core) && 'こんにちは。') ||
    null;

  if (!hit) return { ok: false, result: null, metaForSave: null };

  const seed =
    `${hit}\n\n` +
    `いまは「ひとこと」だけでも、テーマからでも始められます。🪔\n\n` +
    `そのまま続けて、いま出せる言葉を置いてください。`;

  const slots = [
    { key: 'OBS', role: 'assistant', style: 'soft', content: hit },
    { key: 'SEED_TEXT', role: 'assistant', style: 'soft', content: seed },
  ];

  const framePlan = {
    slotPlanPolicy: 'FINAL',
    slots,
  };

  return {
    ok: true,
    result: seed,
    metaForSave: {
      gate: 'greeting',
      prefer_llm_writer: true,
      framePlan,
      slotPlan: {
        slotPlanPolicy: 'FINAL',
        slots,
      },
      slotPlanPolicy: 'FINAL',
      slotPlanLen: slots.length,
      extra: {
        slotPlanPolicy: 'FINAL',
        slotPlanLen: slots.length,
        ctxPack: {
          shortSummary: 'greeting',
        },
        framePlan,
        slotPlan: {
          slotPlanPolicy: 'FINAL',
          slots,
        },
      },
    },
  };
}
