import fs from 'node:fs';

const p = 'src/lib/iros/server/preseed/callHqlCreationLandingWriter.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const before = `    const res = await openai.chat.completions.create({
      model: process.env.IROS_HQL_LANDING_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.55,
      max_tokens: 420,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const text = cleanReply(res.choices?.[0]?.message?.content ?? '');`;

const after = `    const res = await openai.chatComplete({
      model: process.env.IROS_HQL_LANDING_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.55,
      max_tokens: 420,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const text = cleanReply(res);`;

if (!s.includes(before)) {
  throw new Error('openai chat completion block not found');
}

s = s.replace(before, after);

fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
console.log('[patched] HQL writer uses openai.chatComplete');
