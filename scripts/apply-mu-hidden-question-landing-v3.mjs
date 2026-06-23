import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const v1Path = path.join(root, 'scripts/apply-mu-hidden-question-landing-v1.mjs');

function normalizeLf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

function replaceOrThrow(text, pattern, replacement, label) {
  const next = text.replace(pattern, replacement);
  if (next === text) {
    throw new Error(`Could not patch v1 patcher: ${label}`);
  }
  return next;
}

let source = normalizeLf(fs.readFileSync(v1Path, 'utf8'));

source = source.replace(
  /function read\(rel\) \{\n\s*return fs\.readFileSync\(abs\(rel\), 'utf8'\)(?:\.replace\(\/\\r\\n\/g, '\\n'\))?;\n\}/,
  "function read(rel) {\n  return fs.readFileSync(abs(rel), 'utf8').replace(/\\r\\n/g, '\\n');\n}",
);

if (!source.includes('function replaceRegexOnce(')) {
  source = source.replace(
    /function replaceAllLiteral\([\s\S]*?\n\}\n/,
    (match) => `${match}\nfunction replaceRegexOnce(rel, pattern, replacement, label) {\n  const text = read(rel);\n  const next = text.replace(pattern, replacement);\n  if (next === text) {\n    throw new Error(\`Pattern not found: \${label}\`);\n  }\n  write(rel, next);\n  console.log(\`[patched] \${rel}\`);\n}\n`,
  );
}

source = replaceOrThrow(
  source,
  /\n  replaceOnce\(\n    files\.preseedFlow,\n    `\s+: fallbackShouldUseSmallAction[\s\S]*?'preseedFlow:fallback writerSeed hidden question',\n  \);/,
  `
  replaceRegexOnce(
    files.preseedFlow,
    /: fallbackShouldUseSmallAction\\s*\\?\\s*'ユーザーは言葉や行動の形を求めているため、大きな結論にせず、先に形象を置き、そこから小さく実行できる一歩へ収束させる。'\\s*: fallbackIntentionReached\\s*\\?\\s*'ユーザー入力だけでも意図の輪郭が出ているため、これ以上の相手分析・原因分析を増やさず、核心を短く言葉にして収束させる。'/,
    \`: fallbackShouldUseSmallAction
               ? 'ユーザーは言葉や行動の形を求めているため、大きな結論にせず、先に形象を置き、そこから小さく実行できる一歩へ収束させる。'
               : fallbackHiddenQuestionLanding
                 ? 'PRESEED_HIDDEN_QUESTION_LANDING: 表面的な批判として扱わず、拒んでいる未来と奥の問いを名付ける。AI側の姿勢表明や安全な受け止めで閉じない。'
               : fallbackIntentionReached
                 ? 'ユーザー入力だけでも意図の輪郭が出ている。深掘りを止めるのではなく、奥の問いを一つ名付け、扱える言葉として置く。'\`,
    'preseedFlow:fallback writerSeed hidden question',
  );`,
  'fallback writerSeed regex replacement',
);

fs.writeFileSync(v1Path, source, 'utf8');
console.log('[fixed] v1 patcher is now LF-safe and uses regex for fallback writerSeed');

await import(`${pathToFileURL(v1Path).href}?t=${Date.now()}`);
