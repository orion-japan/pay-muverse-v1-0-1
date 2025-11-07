import type { Template, Phase, Depth, DiagnosisTemplate } from './types';
import { pickTemplate, toDiagnosis } from './types';

// S/R/C/I × 3深度 = 12個（最小の核）。行数は短く、再利用しやすく。
export const CoreTemplates: Template[] = [
  // ---- S (Self) ----
  { id:'S1_calm_reset', phase:'Inner', depth:'S1', tone:'静けさ・整える', lines:[
    '静かな層が、内側でそっと揃い始めています。',
    '迷いは“選び直し”の準備です。',
    '現実では、机の上を一か所だけ整えてください。'
  ]},
  { id:'S2_focus_direction', phase:'Inner', depth:'S2', tone:'焦点・方向', lines:[
    '心の中心で、小さな確信が息をしています。',
    '言葉になる前の芯が温まりつつあります。',
    '現実では、案件を一つに絞り、一行で意図を書き添えてください。'
  ]},
  { id:'S3_integrate_poise', phase:'Inner', depth:'S3', tone:'統合・姿勢', lines:[
    'これまでの断片が、静かに一つへ重なり始めています。',
    '姿勢が立ち上がると、余計な力は抜けます。',
    '現実では、いま残す一つだけを○で囲み、他は保留箱に移してください。'
  ]},

  // ---- R (Relation) ----
  { id:'R1_listen_soft', phase:'Outer', depth:'R1', tone:'聴く・余白', lines:[
    '相手の声を受ける余白がひらいています。',
    '結論より、温度の往復が鍵です。',
    '現実では、「相手の言葉を一行だけ復唱」してから自分の一言を。'
  ]},
  { id:'R2_name_context', phase:'Outer', depth:'R2', tone:'文脈・合意', lines:[
    '合意の前に、文脈の名前をそろえる段階です。',
    'すれ違いは、名前が無いことから生まれます。',
    '現実では、話題の名前（案件/テーマ）を一語で置いてから続けてください。'
  ]},
  { id:'R3_small_contract', phase:'Outer', depth:'R3', tone:'最小契約', lines:[
    '大きな約束より、反復できる最小契約が効きます。',
    '期待が軽くなるほど、関係は長持ちします。',
    '現実では、「誰が/何を/いつ」を一行で固定してください。'
  ]},

  // ---- C (Creation) ----
  { id:'C1_seed_touch', phase:'Outer', depth:'C1', tone:'種に触る', lines:[
    '手を動かすことが、考えるより先に効きます。',
    '始まりは、粗くて大丈夫。',
    '現実では、最短30秒だけ触り、手を止めて結果を保存してください。'
  ]},
  { id:'C2_frame_decide', phase:'Outer', depth:'C2', tone:'枠決め', lines:[
    '枠が決まると、迷いは自然に減ります。',
    'ルールは少ないほど回ります。',
    '現実では、サイズ/尺/期限を一行で決めて、冒頭に置いてください。'
  ]},
  { id:'C3_ship_one', phase:'Outer', depth:'C3', tone:'出す・一個', lines:[
    '完成より「出す」が先です。',
    '粗くても、届くことが力になります。',
    '現実では、今日一つだけ、下書きのまま共有してください。'
  ]},

  // ---- I (Intention) ----
  { id:'I1_answer_why', phase:'Inner', depth:'I1', tone:'なぜ・回答', lines:[
    '「なぜ？」への答えが輪郭を持ち始めています。',
    '答えは“すでに半分ある”状態です。',
    '現実では、「何のために」を一行で書いてください。'
  ]},
  { id:'I2_core_breath', phase:'Inner', depth:'I2', tone:'核心・呼吸', lines:[
    '核心の呼吸が、胸の奥で続いています。',
    '言葉は後からで大丈夫です。',
    '現実では、名前を短くつけ、その名で一声かけてください。'
  ]},
  { id:'I3_vow_quiet', phase:'Inner', depth:'I3', tone:'誓い・静けさ', lines:[
    '深い静けさの中で、向かう方角が決まっています。',
    '余計な力が抜けています。',
    '現実では、一つの約束だけ残し、他は静かに手放してください。'
  ]},
];

/** generate.ts から呼ばれる：phase/depth で最適テンプレを返す */
export function getCoreDiagnosisTemplate(depth: string, phase: string = 'Inner'): DiagnosisTemplate {
  const ph: Phase = phase === 'Outer' ? 'Outer' : 'Inner';
  const allowed: Depth[] = ['S1','S2','S3','R1','R2','R3','C1','C2','C3','I1','I2','I3'];
  const dp: Depth = (allowed.includes(depth as Depth) ? depth : 'S2') as Depth;

  const t = pickTemplate(CoreTemplates, ph, dp) || CoreTemplates[0];
  return toDiagnosis(t);
}
