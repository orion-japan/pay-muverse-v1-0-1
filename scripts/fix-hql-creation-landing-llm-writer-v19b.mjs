import fs from 'node:fs';

const files = {
  route: 'src/app/api/agent/iros/reply/route.ts',
  writer: 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts',
};

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');

// ------------------------------------------------------------
// 1) writerのopenai importを既存パスへ修正
// ------------------------------------------------------------
{
  const p = files.writer;
  let s = read(p);

  s = s.replace(
    "import { openai } from '@/lib/openai';",
    "import { openai } from '@/lib/iros/openai';"
  );

  write(p, s);
  console.log('[patched] writer import');
}

// ------------------------------------------------------------
// 2) route.ts の固定 directReply ブロックを範囲指定で差し替える
// ------------------------------------------------------------
{
  const p = files.route;
  let s = read(p);

  if (!s.includes('HQL_CREATION_LANDING_LLM_WRITER_V19')) {
    const marker = 'const directReply = [';
    const markerIdx = s.indexOf(marker, s.indexOf('HQL_ROUTE_OVERRIDE_V18C'));
    if (markerIdx < 0) throw new Error('directReply marker not found after HQL_ROUTE_OVERRIDE_V18C');

    const start = s.lastIndexOf('\n', markerIdx) + 1;
    const endNeedle = "        ].join('\\\\n');";
    const endIdx = s.indexOf(endNeedle, markerIdx);
    if (endIdx < 0) throw new Error('directReply end not found');

    const end = endIdx + endNeedle.length;

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
    console.log('[patched] directReply fixed block -> LLM writer');
  } else {
    console.log('[skip] directReply already patched');
  }
}

console.log('');
console.log('Done. Run: npm run typecheck');
