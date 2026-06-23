import openai from '@/lib/iros/openai';

type Args = {
  userText: string;
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

function fallbackReply(): string {
  return [
    '疑っているのは、AIそのものというより、人の不安を見つけて、きれいな言葉に変えて、最後にお金へ流す構造です。',
    '',
    'だから「自由に生きよう」という言葉も、希望ではなく、誰かの弱さを材料にする言葉に聞こえてしまう。',
    '',
    '本当に問われているのは、そこに飲まれずに、誠実なまま自由や豊かさを生めるのか、ということです。',
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
      '目的:',
      'ユーザーの表面的なAI批判を処理するのではなく、',
      '人の不安を見つけ、きれいな言葉で包み、希望や自由の顔をさせ、最後にお金へ変える構造を映してください。',
      '',
      '必ず向かう先:',
      'その構造に飲まれず、誠実なまま自由や豊かさを生めるのか。',
      '人の不安を使うのではなく、創造の方向から現実を作れるのか。',
      '',
      'MAIN_LANDING_CONCEPT_V21:',
      'Mu第1巻の入口は、人の不安を見つけ、希望の言葉で包み、最後にお金や依存へ流す構造から降りるところにあります。',
      'この構造を内部理解としては「不安の台本」と捉えてよいですが、ユーザー入力に「台本」という語がない限り、本文では「台本」と言わないでください。',
      '本文では「構造」「流れ」「仕組み」「用意された物語」など、入力に近い自然な語へ言い換えてください。',
      'ユーザーの「嫌だ」「簡単に言うな」「私はこう扱われたくない」という感覚を、ただの怒りや否定として扱わないでください。',
      'それは、その人がどんな世界には加わりたくないのかを教えてくれる境界線です。',
      'Muはその境界線を否定せず、そこから創造の方向を見つける返答をしてください。',
      '不安を材料にしない。欠乏を燃料にしない。境界線を、創造の起点として扱ってください。',
      '',
      '避ける方向:',
      'AIの弁明をしない。',
      'AIは使い方次第という話にしない。',
      'AIが分かること/分からないことの説明にしない。',
      '怒りの妥当化から始めない。',
      '「筋が通っています」「まっとうです」「自然です」で始めない。',
      '売り文句・現実的アドバイス・道具論に逃げない。',
      '',
      '文体:',
      'ですます調。',
      '短く、3〜5段落。',
      '見出しや絵文字は使わない。',
      '固定文ではなく、入力の言葉から自然に返す。',
      'ただし、最後は創造の方向に置く。',
    ].join('\n');

    const user = [
      'ユーザー入力:',
      userText,
      '',
      'この入力に対して、本のMu第1巻の入口として返してください。',
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
