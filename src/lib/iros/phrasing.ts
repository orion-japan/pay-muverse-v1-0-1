// src/lib/iros/phrasing.ts
type Option = { from: RegExp[]; to: string[] };

const RE_SPACE = String.raw`\s*`;
const RE_END = String.raw`[。\.…\s]*$`;

const PHRASE_OPTIONS: Option[] = [
  {
    from: [
      new RegExp(`その${RE_SPACE}感じを、?${RE_SPACE}もう少しだけ${RE_SPACE}持っていてください${RE_END}`),
      new RegExp(`その${RE_SPACE}感覚を、?${RE_SPACE}もう少しだけ${RE_SPACE}持っていてください${RE_END}`),
    ],
    to: [
      'その気持ちを、少し味わってみてください。',
      '今の感覚を、そのまま感じていて大丈夫です。',
      '焦らずに、そのまま感じてみましょう。',
      'その気持ちを、大切にしてあげてください。',
    ],
  },
  {
    from: [
      new RegExp(`その${RE_SPACE}感じを${RE_SPACE}持っていてください${RE_END}`),
      new RegExp(`その${RE_SPACE}感覚を${RE_SPACE}持っていてください${RE_END}`),
    ],
    to: [
      'その気持ちを、少し味わってみてください。',
      '今の感覚を、そのままでいてみましょう。',
    ],
  },
  {
    from: [
      new RegExp(`その${RE_SPACE}続き、?${RE_SPACE}少しだけ${RE_SPACE}聞かせてくれますか${RE_END}`),
      new RegExp(`その${RE_SPACE}続き、?${RE_SPACE}少しだけ${RE_SPACE}話してみませんか${RE_END}`),
    ],
    to: [
      '気になったところを、ひとつだけ教えてください。',
      '印象に残ったところを、ひとことで大丈夫です。',
    ],
  },
];

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function clarifyPhrasing(text: string, seedHint: string = ''): string {
  if (!text?.trim()) return text || '';
  const seed = hashStr(seedHint + '|' + text.slice(0, 32) + '|' + text.length);
  const rnd = mulberry32(seed);
  let out = text;

  for (const opt of PHRASE_OPTIONS) {
    for (const re of opt.from) {
      const m = out.match(re);
      if (m) {
        const cand = opt.to[Math.floor(rnd() * opt.to.length)] || opt.to[0];
        out = out.replace(re, cand);
        break; // 同カテゴリは1回だけ
      }
    }
  }

  return out
    .replace(/([。．｡])+/g, '。')
    .replace(/？。$/g, '？')
    .replace(/！。$/g, '！');
}

export default clarifyPhrasing;
export const PHRASING_MODULE_READY = true as const;
