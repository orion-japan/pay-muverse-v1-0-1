import fs from 'node:fs';

const p = 'src/app/api/agent/iros/reply/route.ts';
let s = fs.readFileSync(p, 'utf8');

const before = "preSeedDecision?.route === 'hql_creation_landing'";
const after = "String((preSeedDecision as any)?.route || '') === 'hql_creation_landing'";

if (!s.includes(before)) {
  throw new Error('route hql condition not found');
}

s = s.replace(before, after);
fs.writeFileSync(p, s, 'utf8');

console.log('[patched] route hql condition cast');
