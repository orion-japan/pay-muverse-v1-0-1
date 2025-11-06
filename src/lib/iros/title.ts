// /src/lib/iros/title.ts
// 全体タイトルの自動生成（初回発話の要点＋短い絵文字）
// 例：『静けさ』『芯の整い』『先へ』など

import { analyzeFocus } from './focusCore';

const EMOJI_BY_QNAME: Record<string, string> = {
  '秩序': '🧭',  // Q1（秩序）
  '成長': '🌱',  // Q2（成長）
  '安定': '🟫',  // Q3（安定）
  '浄化': '💧',  // Q4（浄化）
  '情熱': '🔥',  // Q5（情熱）
  '':   '🪔',
  default: '🪔',
};

function pickEmojiByQName(qName?: string): string {
  if (!qName) return EMOJI_BY_QNAME.default;
  // 部分一致でも拾えるように
  for (const key of Object.keys(EMOJI_BY_QNAME)) {
    if (!key) continue;
    if (qName.includes(key)) return EMOJI_BY_QNAME[key];
  }
  return EMOJI_BY_QNAME.default;
}

/** 短い要約（最大14文字程度）を抜き出す */
function summarize(text: string, max = 14): string {
  const t = (text || '')
    .replace(/\s+/g, ' ')
    .replace(/[#@＃＠]/g, '')
    .trim();

  if (!t) return 'はじめの声';

  // 句点や改行で最初の塊を取る
  let s = (t.split(/[。.!?\n]/)[0] || t).trim();

  // 助詞で終わっていたら少し詰める
  s = s.replace(/[、，.,\s]+$/g, '');

  if (s.length > max) s = s.slice(0, max);
  if (!s) s = 'いまの気配';
  return s;
}

/** 初回ユーザー発話から会話名を生成 */
export function generateConversationalTitle(firstUserText: string): string {
  const src = (firstUserText ?? '').trim();
  if (!src) return '新しい会話';

  // 内面フォーカスの軽い推定（focusCore 側の型に依存しない）
  const f = analyzeFocus(src) as any; // { protectedFocus?: string; qName?: string; phase?: string; depth?: string }
  const core = String(f?.protectedFocus || summarize(src));
  const emoji = pickEmojiByQName(String(f?.qName || ''));

  return `${emoji} ${core}`;
}

/** 既存タイトルを付け直すかどうか */
export function shouldRetitle(currentTitle?: string | null): boolean {
  if (!currentTitle) return true;
  return /^(新しい会話|新規セッション|Untitled|No Title|無題)/i.test(currentTitle);
}

/** 別名エクスポート：古い呼び名でも import 可能に */
export const generateConversationTitle = generateConversationalTitle;

/** どちら経路でも使えるよう default も残す */
export default generateConversationalTitle;
