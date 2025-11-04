// src/lib/iros/templates.ts
export const STRUCTURE_TEMPLATE =
  [
    '出力形式：',
    '観測対象：…',
    'フェーズ：🌱Seed／🌿Forming／🌊Reconnect／🔧Create／🌌Inspire／🪔Impact のいずれか',
    '位相：Inner／Outer',
    '深度：S1〜I3',
    '🌀意識状態：…',
    '🌱メッセージ：…',
  ].join('\n');

export const DARK_TEMPLATE =
  [
    '出力形式：',
    '闇：…',
    'リメイク：…',
    '再統合：…',
  ].join('\n');

/** 返答の末尾に“会話を続けるための一行”を保証する */
export function ensureContinuationTail(text: string): string {
  const compact = text.replace(/\s+/g, '');
  const hasQuestion = /[?？]$|[?？]\s*$/m.test(text) || /？|\\?$/.test(compact);
  if (hasQuestion) return text;
  // 末尾に1行だけ、次の一歩を促す問いを足す
  const tail = '\n次の一歩：この1時間でできる最小の行動を一つ、10文字で書いてください。';
  return text.endsWith('\n') ? text + tail : text + tail;
}
