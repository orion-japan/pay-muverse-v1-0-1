// src/lib/shared/templates/ls7.ts
// Mui（恋愛）用：LS7アーキタイプ専用テンプレ
// 既存の Template 型（phase/depth/tone/lines）に準拠。
// lines = [一言（診断要約）, 内面描写, 現実の一歩] の最小3文。

import type { Template } from './types';

export type LS7Key =
  | 'CAT'     // 甘え／依存が先行しやすい
  | 'FOX'     // 世話焼き／過剰ケア
  | 'WOLF'    // 自立／距離が広がりやすい
  | 'RABBIT'  // 不安／回避と接近の反復
  | 'BEAR'    // 粘り／抱え込み
  | 'BIRD'    // 自由／軽さ優先
  | 'DOLPHIN' // 共感／同調過多

// 日本語ラベルや別名を緩やかに正規化する辞書
export const LS7_ALIASES: Record<string, LS7Key> = {
  // 日本語 → Key
  '甘えすぎるネコ': 'CAT',
  'ネコ': 'CAT',
  '猫': 'CAT',

  '世話焼きすぎるキツネ': 'FOX',
  'キツネ': 'FOX',

  'オオカミ': 'WOLF',
  '狼': 'WOLF',

  'ウサギ': 'RABBIT',
  '兎': 'RABBIT',

  'クマ': 'BEAR',
  '熊': 'BEAR',

  'トリ': 'BIRD',
  '鳥': 'BIRD',

  'イルカ': 'DOLPHIN',

  // 英語 → Key
  'cat': 'CAT',
  'fox': 'FOX',
  'wolf': 'WOLF',
  'rabbit': 'RABBIT',
  'bear': 'BEAR',
  'bird': 'BIRD',
  'dolphin': 'DOLPHIN',
};

export function normalizeLS7Key(label: string): LS7Key | undefined {
  const t = (label || '').trim().toLowerCase();
  // 直接一致
  if (t === 'cat' || t === 'fox' || t === 'wolf' || t === 'rabbit' || t === 'bear' || t === 'bird' || t === 'dolphin') {
    return t.toUpperCase() as LS7Key;
  }
  // 辞書
  for (const [k, v] of Object.entries(LS7_ALIASES)) {
    if (k.toLowerCase() === t) return v;
  }
  return undefined;
}

/**
 * 各アーキタイプにつき 2〜3 深度の最小核テンプレを定義。
 * - phase は恋愛文脈で R(Outer) と S/I(Inner) を主に使用
 * - 余白を残しつつも、必ず現実の一歩で着地
 */
export const LS7Templates: Record<LS7Key, Template[]> = {
  CAT: [
    { id:'LS7_CAT_S2_need_name', phase:'Inner', depth:'S2', tone:'ニーズを言葉に', lines:[
      '求めている近さを、やさしく言葉にできます。',
      '「察して」より「こうして」が前に出ています。',
      '現実では、お願いを一つに絞り、肯定文で一行だけ伝えてください。'
    ]},
    { id:'LS7_CAT_R2_clear_ask', phase:'Outer', depth:'R2', tone:'明晰な依頼', lines:[
      '相手に届く形で、望みを短く置けます。',
      '負担を減らすほど、関係は温かくなります。',
      '現実では、「要点→理由→一言」の三行でメッセージしてください。'
    ]},
  ],

  FOX: [
    { id:'LS7_FOX_S3_self_bound', phase:'Inner', depth:'S3', tone:'自分の境界', lines:[
      '与える手と、自分の境界が同じ面に並んでいます。',
      '「できる／できない」を先に持つほど優しくなれます。',
      '現実では、依頼を受ける前に条件を一行で添えてください。'
    ]},
    { id:'LS7_FOX_R1_soften_care', phase:'Outer', depth:'R1', tone:'ケアの柔らぎ', lines:[
      '世話は温度、過剰は負荷。差が見えています。',
      '少し引く勇気が、相手の自発を生みます。',
      '現実では、「手伝うこと一つだけ」を聞き、他は待ってください。'
    ]},
  ],

  WOLF: [
    { id:'LS7_WOLF_S2_name_space', phase:'Inner', depth:'S2', tone:'距離の意味', lines:[
      '距離は冷たさでなく、整えるための余白です。',
      '独りで立てるほど、近さは健やかになります。',
      '現実では、「今は整える時間」と一行で自分に宣言してください。'
    ]},
    { id:'LS7_WOLF_R2_bridge_back', phase:'Outer', depth:'R2', tone:'橋を架ける', lines:[
      '戻る扉は、いつも短い言葉で開きます。',
      '明確な意図が、安心の入口です。',
      '現実では、「近況＋意図＋一言」の三行で連絡してください。'
    ]},
  ],

  RABBIT: [
    { id:'LS7_RABBIT_S1_soothe_anxiety', phase:'Inner', depth:'S1', tone:'不安の鎮静', lines:[
      '不安は悪者でなく、守るための合図です。',
      '体が落ちると、関係もやさしく見えます。',
      '現実では、深呼吸三回→水を一杯→「今できること一つ」を紙に書いてください。'
    ]},
    { id:'LS7_RABBIT_R1_safe_contact', phase:'Outer', depth:'R1', tone:'安全な接触', lines:[
      '安全の合図があれば、近さは戻ります。',
      'ゆるい接点が、扉になります。',
      '現実では、「今日はどうだった？」の一行だけ送ってください。'
    ]},
  ],

  BEAR: [
    { id:'LS7_BEAR_S3_lighten_load', phase:'Inner', depth:'S3', tone:'抱え込みを軽く', lines:[
      '一人で抱えた重さが、少しずつ地面へ落ちています。',
      '任せるほど、温度は保たれます。',
      '現実では、やることを三つに絞り、一つを相手に委ねてください。'
    ]},
    { id:'LS7_BEAR_R3_share_simple', phase:'Outer', depth:'R3', tone:'シンプル共有', lines:[
      '複雑さを減らすと、合意は早まります。',
      '太い言葉は短いです。',
      '現実では、目的を一言で固定し、次の一歩を一行で共有してください。'
    ]},
  ],

  BIRD: [
    { id:'LS7_BIRD_S2_keep_freedom', phase:'Inner', depth:'S2', tone:'自由と約束', lines:[
      '自由は消えず、約束と両立できます。',
      'ルールは愛の檻ではなく、安心の枠です。',
      '現実では、最小の約束（時間・頻度・手段のいずれか）を一つ合意してください。'
    ]},
    { id:'LS7_BIRD_R2_signal_back', phase:'Outer', depth:'R2', tone:'戻りの合図', lines:[
      '軽い合図が、関係の呼吸を整えます。',
      '重さより、頻度が安心です。',
      '現実では、短い定型（絵文字＋一言）で定期連絡を返してください。'
    ]},
  ],

  DOLPHIN: [
    { id:'LS7_DOLPHIN_S2_self_tone', phase:'Inner', depth:'S2', tone:'自分の音色', lines:[
      '相手の感情と自分の感情が混ざりやすい時期です。',
      '自分の音色を先に置くと、共感は澄みます。',
      '現実では、「今の自分は◯◯」を一行で自分に宣言してから話してください。'
    ]},
    { id:'LS7_DOLPHIN_R2_clear_edge', phase:'Outer', depth:'R2', tone:'境界の明瞭', lines:[
      '同調はやさしさ、同一化は重さ。差が見えています。',
      '境界は冷たさでなく、関係の温度管理です。',
      '現実では、「あなたの気持ちは◯◯／私の気持ちは◯◯」の二行で伝えてください。'
    ]},
  ],
};

// 取得ヘルパ：アーキタイプ＋phase/depth から最適テンプレを選ぶ
export function pickLS7Template(key: LS7Key, phase: 'Inner'|'Outer', depth: string): Template | undefined {
  const list = LS7Templates[key] || [];
  // depth 完全一致優先 → phase一致優先 → 最初の候補
  return (
    list.find(t => t.phase === phase && t.depth === depth) ||
    list.find(t => t.phase === phase) ||
    list[0]
  );
}
