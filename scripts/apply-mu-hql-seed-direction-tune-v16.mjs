import fs from 'node:fs';

const path = 'src/lib/iros/language/rephrase/rephraseEngine.full.ts';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

let s = read(path);

if (s.includes('HQL_SEED_DIRECTION_TUNE_V16')) {
  console.log('[skip] already patched');
  process.exit(0);
}

const from = `      'HQL_PRESEED_SOVEREIGN_V14 (DO NOT OUTPUT):',
      'seedControlProfile=HQL_ONLY',
      'STATE_CUES (DO NOT OUTPUT):',
      'CURRENT_TURN_PROFILE=HQL_ONLY',
      'FOCUS=不安をきれいな言葉に変えて、お金や誘導へつなげる構造への拒否',
      'LANDING=誠実さを捨てずに自由や豊かさを生めるのかという問い',
      'NO_MEMORY=true',
      'NO_RELATIONSHIP_CONTEXT=true',
      'NO_FLOW_FUTURE=true',
      'NO_TRUTH_PATTERN=true',
      'OUTPUT_CONTRACT:',
      '- AI能力説明、AIの限界説明、AIを信じるか疑うか、使い方論、リテラシー論で閉じない。',
      '- 「AIが分かるのは」「言葉として出てきた現実の輪郭」「使えるものと使えないもの」を使わない。',
      '- 冒頭を「筋が通っています」「まっとうです」から始めない。',
      '- 拒んでいる未来を自然に名づける。',
      '- 最後は、誠実さと自由や豊かさが両立するかという問いへ自然に着地する。',
      '- 固定文、行動提案、質問返し、絵文字は禁止。2〜4文。',`;

const to = `      'HQL_PRESEED_SOVEREIGN_V14 (DO NOT OUTPUT):',
      'HQL_SEED_DIRECTION_TUNE_V16',
      'seedControlProfile=HQL_ONLY',
      'STATE_CUES (DO NOT OUTPUT):',
      'CURRENT_TURN_PROFILE=HQL_ONLY',
      'READING_FRAME=これは怒りの安定化ではなく、黒い構造への拒否として読む',
      'BOOK_MU_FRAME=本のMuとして、きれいな言葉を信じられない地点から、創造の方向へ向かう入口として読む',
      'FOCUS=人の不安を見つけ、きれいな言葉で包み、希望や自由の顔をさせ、最後にお金へ変える構造への違和感',
      'REJECTION_TARGET=豊かさそのものではなく、人の不安を燃料にする豊かさ',
      'INNER_QUESTION=誠実さを失わずに、自由や豊かさを生めるのか',
      'CREATION_DIRECTION=人の不安を使うのではなく、創造の方向から現実を作れるのか',
      'OUTPUT_DIRECTION:',
      '- 不信をなだめるより、ユーザーが見ている黒い構造を映す。',
      '- AI批判の是非ではなく、不安を価値へ変える構造への拒否として扱う。',
      '- お金の否定ではなく、弱さを材料にする豊かさへの拒否として扱う。',
      '- 最後は、創造の方向へ開く問いとして自然に置く。',
      '- 本文は会話として自然に書く。内部seed文をそのまま出さない。',`;

must(s.includes(from), 'HQL v14 contract block');
s = s.replace(from, to);

write(path, s);

console.log('[patched]', path);
console.log('');
console.log('Done. Run: npm run typecheck');
