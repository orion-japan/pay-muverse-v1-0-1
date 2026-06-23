import fs from 'node:fs';

const p = 'src/app/api/agent/iros/reply/route.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const marker = '// PRE_SEED_HQL_CREATION_LANDING_RETURN_V18';
const idx = s.indexOf(marker);
if (idx < 0) throw new Error('marker not found');

const start = s.lastIndexOf('    if (', idx);
const end = s.indexOf('    ) {', idx);
if (start < 0 || end < 0) throw new Error('if block bounds not found');

let head = s.slice(start, end + '    ) {'.length);

if (!head.includes('preSeedDecision &&')) {
  head = head.replace('    if (\n', '    if (\n      preSeedDecision &&\n');
}

head = head.replaceAll('preSeedDecision?.route', 'preSeedDecision.route');
head = head.replaceAll("String((preSeedDecision as any)?.route || '')", "String((preSeedDecision as any).route || '')");

s = s.slice(0, start) + head + s.slice(end + '    ) {'.length);

fs.writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8');
console.log('[patched] route direct if narrowing by marker');
