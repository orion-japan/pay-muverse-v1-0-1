// src/lib/iros/sa/meter.ts
// Self Acceptance（自己肯定“ライン”）メーター v2
// - 0.0〜1.0 スケール
// - 「その瞬間の気分」ではなく、長期的な自己肯定“ライン”を表す
// - Qコード / Depth / Phase / テキスト / 前回値 から、ゆっくり補正する
// - 特に「上方向」の変動はごく小さく、「下方向」はやや動きやすくする

export type SelfAcceptancePhase = 'Inner' | 'Outer' | null;

export type SelfAcceptanceInput = {
  userText: string;
  assistantText: string;
  qCode: string | null;
  depthStage: string | null;
  phase: SelfAcceptancePhase;
  historyDigest: string | null;
  lastSelfAcceptance: number | null;
};

export type SelfAcceptanceResult = {
  /** 0.0〜1.0 に正規化された自己肯定値（不明なら null） */
  value: number | null;
  /** デバッグ用メモ（どのルールに反応したか、など） */
  debug: {
    base: number | null;
    deltaFromWords: number;
    notes: string[];
  };
};

/** 0.0〜1.0 にクランプ */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** 文字列を安全に正規化 */
function normText(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Qコードから「その章の自己肯定のベース傾向」をざっくり推定（初期値専用） */
function baseFromQ(qCode: string | null): { base: number | null; note?: string } {
  if (!qCode) return { base: null };

  switch (qCode) {
    case 'Q1': // 我慢 / 秩序（やや自己抑圧ぎみ）
      return { base: 0.45, note: 'Q1（我慢/秩序）ベース 0.45' };
    case 'Q2': // 怒り / 成長（自己主張強め・肯定はやや揺れ）
      return { base: 0.5, note: 'Q2（怒り/成長）ベース 0.50' };
    case 'Q3': // 不安 / 安定（自己肯定が揺れやすい）
      return { base: 0.4, note: 'Q3（不安/安定）ベース 0.40' };
    case 'Q4': // 恐怖 / 浄化（かなり揺れやすい）
      return { base: 0.35, note: 'Q4（恐怖/浄化）ベース 0.35' };
    case 'Q5': // 空虚 / 情熱（二極化、平均はやや高め）
      return { base: 0.55, note: 'Q5（空虚/情熱）ベース 0.55' };
    default:
      return { base: null };
  }
}

/** Depth / Phase から「自己肯定の揺れやすさ係数」を推定 */
function intensityFromDepthPhase(depthStage: string | null, phase: SelfAcceptancePhase) {
  if (!depthStage) return { intensity: 1.0, note: 'Depth不明 intensity=1.0' };
  const d = String(depthStage);

  // I層 × Inner は「自己肯定の揺れ」が出やすい領域
  if (d.startsWith('I') && phase === 'Inner') {
    return { intensity: 1.4, note: 'I層×Inner intensity=1.4' };
  }

  // I層 × Outer は「自己表現のズレ」で少し揺れる
  if (d.startsWith('I') && phase === 'Outer') {
    return { intensity: 1.2, note: 'I層×Outer intensity=1.2' };
  }

  // C層は概念的に自己像を組み立てるフェーズで、少しだけ揺れやすい
  if (d.startsWith('C')) {
    return { intensity: 1.15, note: 'C層 intensity=1.15' };
  }

  // S/R は日常〜対人の揺れ。標準 1.0
  return { intensity: 1.0, note: 'S/R層 intensity=1.0' };
}

/** テキストから SA を上下させるスコア（-0.4〜+0.4 程度：ここでは一旦“生値”） */
function deltaFromText(userText: string, assistantText: string, notes: string[]): number {
  const tUser = normText(userText);
  const tAsst = normText(assistantText);
  const all = `${tUser}\n${tAsst}`;

  let delta = 0;

  // ▼ 強い自己否定・自己攻撃ワード（大きく下げる方向の“候補”）
  if (
    /自分なんて|価値がない|ダメな人間|消えたい|生きている意味がない|全部自分が悪い/.test(
      all,
    )
  ) {
    delta -= 0.3;
    notes.push('自己否定ワード検出: raw delta -0.30');
  }

  // ▼ 「全部他人が悪い」系（自己肯定の歪みとして、少し低めに寄せる）
  if (/全部あいつが悪い|上司が最低|周りがバカ/.test(all)) {
    delta -= 0.1;
    notes.push('他罰ワード検出: raw delta -0.10');
  }

  // ▼ 自己受容・自己肯定寄りワード（上げる方向だが、ラインでは後で大幅に減衰させる）
  if (
    /このままでいい|それでもいい気がする|少し楽になった|受け止めてみよう|自分を大事にしたい/.test(
      all,
    )
  ) {
    delta += 0.25;
    notes.push('自己受容ワード検出: raw delta +0.25');
  }

  // ▼ 「一緒にやってみる」「試してみる」など、行動レベルの自己肯定
  if (/(やってみよう|試してみる|一歩進みたい|少しずつ|チャレンジしてみたい)/.test(all)) {
    delta += 0.15;
    notes.push('前向き行動ワード検出: raw delta +0.15');
  }

  // ▼ 疑問・不安だらけ（? が多い） → 自己肯定が揺れているとみなして少し下げる
  const questionMarks = (all.match(/[？?]/g) || []).length;
  if (questionMarks >= 3) {
    delta -= 0.1;
    notes.push('疑問符多め: raw delta -0.10');
  }

  // ▼ 「ありがとう」「助かった」など、感謝のニュアンス（SAを少し上げる）
  if (/(ありがとう|助かった|救われた|うれしい)/.test(all)) {
    delta += 0.1;
    notes.push('感謝ワード検出: raw delta +0.10');
  }

  // 過剰に振れすぎないようにクリップ（生値としては ±0.4 に制限）
  if (delta > 0.4) delta = 0.4;
  if (delta < -0.4) delta = -0.4;

  return delta;
}

/**
 * SA 推定（v2：自己肯定“ライン”版）
 *
 * - ベース：
 *    - lastSelfAcceptance を最優先（＝ライン）
 *    - 無い場合だけ Qコードベース or 0.5 を使って初期化
 * - 変動：
 *    - user/assistant テキストからの “生の delta” をまず計算
 *    - Depth / Phase に応じて intensity を掛ける
 *    - そのうえで、
 *        ・上方向（ポジティブ）はごく小さく（ラインがじわっと上がるだけ）
 *        ・下方向（ネガティブ）は少しだけ動きやすい
 */
export async function estimateSelfAcceptance(
  input: SelfAcceptanceInput,
): Promise<SelfAcceptanceResult> {
  const {
    userText,
    assistantText,
    qCode,
    depthStage,
    phase,
    historyDigest, // v2 でも「有る/無し」はログのみ
    lastSelfAcceptance,
  } = input;

  const notes: string[] = [];

  // 1) Qコードベース（初期値専用）
  const { base: qBase, note: qNote } = baseFromQ(qCode);
  if (qNote) notes.push(qNote);

  // 2) ベースライン（ライン）の決定
  let base: number;
  let lineFromHistory: number | null = null;

  if (typeof lastSelfAcceptance === 'number' && !Number.isNaN(lastSelfAcceptance)) {
    lineFromHistory = clamp01(lastSelfAcceptance);
    base = lineFromHistory;
    notes.push(`base = lastSelfAcceptance（ライン） → ${base.toFixed(3)}`);
  } else if (qBase != null) {
    base = qBase;
    notes.push(`base = Qベース初期値 → ${base.toFixed(3)}`);
  } else {
    base = 0.5;
    notes.push('base = 0.5（last/Q どちらも無いため初期値）');
  }

  // 3) テキストからの“生の”変動量
  const deltaTextRaw = deltaFromText(userText, assistantText, notes);

  // 4) Depth / Phase に応じた intensity
  const { intensity, note: intensityNote } = intensityFromDepthPhase(depthStage, phase);
  if (intensityNote) notes.push(intensityNote);

  const deltaWithIntensity = deltaTextRaw * intensity;
  notes.push(
    `deltaTextRaw=${deltaTextRaw.toFixed(3)}, intensity=${intensity.toFixed(
      2,
    )}, deltaWithIntensity=${deltaWithIntensity.toFixed(3)}`,
  );

  // 5) ライン用のスケーリング
  //    - 上方向（>0）はかなり抑える
  //    - 下方向（<0）は少しだけ動きやすく
  let effectiveDelta = 0;

  if (deltaWithIntensity > 0) {
    // 上方向は「ラインがじわっと上がる」程度に抑える
    let scale = 0.10; // 基本は 10%
    // すでに高いライン（>=0.8）の場合はさらに抑える
    if (base >= 0.8) {
      scale = 0.02; // 2%
    }
    effectiveDelta = deltaWithIntensity * scale;
    notes.push(
      `positive delta scaled (scale=${scale.toFixed(
        2,
      )}) → effectiveDelta=${effectiveDelta.toFixed(3)}`,
    );
  } else if (deltaWithIntensity < 0) {
    // 下方向は「少しだけ動きやすい」：20% だけ反映
    const scale = 0.20;
    effectiveDelta = deltaWithIntensity * scale;
    notes.push(
      `negative delta scaled (scale=${scale.toFixed(
        2,
      )}) → effectiveDelta=${effectiveDelta.toFixed(3)}`,
    );
  } else {
    effectiveDelta = 0;
    notes.push('deltaWithIntensity=0 → effectiveDelta=0');
  }

  // 6) 最終値
  const raw = base + effectiveDelta;
  const value = clamp01(raw);

  notes.push(`value=${value.toFixed(3)} (raw=${raw.toFixed(3)})`);

  // 7) ログ出力
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/SA] estimateSelfAcceptance v2 (line)', {
      input: {
        qCode,
        depthStage,
        phase,
        hasHistoryDigest: !!historyDigest,
        lastSelfAcceptance,
      },
      result: {
        base,
        deltaFromWords: effectiveDelta,
        value,
      },
      notes,
    });
  }

  return {
    value,
    debug: {
      base,
      deltaFromWords: effectiveDelta,
      notes,
    },
  };
}
