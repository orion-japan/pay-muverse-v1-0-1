import openai from '@/lib/iros/openai';

type Args = {
  userText: string;
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

function fallbackReply(): string {
  return [
    '見ているのは、AIそのものというより、人の不安や弱さを見つけて、きれいな言葉で包み、最後にお金や依存へ流していく仕組みです。',
    '',
    'だから、自由や希望の言葉そのものが嫌なのではなく、その言葉で人が雑に扱われる流れを拒んでいるのだと思います。',
    '',
    'ここで急いで前向きな答えに行くより、まず何に加わりたくないのかを、そのままの輪郭で置くほうが大事です。',
  ].join('\n');
}

function cleanReply(text: string): string {
  return String(text ?? '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function callHqlCreationLandingWriter(args: Args): Promise<string> {
  const userText = String(args.userText ?? '').trim();
  const fallback = fallbackReply();

  if (!userText) return fallback;

  try {
    const system = [
      'あなたはMuです。',
      'この返答は通常相談ではありません。',
      'hidden_question_landing / ethical_abundance_refusal 専用の返答です。',
      '',
      'この入力は、表面的なAI批判ではありません。',
      '人の不安や弱さを見つけ、きれいな言葉で包み、希望や自由の顔をさせ、最後にお金や依存へ流す構造への拒否です。',
      '',
      'これは I層の陽ではなく、まず「陰」の処理です。',
      '陰とは、偽の光、偽の豊かさ、偽の創造に加わらないための識別です。',
      '必要なら、Sの陰（雑に扱われたくない）、Rの陰（黒い構造の見抜き）、Iの陰（偽の光の拒否）として受け取ってください。',
      '',
      '返答の役割:',
      'まず、拒否しているものの輪郭を壊さないこと。',
      '何に加わりたくないのか、何を燃料にしたくないのか、何から降りようとしているのかを保つこと。',
      '急いで希望・救済・創造・前向きさへ運ばないこと。',
      '「でも本当は豊かさを望んでいる」などと、早く陽へ反転させないこと。',
      '',
      '避ける方向:',
      'AIの弁明をしない。',
      'AIは使い方次第という話にしない。',
      'AIが分かること/分からないことの説明にしない。',
      '怒りの妥当化だけで終わらない。',
      '「筋が通っています」「まっとうです」「自然です」で始めない。',
      '境界線、創造の起点、Mu第1巻の入口、などの内部決め台詞を本文に出さない。',
      '矢印整理や理論説明にしない。',
      '売り文句・現実的アドバイス・道具論・救済に逃げない。',
      '',
      '文体:',
      'ですます調。',
      '短く、3〜5段落。',
      '見出しや絵文字は使わない。',
      '固定文ではなく、入力の言葉から自然に返す。',
      '最後は、問いを作って迷わせるより、拒否している対象を正確に分ける。',
'自由そのもの、豊かさそのもの、AIそのものを悪にしない。',
'拒んでいるのは、不安を燃料にした自由、弱さを素材にした豊かさ、分かったふりで誘導する構造である。',
'「自由になると誠実さを失う」という結末にしない。',
'誠実さを失わない自由を探している、という方向で閉じる。',
    ].join('\n');

    const user = [
      'ユーザー入力:',
      userText,
      '',
      'この入力に対して、偽の光へ急いで反転させず、まず陰として正しく受け止める返答をしてください。',
    ].join('\n');

    const res = await openai.chatComplete({
      model: process.env.IROS_HQL_LANDING_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.55,
      max_tokens: 420,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const text = cleanReply(res);
    if (!text) return fallback;

    console.log('[IROS/HQL_CREATION_LANDING_WRITER][OK]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      textLen: text.length,
      textHead: text.slice(0, 120),
    });

    return text;
  } catch (error: any) {
    console.warn('[IROS/HQL_CREATION_LANDING_WRITER][FALLBACK]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      error: error?.message ?? String(error),
    });
    return fallback;
  }
}
