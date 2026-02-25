// src/lib/iros/language/normalizeIrosStyleFinal.ts
// iros — Style Normalizer (final)
// 目的: finalAssistantText のテンプレ臭を「語彙置換 + 絵文字制御」で薄める（意味は変えない）
//
// 方針:
// - 置換は “完全一致の句” を部分一致で差し替え（操作語を自然化）
// - 置換回数に上限を持たせ過剰補正を防ぐ
// - 絵文字は安定乱数（seed hash）で 30% のみ残し、連続/行末/重複を抑制
//
// 注意:
// - スロット/レーン/Q帯に依存しない（最終統合点でのみ使用）

export type NormalizeIrosStyleOptions = {
  seed: string; // traceId / conversationId 等（安定乱数）
  emojiKeepRate?: number; // 0.0〜1.0（default: 0.3）
  maxReplacements?: number; // default: 5
};

type DictEntry = { from: string; to: string };

// ✅ 辞書20語（第一版）
const DICT_20: DictEntry[] = [
  // 操作動詞系
  { from: '真ん中に置く', to: 'まず大事にしよう' },
  // NOTE: 「置く」は iros の中核語なので、単体置換はしない（過剰変換になる）
  // { from: '置く', to: '言葉にする' },
  { from: '固定する', to: 'いったん決めてみよう' },
  { from: '圧縮する', to: 'まとめる' },
  { from: '焦点を当てる', to: 'ここを見てみよう' },
  { from: '一語で', to: '一言でいうなら' },
  { from: '言い切りで短く', to: '一文でシンプルに' },
  { from: 'いまは状況より先に', to: 'まずは' },

  // 構造テンプレ臭
  { from: 'どっち。', to: 'どちらに近い？' },
  { from: 'どっち？', to: 'どちらに近い？' },
  { from: '顔がある人', to: '具体的に思い浮かぶ人' },
  { from: '輪郭だけ', to: 'まだイメージ段階' },
  { from: '紙に書くなら', to: 'ノートに書くなら' },
  { from: '一点に置く', to: '一つに絞る' },
  { from: '固める', to: 'いったん整える' },

  // 操作感が透ける語
  { from: 'いま一番前に出てるのは', to: '今いちばん気になっているのは' },
  { from: '固定する構造', to: 'そのまま続いている流れ' },
  { from: '手放したいのに、まだ握ってる', to: '手放したい気持ちと、残っている気持ち' },
  { from: '多段で', to: 'いくつも重なって' },
  { from: '一語で答えるなら', to: 'ひとことで言うなら' },
];

// ------------------------------
// stable hash (FNV-1a 32bit)
// ------------------------------
function hash32FNV1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function shouldKeepEmoji(seed: string, rate: number): boolean {
  const h = hash32FNV1a(seed);
  const p = h % 1000; // 0..999
  return p < Math.floor(rate * 1000);
}

// 絵文字検出（Unicode: Extended_Pictographic）
const RE_EMOJI = /\p{Extended_Pictographic}/gu;

// 絵文字の連続を1個に圧縮
function squeezeConsecutiveEmoji(s: string): string {
  let out = '';
  let prevWasEmoji = false;
  for (const ch of s) {
    const isEmoji = /\p{Extended_Pictographic}/u.test(ch);
    if (isEmoji) {
      if (prevWasEmoji) continue;
      prevWasEmoji = true;
      out += ch;
      continue;
    }
    prevWasEmoji = false;
    out += ch;
  }
  return out;
}

// 同一絵文字の2回目以降を削除（同一turn内）
function dropDuplicateEmoji(s: string): string {
  const seen = new Set<string>();
  let out = '';
  for (const ch of s) {
    const isEmoji = /\p{Extended_Pictographic}/u.test(ch);
    if (!isEmoji) {
      out += ch;
      continue;
    }
    if (seen.has(ch)) continue;
    seen.add(ch);
    out += ch;
  }
  return out;
}

// 行末絵文字の連打抑制：2行連続で行末が絵文字なら2行目以降を除去
function suppressLineEndEmojiRepeats(s: string): string {
  const lines = s.split('\n');
  let prevEndedWithEmoji = false;

  const out = lines.map((line) => {
    const t = String(line ?? '');
    const trimmed = t.replace(/\s+$/g, '');
    const lastChar = trimmed.slice(-1);
    const endsWithEmoji = lastChar ? /\p{Extended_Pictographic}/u.test(lastChar) : false;

    if (endsWithEmoji && prevEndedWithEmoji) {
      // 2行目以降の行末絵文字だけ落とす（行末の絵文字を1文字削る）
      const dropped = trimmed.slice(0, -1);
      prevEndedWithEmoji = false; // ここは「落とした」ので次判定は false 扱い
      return dropped;
    }

    prevEndedWithEmoji = endsWithEmoji;
    return trimmed;
  });

  return out.join('\n');
}

// 置換（過剰補正防止の上限あり）
function applyDictWithCap(text: string, dict: DictEntry[], maxRepl: number): { text: string; replaced: number } {
  let out = text;
  let replaced = 0;

  for (const { from, to } of dict) {
    if (replaced >= maxRepl) break;
    if (!from) continue;
    if (!out.includes(from)) continue;

    // 置換回数を数えながら、全置換する（ただし上限に到達したら打ち止め）
    while (out.includes(from) && replaced < maxRepl) {
      out = out.replace(from, to);
      replaced += 1;
    }
  }

  return { text: out, replaced };
}

export function normalizeIrosStyleFinal(input: unknown, opts: NormalizeIrosStyleOptions): { text: string; meta: any } {
  const raw = String(input ?? '');
  const seed = String(opts?.seed ?? '');
  const emojiKeepRate = typeof opts?.emojiKeepRate === 'number' ? opts.emojiKeepRate : 0.3;
  const maxReplacements = typeof opts?.maxReplacements === 'number' ? opts.maxReplacements : 5;

  let text = raw;

  // A) 辞書置換（20語）
  const a = applyDictWithCap(text, DICT_20, maxReplacements);
  text = a.text;

  // C) 絵文字制御（30% keep + 抑制ルール）
  const hasEmoji = RE_EMOJI.test(text);
  RE_EMOJI.lastIndex = 0;

  let emojiAction: 'none' | 'kept' | 'stripped' = 'none';
  if (hasEmoji) {
    const keep = shouldKeepEmoji(seed, emojiKeepRate);
    if (!keep) {
      text = text.replace(RE_EMOJI, '');
      emojiAction = 'stripped';
    } else {
      // 連続禁止 → 重複禁止 → 行末連打抑制
      text = squeezeConsecutiveEmoji(text);
      text = dropDuplicateEmoji(text);
      text = suppressLineEndEmojiRepeats(text);
      emojiAction = 'kept';
    }
  }

  // 末尾/先頭の過剰スペースだけ整える（文は変えない）
  text = text.replace(/\r\n/g, '\n').trim();

  return {
    text,
    meta: {
      replaced: a.replaced,
      emojiAction,
      emojiKeepRate,
      maxReplacements,
      dictSize: DICT_20.length,
    },
  };
}
