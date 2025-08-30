// ざっくりヒューリスティクス: 後でモデル判定に差し替え可能
export type Layer = "I1" | "I2" | "I3" | "T1" | "T2" | "T3";
export type QCode = `Q${number}`;            // 例: Q1..Q13 など任意
export type Analysis = {
  qcodes: { code: QCode; score: number }[];
  layers: { layer: Layer; score: number }[];
  keywords: string[];
};

const Q_PATTERNS: Array<[QCode, RegExp]> = [
  ["Q1", /(不安|焦り|焦燥|ソワソワ)/i],
  ["Q2", /(葛藤|対立|矛盾)/i],
  ["Q3", /(手放す|解放|浄化)/i],
  ["Q4", /(再定義|意味づけ|解釈)/i],
  ["Q5", /(創造|新しい|始める)/i],
  // ...必要に応じて拡張
];

const LAYER_HINTS: Array<[Layer, RegExp]> = [
  ["I1", /(意図|目的|ねらい|どうしたい)/i],
  ["I2", /(集合|つながり|他者|関係|場)/i],
  ["I3", /(使命|原型|OS|核|本質)/i],
  ["T1", /(静けさ|沈黙|空|無)/i],
  ["T2", /(境界|超える|次元|超越)/i],
  ["T3", /(真実|姿勢|体現|確信)/i],
];

export function analyzeUserText(text: string): Analysis {
  const qMatches = Q_PATTERNS
    .map(([code, rx]) => ({ code, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0);

  const lMatches = LAYER_HINTS
    .map(([layer, rx]) => ({ layer, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0);

  // キーワード抽出（とりあえず単純化）
  const tokens = Array.from(new Set(
    text.toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .split(/\s+/).filter(Boolean)
  ));

  // スコアの正規化 & 上位K
  const topQ = qMatches.slice(0, 3);
  const topL = lMatches.slice(0, 2);

  return { qcodes: topQ as any, layers: topL as any, keywords: tokens.slice(0, 20) };
}
