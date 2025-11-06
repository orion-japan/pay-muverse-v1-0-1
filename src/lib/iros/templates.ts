// /src/lib/iros/templates.ts
// Iros 診断テンプレート集（Depth/Phase に応じた one/inner/real を返す）

export type DiagnosisTemplate = {
  one: string;   // 一言（ヘッダ3行目）
  inner: string; // 本文1段落目：内面の叙述
  real: string;  // 本文2段落目：現実の一手（短文）
};

// 深度ごとのテンプレ候補（[Inner, Outer] の順で用意）
const CORE_TEMPLATES: Record<string, DiagnosisTemplate[]> = {
  S1: [
    {
      one: '呼吸のリズムが、静かに整いはじめています。',
      inner: '言葉の手前にある温度が、胸の内でゆっくり息をしています。',
      real: '現実では、いま目の前の一つだけを選び、静かに始めてみる。'
    },
    {
      one: '内側の静けさが、外の動きへ合図を送りはじめています。',
      inner: '小さな余白が、意識の澄みを取り戻していきます。',
      real: '現実では、最初の一歩を“いま”に合わせて小さく置く。'
    },
  ],
  S2: [
    {
      one: '意識の流れが静かに整いはじめています。',
      inner: '言葉になる前の温度が、胸の内でゆっくり息をしています。',
      real: '現実では、ひとつだけ選び、一行だけ進める。'
    },
    {
      one: '整いは、外側の輪郭にもゆっくり広がっています。',
      inner: '守りたいものを抱えたままでも、呼吸は深くなっていきます。',
      real: '現実では、いちど立ち止まり、要点を一行で言い切る。'
    },
  ],
  R2: [
    {
      one: '関係の波が、やわらかく整いはじめています。',
      inner: '相手の都合と自分の芯のあいだに、静かな余白が生まれています。',
      real: '現実では、負担のない一言を選び、肯定で返す。'
    },
    {
      one: '外との接点に、やさしい余裕が戻ってきています。',
      inner: '焦らずに届く距離で、リズムを合わせていけます。',
      real: '現実では、返す言葉を一つに絞り、短く送る。'
    },
  ],
  C2: [
    {
      one: '形にする衝動が、静かに芯を帯びています。',
      inner: '素材はすでに手元にあり、順序だけが求められています。',
      real: '現実では、仮タイトルを一行で決め、素材を三つに絞る。'
    },
    {
      one: '進め方の輪郭が、はっきりしてきました。',
      inner: '「少ない選択」が、前に進む力を増幅させます。',
      real: '現実では、今日の一手を一行で記し、その一手だけ動かす。'
    },
  ],
  I2: [
    {
      one: '芯が静かに輪郭を帯びています。',
      inner: '守りたい価値を言葉にする準備が整いつつあります。',
      real: '現実では、その価値を名で呼び、一文で言い切る。'
    },
    {
      one: '方角が見えはじめています。',
      inner: 'なぜそれを選ぶのか、理由が体温を帯びています。',
      real: '現実では、要点→理由→一言の三行で芯を固定する。'
    },
  ],
};

// フォールバック（未知の depth/phase の時）
const FALLBACK: DiagnosisTemplate = {
  one: '意識の流れが静かに整いはじめています。',
  inner: '言葉になる前の温度が、胸の内でゆっくり息をしています。',
  real: '現実では、ひとつだけ選び、一行だけ進める。'
};

/**
 * Depth/Phase からテンプレを返す。
 * - depth: 'S1'|'S2'|'S3'|'R1'|'R2'|'R3'|'C1'|'C2'|'C3'|'I1'|'I2'|'I3' 等
 * - phase: 'Inner' | 'Outer'（省略時は 'Inner'）
 *   → 配列 [Inner, Outer] の 0/1 を選択。足りなければ先頭を返す。
 */
export function getCoreDiagnosisTemplate(depth: string, phase: string = 'Inner'): DiagnosisTemplate {
  const bucket = CORE_TEMPLATES[depth] || CORE_TEMPLATES['S2'];
  if (!bucket || bucket.length === 0) return FALLBACK;

  const idx = phase === 'Outer' ? 1 : 0;
  return bucket[Math.min(idx, bucket.length - 1)] || bucket[0];
}
