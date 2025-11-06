import type { Template } from './types';

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
    '芯と輪郭が、ゆっくり重なり始めています。',
    '緊張は抜け、姿勢が立ち上がります。',
    '現実では、深呼吸三回→短い一声、の順で着手してください。'
  ]},

  // ---- R (Resonance) ----
  { id:'R1_soften_relation', phase:'Outer', depth:'R1', tone:'関係・柔らぎ', lines:[
    '関わりの輪郭が、やわらかく描き直されています。',
    '理解したい気持ちが奥で灯っています。',
    '現実では、「ありがとう」を最初に渡してください。'
  ]},
  { id:'R2_clear_exchange', phase:'Outer', depth:'R2', tone:'交換・明晰', lines:[
    '伝える力が戻りつつあります。',
    '要点が自然と手前に並びます。',
    '現実では、要点→理由→一言の三行でメッセージを書いてください。'
  ]},
  { id:'R3_align_field', phase:'Outer', depth:'R3', tone:'場の整列', lines:[
    '複数の気配が、一つの方向に揃い始めています。',
    '合意の芽が見えます。',
    '現実では、目的を一言に固定し、次の一手を一行で共有してください。'
  ]},

  // ---- C (Creation) ----
  { id:'C1_seed_light', phase:'Outer', depth:'C1', tone:'種火・始動', lines:[
    '内なる種に、かすかな光が触れています。',
    '小さく始めるほど、流れが進みます。',
    '現実では、素材を一つ選び、試作を一枚だけ残してください。'
  ]},
  { id:'C2_shape_move', phase:'Outer', depth:'C2', tone:'形・推進', lines:[
    '形づくる力が静かに立ち上がっています。',
    '決める感覚が前に出ます。',
    '現実では、三つに絞って配置し、他を一旦置いてください。'
  ]},
  { id:'C3_release_flow', phase:'Outer', depth:'C3', tone:'出力・解放', lines:[
    '溜めていたものが、流れに乗ろうとしています。',
    '外へ出すほど整っていきます。',
    '現実では、三行の投稿（題→一言→余白）で放ってください。'
  ]},

  // ---- I (Intention) ----
  { id:'I1_meaning_drop', phase:'Inner', depth:'I1', tone:'意味・着地', lines:[
    '問いの芯に、静かな光が降りています。',
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
