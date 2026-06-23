import fs from 'node:fs';

const files = {
  route: 'src/app/api/agent/iros/reply/route.ts',
  writer: 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');

// 1) writer import 修正：named import → default import
{
  const p = files.writer;
  let s = read(p);

  s = s.replace(
    "import { openai } from '@/lib/iros/openai';",
    "import openai from '@/lib/iros/openai';"
  );

  s = s.replace(
    "import { openai } from '@/lib/openai';",
    "import openai from '@/lib/iros/openai';"
  );

  write(p, s);
  console.log('[patched] writer default import');
}

// 2) route.ts の HQL_ROUTE_OVERRIDE_V18C 内 directReply を範囲で差し替え
{
  const p = files.route;
  let s = read(p);

  if (s.includes('HQL_CREATION_LANDING_LLM_WRITER_V19')) {
    console.log('[skip] directReply already patched');
  } else {
    const hIdx = s.indexOf('HQL_ROUTE_OVERRIDE_V18C');
    if (hIdx < 0) throw new Error('HQL_ROUTE_OVERRIDE_V18C not found');

    const start = s.indexOf('        const directReply = [', hIdx);
    if (start < 0) throw new Error('directReply array start not found');

    const joinIdx = s.indexOf('].join(', start);
    if (joinIdx < 0) throw new Error('directReply join not found');

    const semiIdx = s.indexOf(';', joinIdx);
    if (semiIdx < 0) throw new Error('directReply semicolon not found');

    const end = semiIdx + 1;

    const replacement = `        // HQL_CREATION_LANDING_LLM_WRITER_V19
        // 通常writer/rephraseへ戻さず、HQL専用LLM writerだけを通す。
        const directReply = await callHqlCreationLandingWriter({
          userText: userTextClean,
          traceId,
          conversationId,
          userCode,
        });`;

    s = s.slice(0, start) + replacement + s.slice(end);

    write(p, s);
    console.log('[patched] directReply array -> HQL LLM writer');
  }
}

console.log('');
console.log('Done. Run: npm run typecheck');
