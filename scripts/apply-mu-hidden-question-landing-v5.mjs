import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const normalChatPath = 'src/lib/iros/slotPlans/normalChat.ts';
const postprocessPath = 'src/lib/iros/server/handleIrosReply.postprocess.ts';

function abs(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
}

function write(rel, text) {
  fs.writeFileSync(abs(rel), text.replace(/\n/g, '\r\n'), 'utf8');
  console.log(`[patched] ${rel}`);
}

function replaceOnce(rel, from, to, label) {
  const text = read(rel);
  if (!text.includes(from)) throw new Error(`Pattern not found: ${label}`);
  write(rel, text.replace(from, to));
}

function replaceAll(rel, from, to, label) {
  const text = read(rel);
  const count = text.split(from).length - 1;
  if (count <= 0) throw new Error(`Pattern not found: ${label}`);
  write(rel, text.split(from).join(to));
  console.log(`[patched-count] ${label}: ${count}`);
}

function patchNormalChat() {
  replaceOnce(
    normalChatPath,
    `  const preSeedFlowDirectiveNow =\n    (args as any)?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.extra?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.preSeedFlowDirective ??\n    null;\n  const hiddenQuestionLandingNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    (args as any)?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.hiddenQuestionLanding === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.answerHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.shouldLandHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.writerGuidance?.shouldLandHiddenQuestion === true;\n  const hiddenQuestionLandingKindNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    (args as any)?.ctxPack?.ethicalAbundanceRefusal === true ||\n    (args as any)?.meta?.extra?.ctxPack?.ethicalAbundanceRefusal === true\n      ? 'ethical_abundance_refusal'\n      : 'intention_refusal';`,
    `  const preSeedFlowDirectiveNow =\n    (args as any)?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.extra?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.preSeedFlowDirective ??\n    null;\n\n  const resolvedAskTypeForHidden =\n    String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||\n    String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||\n    String((args as any)?.resolvedAskType ?? '').trim() ||\n    '';\n\n  const resolvedAskTopicForHidden =\n    String((args as any)?.ctxPack?.resolvedAsk?.topic ?? '').trim() ||\n    String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.topic ?? '').trim() ||\n    '';\n\n  const shiftKindForHidden =\n    String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||\n    String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||\n    '';\n\n  const hiddenQuestionLandingNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    shiftKindForHidden === 'hidden_question_landing' ||\n    resolvedAskTypeForHidden === 'hidden_question' ||\n    resolvedAskTopicForHidden === 'ethical_abundance_refusal' ||\n    (args as any)?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.hiddenQuestionLanding === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.answerHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.shouldLandHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.writerGuidance?.shouldLandHiddenQuestion === true;\n  const hiddenQuestionLandingKindNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    resolvedAskTopicForHidden === 'ethical_abundance_refusal' ||\n    (args as any)?.ctxPack?.ethicalAbundanceRefusal === true ||\n    (args as any)?.meta?.extra?.ctxPack?.ethicalAbundanceRefusal === true\n      ? 'ethical_abundance_refusal'\n      : 'intention_refusal';`,
    'normalChat:hidden detection from resolvedAsk/shiftKind'
  );

  replaceOnce(
    normalChatPath,
    `            | 'decide_shift'\n            | 'narrow_shift',`,
    `            | 'decide_shift'\n            | 'narrow_shift'\n            | 'hidden_question_landing',`,
    'normalChat:stampShiftMeta hidden union'
  );

  replaceOnce(
    normalChatPath,
    `      const shiftHint =\n        shiftKind === 'clarify_shift'\n          ? (resolvedAskType === 'truth_structure' ? 'clarify_truth_structure_v1' : 'clarify_meaning_v2')\n          : shiftKind === 'stabilize_shift'\n            ? 'stabilize_shift_v1'\n            : shiftKind === 'distance_shift'\n              ? 'distance_shift_v1'\n              : shiftKind === 'repair_shift'\n                ? 'repair_shift_v1'\n                : shiftKind === 'decide_shift'\n                  ? 'decide_shift_v1'\n                  : 'narrow_shift_v1';`,
    `      const shiftHint =\n        shiftKind === 'hidden_question_landing'\n          ? 'hidden_question_landing_v1'\n          : shiftKind === 'clarify_shift'\n            ? (resolvedAskType === 'truth_structure' ? 'clarify_truth_structure_v1' : 'clarify_meaning_v2')\n            : shiftKind === 'stabilize_shift'\n              ? 'stabilize_shift_v1'\n              : shiftKind === 'distance_shift'\n                ? 'distance_shift_v1'\n                : shiftKind === 'repair_shift'\n                  ? 'repair_shift_v1'\n                  : shiftKind === 'decide_shift'\n                    ? 'decide_shift_v1'\n                    : 'narrow_shift_v1';`,
    'normalChat:stampShiftMeta hidden hint'
  );

  replaceOnce(
    normalChatPath,
    `      const shiftIntent =\n        shiftKind === 'clarify_shift'\n          ? (resolvedAskType === 'truth_structure' ? 'answer_truth_structure' : 'meaning_reframe')\n          : shiftKind === 'stabilize_shift'\n            ? 'stabilize_direction'\n            : shiftKind === 'distance_shift'\n              ? 'distance_tuning'\n              : shiftKind === 'repair_shift'\n                ? 'repair_entry'\n                : shiftKind === 'decide_shift'\n                  ? 'answer_in_one_shot'\n                  : 'narrow_focus';`,
    `      const shiftIntent =\n        shiftKind === 'hidden_question_landing'\n          ? 'answer_hidden_question'\n          : shiftKind === 'clarify_shift'\n            ? (resolvedAskType === 'truth_structure' ? 'answer_truth_structure' : 'meaning_reframe')\n            : shiftKind === 'stabilize_shift'\n              ? 'stabilize_direction'\n              : shiftKind === 'distance_shift'\n                ? 'distance_tuning'\n                : shiftKind === 'repair_shift'\n                  ? 'repair_entry'\n                  : shiftKind === 'decide_shift'\n                    ? 'answer_in_one_shot'\n                    : 'narrow_focus';`,
    'normalChat:stampShiftMeta hidden intent'
  );

  replaceAll(
    normalChatPath,
    `if (hiddenQuestionLandingNow) {\n        return stampShiftMeta('clarify_shift', {`,
    `if (hiddenQuestionLandingNow) {\n        return stampShiftMeta('hidden_question_landing', {`,
    'normalChat:hidden branch keep hidden shift kind'
  );

  replaceOnce(
    normalChatPath,
    `    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_shift_v1';`,
    `    if (goalKindForShiftMeta2 === 'uncover' && hiddenQuestionLandingNow) return 'hidden_question_landing_v1';\n    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_shift_v1';`,
    'normalChat:shiftHint2 hidden'
  );

  replaceOnce(
    normalChatPath,
    `    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_focus';`,
    `    if (goalKindForShiftMeta2 === 'uncover' && hiddenQuestionLandingNow) return 'answer_hidden_question';\n    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_focus';`,
    'normalChat:shiftIntent2 hidden'
  );
}

function patchPostprocess() {
  replaceOnce(
    postprocessPath,
    `    if (meaningKind === 'topic_recall') {`,
    `    if (kind === 'hidden_question_landing' || intent === 'answer_hidden_question') {\n      const hiddenKind = normText(obj?.hiddenQuestionLandingKind);\n\n      if (hiddenKind === 'ethical_abundance_refusal') {\n        out.push('あなたが拒んでいるのは、お金そのものではありません。');\n        out.push('拒んでいるのは、人の不安を使って豊かになる未来です。');\n        out.push('奥にある問いは、「私は、誠実なまま自由になれますか」です。');\n        return out;\n      }\n\n      if (seed) out.push(seed);\n      out.push('表面の反応ではなく、その奥にある問いをひとつだけ見ます。');\n      return out;\n    }\n\n    if (meaningKind === 'topic_recall') {`,
    'postprocess:hidden question render fallback'
  );

  replaceOnce(
    postprocessPath,
    `    if (line) {\n      out.push(line.endsWith('。') ? line : \`\${line}。\`);`,
    `    if (line && !/固定文|余韻の決め台詞|ユーザーの発話に沿った日常語|中心にある論点/.test(line)) {\n      out.push(line.endsWith('。') ? line : \`\${line}。\`);`,
    'postprocess:do not render internal line instructions'
  );
}

patchNormalChat();
patchPostprocess();
console.log('\nDone. Run: npm run typecheck');
