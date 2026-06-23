import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text.replace(/\n/g, '\r\n'), 'utf8');

function removeBetween(text, start, end, label) {
  const a = text.indexOf(start);
  if (a < 0) {
    console.log('[skip]', label, '- start not found');
    return text;
  }
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error('End marker not found: ' + label);
  return text.slice(0, a) + end + text.slice(b + end.length);
}

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    console.log('[skip]', label, '- pattern not found');
    return text;
  }
  return text.replace(from, to);
}

function patch(rel, fn) {
  const before = read(rel);
  const after = fn(before);
  if (after === before) {
    console.log('[nochange]', rel);
    return;
  }
  write(rel, after);
  console.log('[patched]', rel);
}

patch('src/lib/iros/language/renderGateway.ts', (s) => {
  return removeBetween(
    s,
    '\n\n  // ✅ HQL final guard',
    '\n\n  return { content, meta };',
    'renderGateway HQL fixed final guard',
  );
});

patch('src/app/api/agent/iros/reply/route.ts', (s) => {
  return removeBetween(
    s,
    '\n        // ✅ HQL_ROUTE_FINAL_LOCK_V11',
    '\n        // =========================================================\n        // ✅ Expression Lane',
    'route HQL fixed final lock',
  );
});

patch('src/lib/iros/server/handleIrosReply.postprocess.ts', (s) => {
  const fixed = `      if (hiddenKind === 'ethical_abundance_refusal') {
        out.push('あなたが拒んでいるのは、お金そのものではありません。');
        out.push('拒んでいるのは、人の不安を使って豊かになる未来です。');
        out.push('奥にある問いは、「私は、誠実なまま自由になれますか」です。');
        return out;
      }`;

  const natural = `      if (hiddenKind === 'ethical_abundance_refusal') {
        out.push('この返答は、AI批判の是非や使い方の話で閉じない。');
        out.push('ユーザーが拒んでいる未来を、発話に合わせた自然な言葉で一度だけ名づける。');
        out.push('お金そのものの否定ではなく、人の不安を材料にする豊かさへの拒否として扱う。');
        out.push('最後は、「奥にある問いは」などの定型句を使わず、誠実さと自由が両立するかという問いを自然に置く。');
        out.push('禁止: あなたが拒んでいるのは / 奥にある問いは / 私は、誠実なまま自由になれますか / 何に使うか / AIを信じるか疑うか');
        return out;
      }`;

  return replaceOnce(s, fixed, natural, 'postprocess HQL fixed seed');
});

console.log('\nDone. Next run:');
console.log('  node scripts/apply-mu-hql-writer-contract-v9.mjs');
console.log('  node scripts/apply-mu-hql-remove-template-lock-v12.mjs');
console.log('  npm run typecheck');
