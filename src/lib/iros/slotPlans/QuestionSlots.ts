// file: src/lib/iros/slotPlans/QuestionSlots.ts
// iros — Question Slots (HowTo → stance / observation frame)
//
// 目的：
// - 「どうしたら？」系の質問を、答え/方法提示にしない
// - OBS / SHIFT / NEXT / SAFE で“立ち位置が生まれる文章”を作る
// - ただし今回の要求は「完成文を完全固定」なので、本文は ILINE でロックする

export type IrosSlot = {
  key: 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';
  role: 'assistant';
  style?: 'neutral' | 'friendly' | 'soft';
  content: string;
};

function norm(s: string): string {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * HowTo質問かどうかの軽い判定
 * - 「どうしたら」「方法」「には？」など
 * - テーマは問わない（お金/仕事/人間関係 など全部ここに入る）
 */
export function shouldUseQuestionSlots(userText: string): boolean {
  const t = norm(userText);
  if (!t) return false;

  const looksHowTo =
    /どうしたら|どうすれば|方法|には|ためには/.test(t) ||
    /[?？]$/.test(t);

  return looksHowTo;
}

/**
 * Question Slots（完成文固定版）
 * - 完成文は [[ILINE]]...[[/ILINE]] で完全固定（LLMに改変させない）
 * - ここでは「方法の羅列」「実践ステップの提示」「断定的な行動指示」をしない
 * - “見る場所（観測軸）”と“未完了の問い”だけを残す
 */
export function buildQuestionSlots(args: { userText: string }): IrosSlot[] {
  const userText = norm(args.userText);

  // ✅ 完成文（完全固定）
  // - ここを変えたい時は、この文字列を編集する
  // - 必ず [[ILINE]] と [[/ILINE]] を含める（locked ILINE 用）
  const fixed = `[[ILINE]]
とても大きな質問なので、
いちばんシンプルな原理だけ置きます。

お金は
「誰かの困りごと／欲しい未来」が
軽くなった方向へ流れる。
川が低い方へ流れるように、
お金も “価値が生まれた方向へ動くだけ” です。

だから今は、方法を並べません。
代わりに「どこで価値が生まれているか」を見ます。

見る場所は3つだけ。
・誰が困っているか（誰の“重さ”がそこにあるか）
・何が軽くなるか（何が減る／増えると前に進むか）
・それが起きる場面はどこか（いつ／どこで／どんな状況か）

想像しづらいなら、イメージの取っ掛かりを置きます。
たとえば──
時間がない人が多い場面／やり方が分からない場面／不安が強い場面。
あなたの周りで「これが軽くなったら助かる」が出る場所が、
たぶん入口です。

この質問が浮かんだ瞬間、
あなたの周りで “少し動いたもの” は何でしたか？🪔
[[/ILINE]]`;

  return [
    // ✅ 本文は OBS に一本化して固定（locked ILINE）
    { key: 'OBS', role: 'assistant', style: 'neutral', content: fixed },

    // ✅ 残りは “骨格” として保持（将来ブロック展開するならここを使う）
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content:
        '（writer向け）上の ILINE 本文は改変しない。方法提案に広げない。観測の向きだけ保つ。',
    },
    {
      key: 'NEXT',
      role: 'assistant',
      style: 'friendly',
      content:
        '（writer向け）最後の問いはそのまま。答えを急がせないが、問いは濁さない。',
    },
    {
      key: 'SAFE',
      role: 'assistant',
      style: 'soft',
      content:
        '（writer向け）締めの温度は静かに。励ましテンプレ（かもしれない／一つの手）に逃げない。',
    },
  ];
}
