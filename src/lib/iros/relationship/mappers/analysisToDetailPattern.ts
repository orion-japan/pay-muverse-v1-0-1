// src/lib/iros/relationship/mappers/analysisToDetailPattern.ts

import type { RelationshipAnalysis } from '../schemas/relationshipAnalysisSchema';

export type RelationshipDetailPatternMaterial = {
  block_current_state: string;
  block_misrecognition_negation: string;
  block_structural_reframe: string;

  block_breakdown_core_gap: string;
  block_breakdown_defense: string;
  block_breakdown_rejection_target: string;

  block_reading_direction: string;
  block_concrete_sort_axis: string;
  block_concrete_sort_boundary: string;

  block_conclusion: string;
  block_caution: string;
  block_closing_line: string;
};

function normalizeSentence(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  return /[。！？]$/.test(text) ? text : `${text}。`;
}

export function analysisToDetailPattern(
  analysis: RelationshipAnalysis
): RelationshipDetailPatternMaterial {
  return {
    block_current_state: normalizeSentence(
      analysis.openingFrame,
      'この関係は、近づき方の違いがそのままズレになりやすい関係です。'
    ),

    block_misrecognition_negation: normalizeSentence(
      analysis.friction.hiddenCause,
      '未熟さではなく、守りたい基準と動くタイミングが重なりやすいだけです。'
    ),

    block_structural_reframe: normalizeSentence(
      `強さのぶつかり合いに見えても、実際に重なっているのは ${analysis.coreTension}`,
      '強さの出しどころがぶつかりやすいです。'
    ),

    block_breakdown_core_gap: normalizeSentence(
      `この関係でまず起きやすいのは、${analysis.friction.clashPoint} ことです。表面では意見の違いに見えても、奥では同じ場所に力を置こうとしやすいです。`,
      '互いに譲るより先に動こうとして、正しさの押し合いになりやすいです。'
    ),

    block_breakdown_defense: normalizeSentence(
      `${analysis.traitA.coreDrive} 方向と、${analysis.traitB.coreDrive} 方向が同時に前へ出やすいです。どちらも間違っているのではなく、それぞれが守りたいものを先に出しているだけです。`,
      'それぞれが守りたい基準を先に出しやすいです。'
    ),

    block_breakdown_rejection_target: normalizeSentence(
      `${analysis.translation.seenAtoB} でも本人は、${analysis.translation.intentA} だけです。だから、悪気より先に押し返された感じが立ちやすくなります。`,
      '互いの強さが、そのまま誤解として見えやすいです。'
    ),

    block_reading_direction: normalizeSentence(
      `${analysis.translation.translationKey} ${analysis.reinterpretation.bridgeKey}`,
      '相手を弱いか強いかで見るより、どこで力を使っているかを分けて見ることです。'
    ),

    block_concrete_sort_axis: normalizeSentence(
      `${analysis.reinterpretation.reframeAtoB} こちらに圧や否定として見えていたものも、守ろうとしているものの違いとして読むと変わります。`,
      '強く見える反応は、関係を立て直そうとする力として読むと変わります。'
    ),

    block_concrete_sort_boundary: normalizeSentence(
      `${analysis.reinterpretation.reframeBtoA} そこで見えていた押しの強さを、乱暴さだけで読まないことが鍵になります。`,
      '押して見える反応は、流れを止めずに前へ運びたい力として読むと変わります。'
    ),

    block_conclusion: normalizeSentence(
      `${analysis.roleFit.roleA} 一方で、${analysis.roleFit.roleB} という形で、二人は別の役割を関係に入れやすいです。`,
      'それぞれが別の役割を関係に入れています。'
    ),

    block_caution: normalizeSentence(
      `${analysis.roleFit.synergy} 同じ場所で強さを競わせると重くなりますが、置き場が分かれると一気に噛み合いやすくなります。`,
      '力の置き場が分かれると、押し合いではなく前へ進む力としてまとまりやすくなります。'
    ),

    block_closing_line: normalizeSentence(
      analysis.essenceClose,
      'この関係は、強さを競わせるより、強さの向きを分けたときにいちばん活きます。'
    ),
  };
}
