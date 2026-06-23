import fs from 'node:fs';

const files = {
  route: 'src/app/api/agent/iros/reply/route.ts',
  writer: 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

// ------------------------------------------------------------
// 1) 専用LLM writerを作る
// ------------------------------------------------------------
{
  const path = files.writer;

  if (!fs.existsSync(path)) {
    const content = `import { openai } from '@/lib/openai';

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
  ].join('\\n');
}

function cleanReply(text: string): string {
  return String(text ?? '')
    .replace(/^["'\\s]+|["'\\s]+$/g, '')
    .replace(/\\n{3,}/g, '\\n\\n')
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
    ].join('\\n');

    const user = [
      'ユーザー入力:',
      userText,
      '',
      'この入力に対して、本のMu第1巻の入口として返してください。',
    ].join('\\n');

    const res = await openai.chat.completions.create({
      model: process.env.IROS_HQL_LANDING_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.55,
      max_tokens: 420,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const text = cleanReply(res.choices?.[0]?.message?.content ?? '');
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
`;

    write(path, content);
    console.log('[created]', path);
  } else {
    console.log('[skip]', path);
  }
}

// ------------------------------------------------------------
// 2) route.ts に import を追加
// ------------------------------------------------------------
{
  const path = files.route;
  let s = read(path);

  if (!s.includes("callHqlCreationLandingWriter")) {
    const anchor = `import { callPreSeedDiagnosisWriter } from '@/lib/iros/server/preseed/callPreSeedDiagnosisWriter';`;
    const replacement = `${anchor}
import { callHqlCreationLandingWriter } from '@/lib/iros/server/preseed/callHqlCreationLandingWriter';`;

    must(s.includes(anchor), 'route import anchor');
    s = s.replace(anchor, replacement);

    write(path, s);
    console.log('[patched import]', path);
  } else {
    console.log('[skip import]', path);
  }
}

// ------------------------------------------------------------
// 3) HQL_ROUTE_OVERRIDE_V18C内の固定directReplyをLLM writerへ差し替える
// ------------------------------------------------------------
{
  const path = files.route;
  let s = read(path);

  if (!s.includes('HQL_CREATION_LANDING_LLM_WRITER_V19')) {
    const before = `        const directReply = [
          '疑っているのは、AIそのものというより、人の不安を見つけて、きれいな言葉に変えて、最後にお金へ流す構造です。',
          '',
          'だから「自由に生きよう」という言葉も、希望ではなく、誰かの弱さを材料にする言葉に聞こえてしまう。',
          '',
          '本当に問われているのは、そこに飲まれずに、誠実なまま自由や豊かさを生めるのか、ということです。'
        ].join('\\\\n');`;

    const after = `        // HQL_CREATION_LANDING_LLM_WRITER_V19
        // 通常writer/rephraseへ戻さず、HQL専用LLM writerだけを通す。
        const directReply = await callHqlCreationLandingWriter({
          userText: userTextClean,
          traceId,
          conversationId,
          userCode,
        });`;

    must(s.includes(before), 'directReply fixed block');
    s = s.replace(before, after);

    write(path, s);
    console.log('[patched directReply -> LLM writer]', path);
  } else {
    console.log('[skip directReply]', path);
  }
}

console.log('');
console.log('Done. Run: npm run typecheck');
