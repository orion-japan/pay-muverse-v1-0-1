// src/lib/iros/language/inputKind.ts
// iros — InputKind classifier (shared utility)

import type { InputKind } from './frameSelector';

/**
 * 入力テキストから InputKind を判定する
 * - orchestrator / router / テストで共通利用するために切り出し
 *
 * 方針：
 * - micro は「相槌/了解/短い合図」だけに限定する（短文=micro にしない）
 * - それ以外の短文は chat に落とす（例:「そろそろ眠いや」「一回今日」）
 */
export function classifyInputKind(t: string): InputKind {
  const s0 = (t ?? '').trim();
  if (s0.length === 0) return 'unknown';

  const s = s0.replace(/\s+/g, ''); // 空白ゆらぎ吸収（相槌判定を安定させる）

  // greeting
  if (/^(おはよう|こんにちは|こんばんは|やあ|hi|hello)\b/i.test(s0)) return 'greeting';

  // debug / logs
  if (/(error|stack|tsc|typecheck|例外|エラー|ログ|stack trace)/i.test(s0)) return 'debug';

  // implementation request
  if (/(実装|修正|追加|削除|変更|接続|差分|diff|SQL|関数|ファイル|orchestrator)/i.test(s0))
    return 'request';

  // ✅ recall-check（会話を覚えてる？系）
  if (
    /(覚えて(る|ます)|覚えてますか|覚えてる\?|覚えてる？)/.test(s0) &&
    /(話|こと|件|それ|この件|前|さっき|昨日|先週|会社)/.test(s0)
  ) {
    return 'chat';
  }

  // question という InputKind は廃止（PDF: 4分類へ収束）
  // - 末尾「?」や疑問語は “chat内の性質” として slot/contract で扱う
  if (/[？?]$/.test(s0) || /(どう|なぜ|何|どれ)/.test(s0)) return 'chat';

  // ✅ micro = 相槌・了解・短い合図だけ（短い“内容文”は micro にしない）
  // - 例: はい / うん / そう / 了解 / OK / ありがとう / 👍 / … など
  const isAck =
    /^(はい|うん|うーん|そう|そっか|了解|りょ|ok|おけ|わかった|なるほど|たしかに|ええ|うむ|まじ|ありがとう|サンキュー|thanks|thx)$/.test(
      s.toLowerCase()
    ) ||
    /^[。．…!！]+$/.test(s) ||
    /^[👍🙏🙆‍♂️🙆‍♀️🙆✅☑️]+$/.test(s);

  if (isAck) return 'micro';

  // それ以外は chat（短文でも micro にしない）
  return 'chat';
}
