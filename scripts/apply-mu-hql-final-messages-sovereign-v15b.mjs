import fs from 'node:fs';

const path = 'src/lib/iros/language/rephrase/rephraseEngine.full.ts';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
const must = (cond, label) => {
  if (!cond) throw new Error('Pattern not found: ' + label);
};

let s = read(path);

if (s.includes('HQL_FINAL_MESSAGES_SOVEREIGN_V15B')) {
  console.log('[skip] already patched');
  process.exit(0);
}

const anchor = `console.log(
          '[IROS/rephraseEngine][FINAL_MESSAGES_FOR_WRITER]',`;

must(s.includes(anchor), 'FINAL_MESSAGES_FOR_WRITER real anchor');

const insert = `// HQL_FINAL_MESSAGES_SOVEREIGN_V15B
        // v14後に WRITER_DIRECTIVES / PATTERN_OUTPUT_CONTRACT が再混入するため、
        // FINAL_MESSAGES_FOR_WRITER直前で messagesForWriterFinal をHQL専用に絞る。
        try {
          const hasHqlSovereign =
            (typeof hiddenQuestionLandingForFirstPass !== 'undefined' && hiddenQuestionLandingForFirstPass) ||
            (Array.isArray(messagesForWriterFinal) && messagesForWriterFinal.some((m: any) =>
              String(m?.content ?? '').includes('HQL_PRESEED_SOVEREIGN_V14') ||
              String(m?.content ?? '').includes('seedControlProfile=HQL_ONLY')
            ));

          if (hasHqlSovereign && Array.isArray(messagesForWriterFinal)) {
            const before = messagesForWriterFinal.length;

            const systemMsg =
              messagesForWriterFinal.find((m: any) => String(m?.role ?? '') === 'system') ??
              { role: 'system', content: systemPrompt };

            const userMsg =
              [...messagesForWriterFinal].reverse().find((m: any) => String(m?.role ?? '') === 'user') ??
              { role: 'user', content: String(userText ?? '') };

            const hqlMsg =
              messagesForWriterFinal.find((m: any) =>
                String(m?.content ?? '').includes('HQL_PRESEED_SOVEREIGN_V14') ||
                String(m?.content ?? '').includes('seedControlProfile=HQL_ONLY')
              ) ?? {
                role: 'assistant' as const,
                content: [
                  'HQL_FINAL_MESSAGES_SOVEREIGN_V15B (DO NOT OUTPUT):',
                  'seedControlProfile=HQL_ONLY',
                  'FOCUS=人の不安をきれいな言葉に変えて、お金や誘導へつなげる構造への拒否',
                  'LANDING=誠実さを捨てずに自由や豊かさを生めるのかという問い',
                  'DO_NOT_OUTPUT_SEED_LINE=true',
                  'NO_WRITER_DIRECTIVES=true',
                  'NO_PATTERN_OUTPUT_CONTRACT=true',
                  'NO_AI_EXPLANATION=true',
                  'NO_TOOL_USAGE_TALK=true',
                  'OUTPUT_CONTRACT:',
                  '- AIの能力・限界・使い方を説明しない。',
                  '- 「まっとう」「筋が通っています」「分かったふり」「現実にある負担」「受け取ります」を使わない。',
                  '- seed文をそのまま出さない。',
                  '- ユーザーが拒否している構造を自然文で映す。',
                  '- 最後は、誠実なまま自由や豊かさを生めるのか、という問いへ自然に着地する。',
                ].join('\\\\n'),
              };

            messagesForWriterFinal = [systemMsg, hqlMsg, userMsg] as any;

            console.log('[IROS/HQL][FINAL_MESSAGES_SOVEREIGN_V15B]', {
              traceId: debug.traceId,
              conversationId: debug.conversationId,
              userCode: debug.userCode,
              before,
              after: Array.isArray(messagesForWriterFinal) ? messagesForWriterFinal.length : null,
            });
          }
        } catch (e) {
          try {
            console.warn('[IROS/HQL][FINAL_MESSAGES_SOVEREIGN_V15B][WARN]', e);
          } catch {}
        }

        ${anchor}`;

s = s.replace(anchor, insert);

write(path, s);

console.log('[patched]', path);
console.log('');
console.log('Done. Run: npm run typecheck');
