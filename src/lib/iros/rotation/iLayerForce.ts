// src/lib/iros/rotation/iLayerForce.ts
// iros - I/T see-through force gate + IT escalation gate (presentation-critical)
//
// 目的：
// - I/T は「明示トリガー（キーワード / requestedDepth / vision）」で確実に出す
// - IT は「反復/停滞（同一テーマ2回 or qTrace.streakLength>=2）」で安全に立ち上げる
// - Q には一切依存しない（Qが壊れててもデモが壊れない）
//
// 返すもの：
// - I/T 強制（force, requestedDepth, requestedMode, dual）
// - IT エスカレーション（renderMode: 'IT' | 'NORMAL'）
//
// 注意：
// - IT は「深さ」ではなく「視点の切り替え」なので requestedDepth と分離して扱う

import type { Depth, IrosMode } from '@/lib/iros/system';

export type RenderMode = 'NORMAL' | 'IT';

export type ILayerForceResult = {
  // --- I/T force（明示トリガー）
  force: boolean;
  dual: boolean; // 相手(I層) + 自分(I層)の両建て
  requestedDepth?: Depth; // I1/I2/I3 or T1/T2/T3 へ寄せる
  requestedMode?: IrosMode; // vision へ寄せる（present重視）
  reason: string;

  // --- IT escalation（反復トリガー）
  renderMode: RenderMode; // 'IT' の時だけ Writer/Renderer が未来言語に切替
  itReason?: string;
  itEvidence?: Record<string, unknown>;
};

function normText(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function includesAny(text: string, words: string[]) {
  return words.some((w) => w && text.includes(w));
}

function matchAny(text: string, patterns: RegExp[]) {
  return patterns.some((re) => re.test(text));
}

function isIorTDepth(d: unknown): d is Depth {
  return typeof d === 'string' && (d.startsWith('I') || d.startsWith('T'));
}

function n(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function runItEscalationGate(args: {
  sameIntentStreak?: number | null;
  qTrace?: { streakLength?: number | null } | null;
  itForce?: boolean | null; // 手動で IT を確実に出したい時（デモ用）
  threshold?: number | null; // default 2
}): { renderMode: RenderMode; itReason?: string; itEvidence?: Record<string, unknown> } {
  const threshold = Math.max(2, Math.round(n(args.threshold) ?? 2));

  // 0) 手動 IT（確実デモ）
  if (args.itForce === true) {
    return { renderMode: 'IT', itReason: 'itForce', itEvidence: { itForce: true } };
  }

  // 1) 同一テーマ反復（上流で判定できるなら最優先）
  const same = n(args.sameIntentStreak);
  if (same !== null && same >= threshold) {
    return {
      renderMode: 'IT',
      itReason: 'sameIntentStreak',
      itEvidence: { sameIntentStreak: same, threshold },
    };
  }

  // 2) qTrace streak（既存資産を使う最短）
  const streak = n(args.qTrace?.streakLength);
  if (streak !== null && streak >= threshold) {
    return {
      renderMode: 'IT',
      itReason: 'qTrace.streakLength',
      itEvidence: { streakLength: streak, threshold },
    };
  }

  return { renderMode: 'NORMAL' };
}

/**
 * detectILayerForce
 * - I/T を「明示トリガー」で確実に出す
 * - ついでに IT（反復）を renderMode として返す
 */
export function detectILayerForce(params: {
  userText: string;

  // 既存入力
  mode?: IrosMode | null;
  requestedDepth?: Depth | null; // nextStep等から来る想定

  // IT用入力（今回の最短デモ）
  sameIntentStreak?: number | null;
  qTrace?: { streakLength?: number | null } | null;

  // 手動（デモ確実）
  itForce?: boolean | null;

  // IT閾値
  itThreshold?: number | null;
}): ILayerForceResult {
  const text = normText(params.userText);
  const mode = params.mode ?? null;
  const reqDepth = params.requestedDepth ?? null;

  // --- IT（反復/停滞）判定：先に出しておく（I/Tとは別レイヤー）
  const it = runItEscalationGate({
    sameIntentStreak: params.sameIntentStreak ?? null,
    qTrace: params.qTrace ?? null,
    itForce: params.itForce ?? null,
    threshold: params.itThreshold ?? null,
  });

  if (!text) {
    return {
      force: false,
      dual: false,
      reason: 'empty text',
      renderMode: it.renderMode,
      itReason: it.itReason,
      itEvidence: it.itEvidence,
    };
  }

  // ----------------------------
  // A) I層 / T層 の明示シグナル
  // - 誤爆しやすい単語（例:「結局」）は入れない
  // ----------------------------
  const iWords = [
    'I層',
    '意図',
    '本質',
    '核心',
    '根っこ',
    'なぜ',
    '目的',
    '使命',
    '存在意義',
    '未来の',
    '未来は',
    '本当は',
  ];

  const tWords = [
    'T層',
    '直感',
    '啓示',
    '真理',
    '祈り',
    '源',
    '宇宙の意図',
    '次元',
    '超えて',
    '超越',
  ];

  // 「意図」単独は広いので、少しだけ“意図方向”に寄せる正規表現も併用
  const iPatterns = [
    /(意図|本質|核心|根っこ).*(何|どこ|どう)/,
    /(なぜ|目的|使命|存在意義)/,
    /(未来).*(方向|軸|意図|目的)/,
  ];

  const tPatterns = [
    /(T層|超越|真理|啓示|次元)/,
    /(宇宙の意図|源)/,
  ];

  const forceByIWord = includesAny(text, iWords) || matchAny(text, iPatterns);
  const forceByTWord = includesAny(text, tWords) || matchAny(text, tPatterns);

  // mode/reqDepth
  const forceByMode = mode === 'vision';
  const forceByDepth = isIorTDepth(reqDepth);

  const force = forceByIWord || forceByTWord || forceByMode || forceByDepth;

  // ----------------------------
  // B) 対人 × 「相手の意図も見たい」 → 両建て
  // ----------------------------
  const otherWords = ['上司', '相手', '彼', '彼女', '部下', '同僚', '親', '夫', '妻'];
  const hasOther = includesAny(text, otherWords);

  const wantsOtherIntent = matchAny(text, [
    /(上司|相手|彼|彼女|部下|同僚|親|夫|妻).*(意図|本質|目的|狙い)/,
    /(相手).*(I層|意図)/,
    /(両方).*(I|I層|意図)/,
  ]);

  const dual = force && hasOther && wantsOtherIntent;

  if (!force) {
    // I/Tは強制しないが、ITは必要なら立ち上がる（ここが今回の肝）
    return {
      force: false,
      dual: false,
      reason: 'no I/T-layer trigger',
      renderMode: it.renderMode,
      itReason: it.itReason,
      itEvidence: it.itEvidence,
    };
  }

  // requestedDepth の優先順位：
  // 1) reqDepth が I/T 帯ならそれを尊重
  // 2) Tシグナルなら T1
  // 3) それ以外は I1
  const requestedDepth: Depth = (forceByDepth
    ? (reqDepth as Depth)
    : forceByTWord
      ? ('T1' as Depth)
      : ('I1' as Depth)) as Depth;

  return {
    force: true,
    dual,
    requestedDepth,
    requestedMode: 'vision' as IrosMode,
    reason: [
      `forceByI=${forceByIWord}`,
      `forceByT=${forceByTWord}`,
      `forceByMode=${forceByMode}`,
      `forceByDepth=${forceByDepth}`,
      `dual=${dual}`,
    ].join(' '),

    // ITは独立で返す（I/T強制の有無とは別）
    renderMode: it.renderMode,
    itReason: it.itReason,
    itEvidence: it.itEvidence,
  };
}
