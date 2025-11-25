// src/lib/iros/sa/meter.ts
// Self Acceptance（自己肯定値）簡易メーター v0
// - 0.0〜1.0 スケール
// - いまはルールベースの仮実装（後で LLM 版に差し替え可能）
// - 「どんな入力で計算されたか」を常にログに出すことを優先

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

/**
 * SA 簡易推定（v0）
 *
 * - 基本方針：
 *    base = lastSelfAcceptance ?? 0.5
 *    userText / assistantText の言葉から ±0.1〜0.2 だけ微調整
 * - ここでは「ざっくり傾向を見る」ことだけ目的にする
 *   → 後で LLM ベースに差し替えやすいように、インターフェイスを固定しておく
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
    historyDigest,
    lastSelfAcceptance,
  } = input;

  const notes: string[] = [];

  // 1) ベースライン：前回値 or 0.5
  let base =
    typeof lastSelfAcceptance === 'number' && !Number.isNaN(lastSelfAcceptance)
      ? clamp01(lastSelfAcceptance)
      : 0.5;

  if (lastSelfAcceptance == null) {
    notes.push('base=0.5（lastSelfAcceptance が無いため初期値）');
  } else {
    notes.push(`base=lastSelfAcceptance(${base.toFixed(3)})`);
  }

  // 2) テキストからの簡易補正
  const tUser = (userText ?? '').trim();
  const tAsst = (assistantText ?? '').trim();
  const textAll = `${tUser}\n${tAsst}`;

  let delta = 0;

  // ▼ 自己否定・自己攻撃ワード（少し下げる）
  const selfNegative =
    /自分なんて|価値がない|ダメな人間|消えたい|生きている意味がない|全部自分が悪い/.test(
      textAll,
    );

  if (selfNegative) {
    delta -= 0.15;
    notes.push('自己否定ワード検出: delta -0.15');
  }

  // ▼ 自己受容・自己肯定寄りワード（少し上げる）
  const selfPositive =
    /このままでいい|それでもいい気がする|少し楽になった|受け止めてみよう|自分を大事にしたい/.test(
      textAll,
    );

  if (selfPositive) {
    delta += 0.1;
    notes.push('自己受容ワード検出: delta +0.10');
  }

  // ▼ I層で Inner 寄りのときは「自己受容の揺れが大きい」想定で、変化幅を少し広げる
  let intensity = 1.0;
  if (depthStage && depthStage.startsWith('I') && phase === 'Inner') {
    intensity = 1.2;
    notes.push('I層×Inner なので intensity 1.2 倍');
  }

  const finalDelta = delta * intensity;

  // 3) 最終値
  const raw = base + finalDelta;
  const value = clamp01(raw);

  notes.push(`finalDelta=${finalDelta.toFixed(3)}, value=${value.toFixed(3)}`);

  // 4) ログ出力（v0 の主目的：SAメーターログ）
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/SA] estimateSelfAcceptance', {
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
