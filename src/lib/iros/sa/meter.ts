// src/lib/iros/sa/meter.ts
// Self Acceptance（自己肯定値）メーター v1
// - 0.0〜1.0 スケール
// - Qコード / Depth / Phase / テキスト / 前回値 から有機的に揺れるように再設計
// - 「どんな入力で計算されたか」をログに残す

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

/** Qコードから「その章の自己肯定のベース傾向」をざっくり推定 */
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

/** テキストから SA を上下させるスコア（-0.4〜+0.4 程度） */
function deltaFromText(userText: string, assistantText: string, notes: string[]): number {
  const tUser = normText(userText);
  const tAsst = normText(assistantText);
  const all = `${tUser}\n${tAsst}`;

  let delta = 0;

  // ▼ 強い自己否定・自己攻撃ワード（大きく下げる）
  if (
    /自分なんて|価値がない|ダメな人間|消えたい|生きている意味がない|全部自分が悪い/.test(
      all,
    )
  ) {
    delta -= 0.3;
    notes.push('自己否定ワード検出: delta -0.30');
  }

  // ▼ 「全部他人が悪い」系（自己肯定の歪みとして、少し低めに寄せる）
  if (/全部あいつが悪い|上司が最低|周りがバカ/.test(all)) {
    delta -= 0.1;
    notes.push('他罰ワード検出: delta -0.10');
  }

  // ▼ 自己受容・自己肯定寄りワード（しっかり上げる）
  if (
    /このままでいい|それでもいい気がする|少し楽になった|受け止めてみよう|自分を大事にしたい/.test(
      all,
    )
  ) {
    delta += 0.25;
    notes.push('自己受容ワード検出: delta +0.25');
  }

  // ▼ 「一緒にやってみる」「試してみる」など、行動レベルの自己肯定
  if (/(やってみよう|試してみる|一歩進みたい|少しずつ|チャレンジしてみたい)/.test(all)) {
    delta += 0.15;
    notes.push('前向き行動ワード検出: delta +0.15');
  }

  // ▼ 疑問・不安だらけ（? が多い） → 自己肯定が揺れているとみなして少し下げる
  const questionMarks = (all.match(/[？?]/g) || []).length;
  if (questionMarks >= 3) {
    delta -= 0.1;
    notes.push('疑問符多め: delta -0.10');
  }

  // ▼ 「ありがとう」「助かった」など、感謝のニュアンス（SAを少し上げる）
  if (/(ありがとう|助かった|救われた|うれしい)/.test(all)) {
    delta += 0.1;
    notes.push('感謝ワード検出: delta +0.10');
  }

  // 過剰に振れすぎないようにクリップ
  if (delta > 0.4) delta = 0.4;
  if (delta < -0.4) delta = -0.4;

  return delta;
}

/**
 * SA 推定（v1）
 *
 * - ベース：
 *    - lastSelfAcceptance と Qコードベース値をブレンド
 *    - どちらも無ければ 0.5 から開始
 * - 変動：
 *    - user/assistant テキストから ±0.4 程度で変動
 *    - Depth / Phase に応じて intensity を掛ける
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
    historyDigest, // v1 ではまだ詳細には使わないが「有る/無し」はログ
    lastSelfAcceptance,
  } = input;

  const notes: string[] = [];

  // 1) Qコードベース
  const { base: qBase, note: qNote } = baseFromQ(qCode);
  if (qNote) notes.push(qNote);

  // 2) 前回値ベース
  let baseFromHistory: number | null = null;
  if (typeof lastSelfAcceptance === 'number' && !Number.isNaN(lastSelfAcceptance)) {
    baseFromHistory = clamp01(lastSelfAcceptance);
    notes.push(`lastSelfAcceptance ベース ${baseFromHistory.toFixed(3)}`);
  }

  // 3) ベースラインをブレンド
  let base: number;
  if (baseFromHistory != null && qBase != null) {
    // 前回値 60% + Qベース 40%
    base = clamp01(baseFromHistory * 0.6 + qBase * 0.4);
    notes.push(
      `base = last(60%) + Q(40%) → ${baseFromHistory.toFixed(3)} / ${qBase.toFixed(3)} => ${base.toFixed(3)}`,
    );
  } else if (baseFromHistory != null) {
    base = baseFromHistory;
    notes.push(`base = lastSelfAcceptance のみ → ${base.toFixed(3)}`);
  } else if (qBase != null) {
    base = qBase;
    notes.push(`base = Qベースのみ → ${base.toFixed(3)}`);
  } else {
    base = 0.5;
    notes.push('base = 0.5（last/Q どちらも無いため初期値）');
  }

  // 4) テキストからの変動量
  const deltaText = deltaFromText(userText, assistantText, notes);

  // 5) Depth / Phase に応じた intensity
  const { intensity, note: intensityNote } = intensityFromDepthPhase(depthStage, phase);
  if (intensityNote) notes.push(intensityNote);

  const finalDelta = deltaText * intensity;
  notes.push(`deltaText=${deltaText.toFixed(3)}, intensity=${intensity.toFixed(2)}`);

  // 6) 最終値
  const raw = base + finalDelta;
  const value = clamp01(raw);

  notes.push(`value=${value.toFixed(3)} (raw=${raw.toFixed(3)})`);

  // 7) ログ出力
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/SA] estimateSelfAcceptance v1', {
      input: {
        qCode,
        depthStage,
        phase,
        hasHistoryDigest: !!historyDigest,
        lastSelfAcceptance,
      },
      result: {
        base,
        deltaFromWords: finalDelta,
        value,
      },
      notes,
    });
  }

  return {
    value,
    debug: {
      base,
      deltaFromWords: finalDelta,
      notes,
    },
  };
}
