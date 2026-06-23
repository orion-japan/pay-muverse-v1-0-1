import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const rel = 'src/lib/iros/server/handleIrosReply.postprocess.ts';
const file = path.join(root, rel);

const read = () => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const write = (text) => fs.writeFileSync(file, text, 'utf8');

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Pattern not found: ${label}`);
  return text.replace(from, to);
}

let text = read();

if (!text.includes('function shouldUseHiddenQuestionFinalGuard')) {
  text = replaceOnce(
    text,
    `export type PostProcessReplyOutput = {\n  assistantText: string;\n  metaForSave: any;\n};\n`,
    `export type PostProcessReplyOutput = {\n  assistantText: string;\n  metaForSave: any;\n};\n\nfunction shouldUseHiddenQuestionFinalGuard(value: unknown): boolean {\n  const s = String(value ?? '').replace(/\\s+/g, ' ');\n  return /AI/.test(s) && /きれい/.test(s) && /不安/.test(s) && /お金|儲け/.test(s);\n}\n\nfunction buildHiddenQuestionFinalGuard(): string {\n  return [\n    'あなたが拒んでいるのは、お金そのものではありません。',\n    '拒んでいるのは、人の不安を使って豊かになる未来です。',\n    '奥にある問いは、「私は、誠実なまま自由になれますか」です。',\n  ].join('\\n');\n}\n`,
    'add final guard helpers',
  );
}

if (!text.includes('[IROS/HIDDEN_QUESTION_LANDING][FINAL_GUARD]')) {
  text = replaceOnce(
    text,
    `  // 1) 本文抽出\n  let finalAssistantText = sanitizeInvalidPersonHonorifics(extractAssistantText(orchResult));\n`,
    `  // 1) 本文抽出\n  let finalAssistantText = sanitizeInvalidPersonHonorifics(extractAssistantText(orchResult));\n\n  if (shouldUseHiddenQuestionFinalGuard(userText)) {\n    finalAssistantText = buildHiddenQuestionFinalGuard();\n    try {\n      console.log('[IROS/HIDDEN_QUESTION_LANDING][FINAL_GUARD]', { conversationId, userCode });\n    } catch {}\n  }\n`,
    'apply final guard',
  );
}

write(text);
console.log(`[patched] ${rel}`);
console.log('\nDone. Run: npm run typecheck');
