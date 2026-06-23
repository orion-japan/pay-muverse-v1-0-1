import fs from 'node:fs';

const path = 'src/lib/iros/language/rephrase/rephraseEngine.full.ts';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

let s = read(path);

if (s.includes('HQL_PRESEED_SOVEREIGN_V14')) {
  console.log('[skip] already patched');
  process.exit(0);
}

const anchor = `raw = await (async () => {`;
must(s.includes(anchor), 'raw call anchor');

const insert = `// HQL_PRESEED_SOVEREIGN_V14
// Pre-SEED が hidden_question_landing を確定したターンでは、
// writer直前で通常seedを外し、本のMuに合わせた HQL seed だけを渡す。
if (typeof hiddenQuestionLandingForFirstPass !== 'undefined' && hiddenQuestionLandingForFirstPass) {
  const msgArr = Array.isArray(messages) ? (messages as any[]) : [];
  const systemMsg =
    msgArr.find((m: any) => String(m?.role ?? '') === 'system') ??
    { role: 'system', content: systemPrompt };

  const lastUserMsg =
    [...msgArr].reverse().find((m: any) => String(m?.role ?? '') === 'user') ??
    { role: 'user', content: String(userText ?? '') };

  const hqlContract = {
    role: 'assistant' as const,
    content: [
      'HQL_PRESEED_SOVEREIGN_V14 (DO NOT OUTPUT):',
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
      '- 固定文、行動提案、質問返し、絵文字は禁止。2〜4文。',
    ].join('\\\\n'),
  };

  messages = [systemMsg, hqlContract, lastUserMsg] as any;

  try {
    console.log('[IROS/HQL][PRESEED_SOVEREIGN_V14]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      oldMsgCount: msgArr.length,
      newMsgCount: Array.isArray(messages) ? messages.length : null,
    });
  } catch {}
}

${anchor}`;

s = s.replace(anchor, insert);

write(path, s);

console.log('[patched]', path);
console.log('');
console.log('Done. Run: npm run typecheck');
