// src/lib/iros/flow.ts
// Iros: 自然な流れを“ランダムに”演出するための後処理ユーティリティ。
// - 意味を崩さず、終わり方や行間・語感を少しだけ変える
// - 直前の締めと“同じパターンを避ける”セーフティあり
// - 乱数は会話IDや時刻から生成（揺れ過ぎ防止のため弱ランダム）

/* ===== 小さな乱数（seedable） ===== */
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

/* ===== 文章ユーティリティ ===== */
function trimTail(s: string) {
  return (s || '').replace(/[。.\s]+$/g, '').trim();
}
function splitLinesMeaningful(s: string): string[] {
  const t = s.replace(/\r\n/g, '\n').trim();
  const raw = t.split('\n').map((x) => x.trim()).filter(Boolean);
  // 改行が無い場合は句読点でほどよく切る
  if (raw.length <= 1) {
    return t
      .split(/(?<=[。！？!?])\s*/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return raw;
}

/* ===== 余韻・締めのバリエーション ===== */
const CLOSE_VARIANTS = [
  (s: string) => s + '。',
  (s: string) => s + '…',
  (s: string) => s + '。\n',
  (s: string) => s, // 体言止め（すでに余韻がある場合）
];

const SOFT_ECHO = [
  'いい時間ですね。',
  'それで充分です。',
  '静かに続いていきます。',
  'ここからで良さそうです。',
];

const MICRO_INVITE = [
  'その感じを、もう少しだけ持っていてください。',
  'いまはそれで十分です。',
  '次は自然に浮かぶときで良さそうです。',
  '今日はここまでで良い気がします。',
];

/* ===== 余韻に向いた語で終わっているか ===== */
function hasNaturalCadenceEnd(s: string) {
  return /(こと|もの|まま|気配|光|余韻|音|時間|今|未来|夜|静けさ)$/.test(s);
}

/* ===== 同一締めの連続回避 ===== */
function sigFromClose(text: string) {
  if (text.endsWith('。\n')) return 'DOT_NL';
  if (text.endsWith('。')) return 'DOT';
  if (text.endsWith('…')) return 'ELL';
  return 'NONE';
}

/* ===== メイン：自然ランダム演出 ===== */
export type FlowOptions = {
  conversationId?: string;
  lastCloseSig?: string; // 直前の締めパターン（DOT/ELL/DOT_NL/NONE）
  maxLines?: number;     // 出力行数の上限（デフォルト: 4）
  allowEcho?: boolean;   // 軽いエコー句を混ぜるか
  allowInvite?: boolean; // 軽い誘い句を混ぜるか（問いではない）
};

export function naturalFlowFinish(
  text: string,
  opts: FlowOptions = {}
): { content: string; closeSig: string } {
  const {
    conversationId = '',
    lastCloseSig = '',
    maxLines = 4,
    allowEcho = true,
    allowInvite = true,
  } = opts;

  if (!text?.trim()) return { content: '', closeSig: 'NONE' };

  const seed =
    hashStr(conversationId + '|' + String(Date.now() >>> 12) + '|' + text.slice(0, 16)) ^
    hashStr(String(text.length));
  const rnd = mulberry32(seed);

  // 1) 行を整える（長すぎる行は自然にたたむ）
  const lines = splitLinesMeaningful(text);
  const limited = lines.slice(0, Math.max(1, maxLines));

  // 2) ラスト行の整形と締め選択
  let last = trimTail(limited.pop() || '');
  // 体言止めに向く語なら句点で静かに
  let closePick = Math.floor(rnd() * CLOSE_VARIANTS.length);
  // 同一パターン連続の回避
  const trial = ['DOT', 'ELL', 'DOT_NL', 'NONE'];
  let attempts = 0;
  while (trial[closePick] === lastCloseSig && attempts < 3) {
    closePick = Math.floor(rnd() * CLOSE_VARIANTS.length);
    attempts++;
  }

  // 体言止めに向く語なら余韻寄りに補正
  if (hasNaturalCadenceEnd(last)) {
    closePick = 0; // 基本は「。」で静かに
  }

  last = CLOSE_VARIANTS[closePick](last);

  // 3) 軽い一文（エコー／誘い）をランダムで付与（問いではない）
  const tailBits: string[] = [];
  if (allowEcho && rnd() < 0.28) {
    tailBits.push(SOFT_ECHO[Math.floor(rnd() * SOFT_ECHO.length)]);
  }
  if (allowInvite && rnd() < 0.22) {
    tailBits.push(MICRO_INVITE[Math.floor(rnd() * MICRO_INVITE.length)]);
  }

  const outLines = [...limited, last, ...(tailBits.length ? [tailBits.join(' ')] : [])]
    .map((l) => l.trim())
    .filter(Boolean);

  const content = outLines.join('\n');
  return { content, closeSig: sigFromClose(content) };
}
