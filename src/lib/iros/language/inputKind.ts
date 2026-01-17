// src/lib/iros/language/inputKind.ts
// iros — InputKind classifier (shared utility)

import type { InputKind } from './frameSelector';

/**
 * 入力テキストから InputKind を判定する
 * - orchestrator / router / テストで共通利用するために切り出し
 */
export function classifyInputKind(t: string): InputKind {
  const s = (t ?? '').trim();
  if (s.length === 0) return 'unknown';

  // greeting
  if (/^(おはよう|こんにちは|こんばんは|やあ|hi|hello)\b/i.test(s)) return 'greeting';

  // debug / logs
  if (/(error|stack|tsc|typecheck|例外|エラー|ログ|stack trace)/i.test(s)) return 'debug';

  // implementation request
  if (/(実装|修正|追加|削除|変更|接続|差分|diff|SQL|関数|ファイル|orchestrator)/i.test(s))
    return 'request';

  // ✅ recall-check（会話を覚えてる？系）: 質問扱いにすると frame=R でテンプレ化しやすいので chat 扱いに落とす
  // 例: 「会社の話し覚えてる？」「前の話覚えてる？」「さっきの話覚えてる？」「覚えてますか？」
  if (
    /(覚えて(る|ます)|覚えてますか|覚えてる\?|覚えてる？)/.test(s) &&
    /(話|こと|件|それ|この件|前|さっき|昨日|先週|会社)/.test(s)
  ) {
    return 'chat';
  }

  // question
  if (/[？?]$/.test(s) || /(どう|なぜ|何|どれ)/.test(s)) return 'question';

  // micro
  if (s.length <= 8) return 'micro';

  return 'chat';
}
