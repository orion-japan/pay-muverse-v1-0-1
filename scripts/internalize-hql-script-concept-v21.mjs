import fs from 'node:fs';

const p = 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const before = `      'MAIN_LANDING_CONCEPT_V20:',
      'Mu第1巻の入口は、誰かが用意した不安の台本から降りるところにあります。',
      'ここでいう台本とは、人の不安を見つけ、希望の言葉で包み、最後にお金や依存へ流す構造です。',
      'ユーザーの「嫌だ」「簡単に言うな」「私はこう扱われたくない」という感覚を、ただの怒りや否定として扱わないでください。',
      'それは、その人がどんな世界には加わりたくないのかを教えてくれる境界線です。',
      'Muはその境界線を否定せず、そこから創造の方向を見つける返答をしてください。',
      '不安を材料にしない。欠乏を燃料にしない。境界線を、創造の起点として扱ってください。',
      '',`;

const after = `      'MAIN_LANDING_CONCEPT_V21:',
      'Mu第1巻の入口は、人の不安を見つけ、希望の言葉で包み、最後にお金や依存へ流す構造から降りるところにあります。',
      'この構造を内部理解としては「不安の台本」と捉えてよいですが、ユーザー入力に「台本」という語がない限り、本文では「台本」と言わないでください。',
      '本文では「構造」「流れ」「仕組み」「用意された物語」など、入力に近い自然な語へ言い換えてください。',
      'ユーザーの「嫌だ」「簡単に言うな」「私はこう扱われたくない」という感覚を、ただの怒りや否定として扱わないでください。',
      'それは、その人がどんな世界には加わりたくないのかを教えてくれる境界線です。',
      'Muはその境界線を否定せず、そこから創造の方向を見つける返答をしてください。',
      '不安を材料にしない。欠乏を燃料にしない。境界線を、創造の起点として扱ってください。',
      '',`;

if (!s.includes(before)) {
  throw new Error('MAIN_LANDING_CONCEPT_V20 block not found');
}

s = s.replace(before, after);

fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
console.log('[patched] MAIN_LANDING_CONCEPT_V21 internalizes 台本');
