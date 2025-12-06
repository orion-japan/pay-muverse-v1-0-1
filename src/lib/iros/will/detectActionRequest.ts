// src/lib/iros/will/detectActionRequest.ts
// 「今日できること？」「どうしたらいい？」など、
// 具体的な一歩・行動提案を求めているかどうかを検出するユーティリティ。

/**
 * ユーザーの発話に「今日できること？」「どうしたらいい？」系の
 * “一歩前進リクエスト” が含まれているかどうかを判定する。
 *
 * true になった場合：
 *   - goal.kind を「uncover から step / forward 系」に寄せる
 *   - priority.weights.forward を上げる
 *   - 問い返しより「今日の一歩」提案を優先させる
 * …といった制御に使う想定。
 */
export function detectActionRequest(userText: string | null | undefined): boolean {
  if (!userText) return false;

  const text = userText.trim();
  if (!text) return false;

  // いったんそのまま + 小文字化の両方を用意（英数を含むパターン用）
  const lowered = text.toLowerCase();

  // トリガーフレーズ候補
  // ※まずはシンプルに「含まれていたら true」でOKにしておく
  const patterns: RegExp[] = [
    // 今日・今ベースの問いかけ
    /今日できること/,
    /今日何ができる/,
    /今日やること/,
    /今日やれること/,
    /今できること/,
    /いまできること/,

    // 具体的なアクションを求める系
    /具体的に何をしたら/,
    /具体的にどうしたら/,
    /具体的に何をすれば/,
    /どうしたらいい/,
    /どうすればいい/,

    // 次の一歩・行動フレーズ
    /次に何を/,
    /次は何を/,
    /一歩目/,
    /最初の一歩/,

    // 少し曖昧だけど forward を示しやすいもの
    /今日やるべきこと/,
    /今日やったほうがいいこと/,
  ];

  // 日本語部分は大小文字の差がないので text / lowered のどちらでもほぼ同じだが、
  // 将来、英語フレーズなどを混ぜる可能性を考えて lowered も用意しておく。
  return patterns.some((re) => re.test(text) || re.test(lowered));
}
