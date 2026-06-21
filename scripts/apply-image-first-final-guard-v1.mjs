import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, text) {
  fs.writeFileSync(path, text, 'utf8');
}

function fail(message) {
  throw new Error(`[patch failed] ${message}`);
}

function replaceOnce(path, oldText, newText, label, alreadyText = '') {
  const text = read(path);
  if (alreadyText && text.includes(alreadyText)) {
    console.log(`SKIP ${label}`);
    return;
  }
  const idx = text.indexOf(oldText);
  if (idx < 0) fail(`${label}: target not found in ${path}`);
  write(path, text.slice(0, idx) + newText + text.slice(idx + oldText.length));
  console.log(`OK   ${label}`);
}

function replaceRegexOnce(path, pattern, newText, label, alreadyText = '') {
  const text = read(path);
  if (alreadyText && text.includes(alreadyText)) {
    console.log(`SKIP ${label}`);
    return;
  }
  const next = text.replace(pattern, newText);
  if (next === text) fail(`${label}: regex target not found in ${path}`);
  write(path, next);
  console.log(`OK   ${label}`);
}

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(`branch: ${branch}`);
if (branch !== 'work/preseed-flow-directive') {
  console.warn('WARNING: expected branch work/preseed-flow-directive');
}

console.log('\n==> patch convergenceAxis relation detection');
const convergencePath = 'src/lib/iros/create/convergenceAxis.ts';
const hasRelationFunction = String.raw`export function hasRelationEvidence(args: {
  userText?: unknown;
  relationshipContext?: any;
  relationshipCapture?: any;
  resolvedRelationId?: unknown;
  targetLabel?: unknown;
  activeDiagnosisFrame?: any;
  topicDigest?: unknown;
  situationTopic?: unknown;
  cognitionMap?: any;
}): boolean {
  const map = asRecord(args.cognitionMap) ?? {};
  const relationContext = asRecord(args.relationshipContext) ?? asRecord(args.relationshipCapture) ?? {};
  const frame = asRecord(args.activeDiagnosisFrame) ?? {};
  const source = [args.userText, relationContext.kind, relationContext.relationId, relationContext.resolvedRelationId, args.resolvedRelationId, args.targetLabel, frame.kind, frame.targetLabel, args.topicDigest, args.situationTopic, map.relationDomain, map.source?.kind].map(text).filter(Boolean).join('\n');
  return hasAny(source, [/relationship/u, /relation_/u, /恋愛/u, /相手/u, /関係/u, /距離/u, /連絡/u, /LINE/u, /ライン/u, /返信/u, /返事/u, /気持ち/u]);
}
`;
const hasRelationFunctionNew = String.raw`export function hasRelationEvidence(args: {
  userText?: unknown;
  relationshipContext?: any;
  relationshipCapture?: any;
  resolvedRelationId?: unknown;
  targetLabel?: unknown;
  activeDiagnosisFrame?: any;
  topicDigest?: unknown;
  situationTopic?: unknown;
  cognitionMap?: any;
}): boolean {
  const map = asRecord(args.cognitionMap) ?? {};
  const relationContext = asRecord(args.relationshipContext) ?? asRecord(args.relationshipCapture) ?? {};
  const frame = asRecord(args.activeDiagnosisFrame) ?? {};

  // Relationship 判定は「今ターンの明示語」または「関係ID/対象ラベルの明示証拠」だけで行う。
  // topicDigest / situationTopic は過去のassistant文を含みやすく、
  // genericな「次に何をすれば？」を relation_waiting に誤爆させるため使わない。
  const relationIdSource = [
    relationContext.relationId,
    relationContext.resolvedRelationId,
    args.resolvedRelationId,
  ]
    .map(text)
    .filter(Boolean)
    .join('\n');

  if (hasAny(relationIdSource, [/relationship/u, /relation_/u, /__person_/u, /generic.*恋愛/u])) {
    return true;
  }

  const explicitContextSource = [
    relationContext.kind,
    args.targetLabel,
    frame.kind,
    frame.targetLabel,
    map.source?.kind,
  ]
    .map(text)
    .filter(Boolean)
    .join('\n');

  if (hasAny(explicitContextSource, [/relationship/u, /relation_/u, /恋愛/u, /相手/u, /関係/u])) {
    return true;
  }

  const currentUserText = text(args.userText);
  return hasAny(currentUserText, [
    /恋愛/u,
    /相手/u,
    /彼氏/u,
    /彼女/u,
    /好きな人/u,
    /夫/u,
    /妻/u,
    /LINE/u,
    /ライン/u,
    /連絡/u,
    /返信/u,
    /返事/u,
    /既読/u,
    /距離/u,
  ]);
}
`;
replaceOnce(convergencePath, hasRelationFunction, hasRelationFunctionNew, 'convergence hasRelationEvidence strict', 'Relationship 判定は「今ターンの明示語」');

console.log('\n==> patch normalChat image-first focus selection');
const normalPath = 'src/lib/iros/slotPlans/normalChat.ts';
const normalOld = String.raw`function buildImageFirstCreateSlots(args: { userText: string; ctxPack?: any; meta?: any; flowDelta?: string | null }): NormalChatSlot[] {
  const ctxPack = args.ctxPack ?? args.meta?.extra?.ctxPack ?? {};
  const domain = ctxPack.focusDomain ?? ctxPack.tcfStarter?.focusDomain ?? resolveImageFirstCreateDomain({ userText: args.userText, relationshipContext: ctxPack.relationshipContext, relationshipCapture: ctxPack.relationshipCapture, resolvedRelationId: ctxPack.resolvedRelationId, targetLabel: ctxPack.targetLabel, activeDiagnosisFrame: ctxPack.activeDiagnosisFrame, topicDigest: ctxPack.topicDigest, situationTopic: ctxPack.situationTopic, cognitionMap: ctxPack.cognitionMap });
  const line = ctxPack.focusLabel ?? ctxPack.tcfStarter?.currentFocus ?? ctxPack.tcfStarter?.nextFocus ?? resolveImageFirstCreateFocusLabel(domain);
  return [
`;
const normalNew = String.raw`function buildImageFirstCreateSlots(args: { userText: string; ctxPack?: any; meta?: any; flowDelta?: string | null }): NormalChatSlot[] {
  const ctxPack = args.ctxPack ?? args.meta?.extra?.ctxPack ?? {};
  const domain = resolveImageFirstCreateDomain({
    userText: args.userText,
    relationshipContext: ctxPack.relationshipContext,
    relationshipCapture: ctxPack.relationshipCapture,
    resolvedRelationId: ctxPack.resolvedRelationId,
    targetLabel: ctxPack.targetLabel,
    activeDiagnosisFrame: ctxPack.activeDiagnosisFrame,
    topicDigest: ctxPack.topicDigest,
    situationTopic: ctxPack.situationTopic,
    cognitionMap: ctxPack.cognitionMap,
  });

  // image-first create では、過去ターン由来の ctxPack.focusLabel を正本にしない。
  // genericな「次に何をすれば？」が、過去assistantの「連絡/返信」文脈へ戻るのを防ぐ。
  const computedFocus = resolveImageFirstCreateFocusLabel(domain);
  const relationFocus =
    domain === 'relation_waiting'
      ? String(ctxPack.tcfStarter?.currentFocus ?? ctxPack.tcfStarter?.nextFocus ?? computedFocus).trim()
      : computedFocus;
  const line = relationFocus || computedFocus;
  return [
`;
replaceOnce(normalPath, normalOld, normalNew, 'normalChat image-first focus computed', '過去ターン由来の ctxPack.focusLabel を正本にしない');

console.log('\n==> patch rephraseEngine deterministic final guard');
const rephrasePath = 'src/lib/iros/language/rephrase/rephraseEngine.full.ts';
const insertAnchor = String.raw`  // ✅ “内部マーカー” だけ落とす（ユーザーの @mention 等は落とさない）
`;
const deterministicGuard = String.raw`
  const imageFirstShiftPayload = parseShiftJson(String((shiftSlot as any)?.text ?? ''));
  const isImageFirstCreateFinal =
    imageFirstShiftPayload?.hint === 'image_first_create_v1' ||
    imageFirstShiftPayload?.intent === 'place_imaginal_form' ||
    imageFirstShiftPayload?.createAxis === 'imaginal_form_create' ||
    imageFirstShiftPayload?.writerPattern === 'IMAGE_FIRST_CREATE_V1' ||
    imageFirstShiftPayload?.writerPatternKey === 'IMAGE_FIRST_CREATE_V1';

  if (isImageFirstCreateFinal) {
    const focusLine = String(
      imageFirstShiftPayload?.line ??
        imageFirstShiftPayload?.focusLabel ??
        imageFirstShiftPayload?.currentFocus ??
        '次に動く前に、今の自分の立ち位置を一つ置く形'
    ).trim();

    const safeFocus = focusLine || '次に動く前に、今の自分の立ち位置を一つ置く形';
    const finalText = [
      `いま先に置く形は、「${safeFocus}」です。`,
      'これは、やることを増やすためではなく、動く前に自分の中心を戻すための形です。',
      '今日は、その形から外れないことだけで十分です。',
    ].join('\n\n');

    const out = buildSlotsWithFirstText(inKeys, finalText);
    const metaExtra: any = {
      rephraseBlocks: toRephraseBlocks(finalText).map((text) => ({ text, kind: 'p' })),
      rephraseHead: safeHead(finalText, 120),
      imageFirstCreateFinalGuard: true,
      imageFirstFocus: safeFocus,
    };

    logRephraseOk(debug, out.map((x) => x.key), finalText, 'IMAGE_FIRST_CREATE_FINAL_GUARD');
    logRephraseAfterAttach(debug, out.map((x) => x.key), finalText, 'IMAGE_FIRST_CREATE_FINAL_GUARD', metaExtra);

    return {
      ok: true,
      slots: out,
      meta: {
        inKeys,
        outKeys: out.map((x) => x.key),
        rawLen: finalText.length,
        rawHead: safeHead(finalText, 120),
        note: 'IMAGE_FIRST_CREATE_FINAL_GUARD',
        extra: metaExtra,
      },
    };
  }

`;
replaceOnce(rephrasePath, insertAnchor, deterministicGuard + insertAnchor, 'rephrase image-first deterministic final guard', 'IMAGE_FIRST_CREATE_FINAL_GUARD');

console.log('\n==> git diff');
execFileSync('git', ['diff', '--', convergencePath, normalPath, rephrasePath], { stdio: 'inherit' });

console.log('\n==> typecheck');
execFileSync('pnpm', ['run', 'typecheck'], { stdio: 'inherit', shell: process.platform === 'win32' });

console.log('\nPatch done. Commit with:');
console.log('git add src/lib/iros/create/convergenceAxis.ts src/lib/iros/slotPlans/normalChat.ts src/lib/iros/language/rephrase/rephraseEngine.full.ts');
console.log('git commit -m "Guard image-first create final output"');
