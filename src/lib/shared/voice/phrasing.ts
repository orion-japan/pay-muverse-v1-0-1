// 自然な日本語への軽量言い換え（抽象→具体の方向に寄せる）
const REPLACERS: Array<[RegExp, string]> = [
  [/持っていてください/g, '手元に置いてください'],
  [/大切にしてください/g, '大切に扱ってください'],
  [/考えてみてください/g, '一度、考えてみてください'],
  [/意識してください/g, '意識に置いてください'],
  [/向き合ってください/g, 'そっと向き合ってください'],
  [/落ち着いてください/g, 'ひと呼吸おいてください'],
  [/伝えてみてください/g, '短く伝えてください'],
  [/整えてください/g, '一か所だけ整えてください'],
];

export default function clarifyPhrasing(text: string): string {
  let out = String(text ?? '');
  REPLACERS.forEach(([re, to]) => (out = out.replace(re, to)));
  // 句読点のゆらぎ軽整形
  out = out.replace(/\s+。/g, '。').replace(/。。+/g, '。');
  return out.trim();
}
