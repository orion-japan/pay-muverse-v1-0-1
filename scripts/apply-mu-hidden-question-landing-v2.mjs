#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const patcherPath = path.join(root, 'scripts/apply-mu-hidden-question-landing-v1.mjs');

let source = fs.readFileSync(patcherPath, 'utf8');

// v1 は Windows の CRLF ファイルに対して LF 完全一致で探していたため、
// まず read() を LF 正規化する形に補正してから実行する。
const oldRead = `function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}`;
const newRead = `function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8').replace(/\\r\\n/g, '\\n');
}`;

if (source.includes(oldRead)) {
  source = source.replace(oldRead, newRead);
  fs.writeFileSync(patcherPath, source, 'utf8');
  console.log('[fixed] v1 patcher read() now normalizes CRLF to LF');
} else if (source.includes("replace(/\\r\\n/g, '\\n')")) {
  console.log('[skip] v1 patcher already normalizes CRLF');
} else {
  throw new Error('Could not find read() in v1 patcher. Please inspect scripts/apply-mu-hidden-question-landing-v1.mjs');
}

await import(`${pathToFileURL(patcherPath).href}?t=${Date.now()}`);
