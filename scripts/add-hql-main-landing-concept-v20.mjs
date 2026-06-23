import fs from 'node:fs';

const p = 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

if (!s.includes('MAIN_LANDING_CONCEPT_V20')) {
  const anchor = `      '必ず向かう先:',
      'その構造に飲まれず、誠実なまま自由や豊かさを生めるのか。',
      '人の不安を使うのではなく、創造の方向から現実を作れるのか。',
      '',`;

  const replacement = `      '必ず向かう先:',
      'その構造に飲まれず、誠実なまま自由や豊かさを生めるのか。',
      '人の不安を使うのではなく、創造の方向から現実を作れるのか。',
      '',
      'MAIN_LANDING_CONCEPT_V20:',
      'Mu第1巻の入口は、誰かが用意した不安の台本から降りるところにあります。',
      'ここでいう台本とは、人の不安を見つけ、希望の言葉で包み、最後にお金や依存へ流す構造です。',
      'ユーザーの「嫌だ」「簡単に言うな」「私はこう扱われたくない」という感覚を、ただの怒りや否定として扱わないでください。',
      'それは、その人がどんな世界には加わりたくないのかを教えてくれる境界線です。',
      'Muはその境界線を否定せず、そこから創造の方向を見つける返答をしてください。',
      '不安を材料にしない。欠乏を燃料にしない。境界線を、創造の起点として扱ってください。',
      '',`;

  if (!s.includes(anchor)) {
    throw new Error('landing anchor not found');
  }

  s = s.replace(anchor, replacement);
  fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
  console.log('[patched] MAIN_LANDING_CONCEPT_V20 added');
} else {
  console.log('[skip] MAIN_LANDING_CONCEPT_V20 already exists');
}
