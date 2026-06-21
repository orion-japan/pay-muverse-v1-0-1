import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.cwd();
const args = new Set(process.argv.slice(2));
const shouldCommit = args.has('--commit');
const skipTypecheck = args.has('--skip-typecheck');

function fail(message) { throw new Error('[PATCH FAILED] ' + message); }
function log(message) { console.log('\n==> ' + message); }
function p(file) { return path.join(repo, file); }
function read(file) {
  if (!fs.existsSync(p(file))) fail('file not found: ' + file);
  return fs.readFileSync(p(file), 'utf8').replace(/\r\n/g, '\n');
}
function write(file, text) {
  fs.mkdirSync(path.dirname(p(file)), { recursive: true });
  fs.writeFileSync(p(file), text, 'utf8');
}
function replaceOnce(file, oldText, newText, label, already = '') {
  let text = read(file);
  if (already && text.includes(already)) { console.log('SKIP ' + label); return; }
  const idx = text.indexOf(oldText);
  if (idx < 0) fail(label + ': target not found in ' + file);
  text = text.slice(0, idx) + newText + text.slice(idx + oldText.length);
  write(file, text);
  console.log('OK   ' + label);
}
function insertBefore(file, anchor, insert, label, already = '') {
  let text = read(file);
  if (already && text.includes(already)) { console.log('SKIP ' + label); return; }
  const idx = text.indexOf(anchor);
  if (idx < 0) fail(label + ': anchor not found in ' + file);
  text = text.slice(0, idx) + insert + text.slice(idx);
  write(file, text);
  console.log('OK   ' + label);
}
function insertAfter(file, anchor, insert, label, already = '') {
  let text = read(file);
  if (already && text.includes(already)) { console.log('SKIP ' + label); return; }
  const idx = text.indexOf(anchor);
  if (idx < 0) fail(label + ': anchor not found in ' + file);
  text = text.slice(0, idx + anchor.length) + insert + text.slice(idx + anchor.length);
  write(file, text);
  console.log('OK   ' + label);
}
function git(...cmd) {
  return execFileSync('git', cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function backup(file) {
  if (!fs.existsSync(p(file))) return;
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const dir = p('patch_backups/create_convergence_' + stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(p(file), path.join(dir, file.replace(/[\\/]/g, '__')));
}

const branch = git('branch', '--show-current');
console.log('branch: ' + branch);
if (branch !== 'work/preseed-flow-directive') console.warn('WARN: expected work/preseed-flow-directive');

const touched = [
  'src/lib/iros/create/convergenceAxis.ts',
  'src/lib/iros/tcf/tcfRotation.ts',
  'src/lib/iros/server/preseed/types.ts',
  'src/lib/iros/server/preseed/preSeedTcfStarter.ts',
  'src/lib/iros/orchestratorWill.ts',
  'src/lib/iros/orchestrator.ts',
  'src/lib/iros/will/rotationEngine.ts',
  'src/lib/iros/slotPlans/normalChat.ts',
];
for (const file of touched) backup(file);

log('create convergenceAxis.ts');
write('src/lib/iros/create/convergenceAxis.ts', `export type CreateConvergenceAxis =
  | 'imaginal_form_create'
  | 'word_create'
  | 'action_create'
  | 'none';

export type ImageFirstCreateDomain =
  | 'relation_waiting'
  | 'self_next_position'
  | 'creative_project'
  | 'field_setting'
  | 'unknown_generic';

export type PreSeedCreateSignal = {
  createReady: boolean;
  flowDirection?: string | null;
  createMode?: string | null;
  inputIntent?: string | null;
  shouldLimitDeepening?: boolean;
  shouldDeepen?: boolean;
  createSource?: string | null;
  createIntegrity?: string | null;
  targetKind?: CreateConvergenceAxis | null;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? (value as Record<string, any>) : null;
}

function hasAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

export function detectExplicitWordCreate(userText: unknown): boolean {
  const t = text(userText);
  return hasAny(t, [/なんて送/u, /何て送/u, /どう返/u, /文面/u, /文章/u, /メッセージ/u, /言葉にして/u, /返信/u, /返事文/u, /一文/u, /LINE文/u, /ライン文/u]);
}

export function detectCommittedAction(userText: unknown): boolean {
  const t = text(userText);
  return hasAny(t, [/やります/u, /進めます/u, /送ります/u, /それで行きます/u, /それで進めます/u, /動きます/u, /実装してください/u, /入れてください/u, /コミット/u, /push/u, /プッシュ/u]);
}

function readNestedCreate(args: {
  preSeedCreateDirective?: any;
  createProgressBridge?: any;
  preSeedFlowDirective?: any;
  tcfStarter?: any;
  meta?: any;
  extra?: any;
  ctxPack?: any;
}) {
  const meta = asRecord(args.meta) ?? {};
  const extra = asRecord(args.extra) ?? asRecord(meta.extra) ?? {};
  const ctxPack = asRecord(args.ctxPack) ?? asRecord(extra.ctxPack) ?? asRecord(meta.ctxPack) ?? {};
  const preSeedCreateDirective = asRecord(args.preSeedCreateDirective) ?? asRecord(ctxPack.preSeedCreateDirective) ?? asRecord(extra.preSeedCreateDirective) ?? asRecord(meta.preSeedCreateDirective) ?? {};
  const createProgressBridge = asRecord(args.createProgressBridge) ?? asRecord(ctxPack.createProgressBridge) ?? asRecord(extra.createProgressBridge) ?? asRecord(meta.createProgressBridge) ?? {};
  const preSeedFlowDirective = asRecord(args.preSeedFlowDirective) ?? asRecord(ctxPack.preSeedFlowDirective) ?? asRecord(extra.preSeedFlowDirective) ?? asRecord(meta.preSeedFlowDirective) ?? {};
  const tcfStarter = asRecord(args.tcfStarter) ?? asRecord(ctxPack.tcfStarter) ?? asRecord(extra.tcfStarter) ?? asRecord(meta.tcfStarter) ?? {};

  return {
    mode: firstString(preSeedCreateDirective.mode, preSeedCreateDirective.createMode, createProgressBridge.mode, tcfStarter.createMode),
    flowDirection: firstString(preSeedFlowDirective.flowDirection, preSeedFlowDirective.flow_direction, preSeedCreateDirective.flowDirection, createProgressBridge.flowDirection, tcfStarter.flowDirection),
    createReady: preSeedFlowDirective.createReady === true || preSeedCreateDirective.createReady === true || createProgressBridge.createReady === true || tcfStarter.createReady === true,
    createSource: firstString(preSeedFlowDirective.createSource, preSeedFlowDirective.create_source, preSeedCreateDirective.createSource, createProgressBridge.createSource),
    inputIntent: firstString(preSeedFlowDirective.inputIntent, preSeedFlowDirective.input_intent, preSeedCreateDirective.inputIntent),
  };
}

export function detectCreateConvergenceAxis(args: {
  userText?: unknown;
  preSeedCreateDirective?: any;
  createProgressBridge?: any;
  preSeedFlowDirective?: any;
  tcfStarter?: any;
  meta?: any;
  extra?: any;
  ctxPack?: any;
}): CreateConvergenceAxis {
  const userText = text(args.userText);
  if (detectExplicitWordCreate(userText)) return 'word_create';
  const create = readNestedCreate(args);
  const isImageFirstCreate = create.mode === 'image_first_create';
  const isPlaceCreate = create.flowDirection === 'place_create';
  const isIntentionCreateReady = create.createReady === true && (!create.createSource || create.createSource === 'I_intention');
  if (isImageFirstCreate || isPlaceCreate || isIntentionCreateReady) return 'imaginal_form_create';
  if (detectCommittedAction(userText)) return 'action_create';
  return 'none';
}

export function hasRelationEvidence(args: {
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

export function resolveImageFirstCreateDomain(args: {
  userText?: unknown;
  relationshipContext?: any;
  relationshipCapture?: any;
  resolvedRelationId?: unknown;
  targetLabel?: unknown;
  activeDiagnosisFrame?: any;
  topicDigest?: unknown;
  situationTopic?: unknown;
  cognitionMap?: any;
}): ImageFirstCreateDomain {
  const userText = text(args.userText);
  const map = asRecord(args.cognitionMap) ?? {};
  const source = [userText, args.topicDigest, args.situationTopic, map.relationDomain, map.currentPosition, map.destination].map(text).filter(Boolean).join('\n');
  if (hasRelationEvidence(args)) return 'relation_waiting';
  if (hasAny(source, [/Muverse/u, /本/u, /書籍/u, /動画/u, /画像/u, /企画/u, /事業/u, /実装/u, /コード/u, /サービス/u, /創造/u])) return 'creative_project';
  if (hasAny(source, [/場/u, /フィールド/u, /Field/u, /空間/u, /場づくり/u])) return 'field_setting';
  if (hasAny(userText, [/次に.*何をすれば/u, /どうすれば/u, /どうしたら/u, /どう動けば/u, /どう進めれば/u, /何から/u])) return 'self_next_position';
  return 'unknown_generic';
}

export function resolveImageFirstCreateFocusLabel(domain: ImageFirstCreateDomain): string {
  switch (domain) {
    case 'relation_waiting':
      return '相手の反応待ちから、自分の時間を先に戻す形';
    case 'self_next_position':
      return '次に動く前に、今の自分の立ち位置を一つ置く形';
    case 'creative_project':
      return '実装や出力へ急ぐ前に、作ろうとしている形の中心を一つ置く形';
    case 'field_setting':
      return '場を動かす前に、先に置く空気と向きを一つ決める形';
    default:
      return '行動を増やす前に、内側に先に置く形';
  }
}

export function buildPreSeedCreateSignal(args: {
  userText?: unknown;
  preSeedCreateDirective?: any;
  createProgressBridge?: any;
  preSeedFlowDirective?: any;
  tcfStarter?: any;
  meta?: any;
  extra?: any;
  ctxPack?: any;
}): PreSeedCreateSignal | null {
  const axis = detectCreateConvergenceAxis(args);
  if (axis === 'none') return null;
  const create = readNestedCreate(args);
  return {
    createReady: axis === 'imaginal_form_create',
    flowDirection: create.flowDirection ?? (axis === 'imaginal_form_create' ? 'place_create' : null),
    createMode: axis === 'imaginal_form_create' ? 'image_first_create' : axis === 'word_create' ? 'word_create' : axis === 'action_create' ? 'action_create' : null,
    inputIntent: create.inputIntent ?? null,
    createSource: create.createSource ?? null,
    targetKind: axis,
    shouldLimitDeepening: axis === 'imaginal_form_create',
    shouldDeepen: false,
  };
}
`);

log('patch tcfRotation.ts');
insertBefore('src/lib/iros/tcf/tcfRotation.ts', 'export type TcfUserReaction =', `import { detectCreateConvergenceAxis, resolveImageFirstCreateDomain, resolveImageFirstCreateFocusLabel } from '../create/convergenceAxis';\n\n`, 'tcf import convergenceAxis', 'detectCreateConvergenceAxis');
replaceOnce('src/lib/iros/tcf/tcfRotation.ts', `  | 'writer_correction';`, `  | 'writer_correction'\n  | 'imaginal_form_create'\n  | 'word_create'\n  | 'action_create';`, 'tcf direction union', `| 'imaginal_form_create'`);
replaceOnce('src/lib/iros/tcf/tcfRotation.ts', `    v === 'memory_seed' ||\n    v === 'writer_correction'`, `    v === 'memory_seed' ||\n    v === 'writer_correction' ||\n    v === 'imaginal_form_create' ||\n    v === 'word_create' ||\n    v === 'action_create'`, 'tcf normalize directions', `v === 'imaginal_form_create'`);
insertAfter('src/lib/iros/tcf/tcfRotation.ts', `  const writerPatternKey = firstString(input.writerPatternKey, ctxPack.writerPatternKey, extra.writerPatternKey, meta.writerPatternKey)?.toLowerCase() ?? null;\n`, `\n  const createAxis = detectCreateConvergenceAxis({\n    userText: input.userText,\n    meta,\n    extra,\n    ctxPack,\n    preSeedCreateDirective: ctxPack.preSeedCreateDirective ?? extra.preSeedCreateDirective ?? meta.preSeedCreateDirective,\n    createProgressBridge: ctxPack.createProgressBridge ?? extra.createProgressBridge ?? meta.createProgressBridge,\n    preSeedFlowDirective: ctxPack.preSeedFlowDirective ?? extra.preSeedFlowDirective ?? meta.preSeedFlowDirective,\n    tcfStarter: ctxPack.tcfStarter ?? extra.tcfStarter ?? meta.tcfStarter,\n  });\n\n  if (createAxis !== 'none') return createAxis;\n`, 'tcf resolve create axis first', 'const createAxis = detectCreateConvergenceAxis');
insertAfter('src/lib/iros/tcf/tcfRotation.ts', `function resolveTcfWriterPatternKey(args: { cDirection: TcfCDirection; convergence: TcfConvergenceState }): string | null {\n`, `  if (args.cDirection === 'imaginal_form_create') return 'IMAGE_FIRST_CREATE_V1';\n  if (args.cDirection === 'word_create') return 'WORD_CREATE_V1';\n  if (args.cDirection === 'action_create') return 'ACTION_CREATE_V1';\n`, 'tcf writer pattern create', 'IMAGE_FIRST_CREATE_V1');
insertAfter('src/lib/iros/tcf/tcfRotation.ts', `function resolveTcfSurfacePlanKind(args: { cDirection: TcfCDirection; convergence: TcfConvergenceState }): string | null {\n`, `  if (args.cDirection === 'imaginal_form_create') return 'imaginal_create';\n  if (args.cDirection === 'word_create') return 'word_create';\n  if (args.cDirection === 'action_create') return 'action_create';\n`, 'tcf surface plan create', `return 'imaginal_create'`);
insertBefore('src/lib/iros/tcf/tcfRotation.ts', `  const previousFocus = firstString(input.previousFocus, ctxPack.previousFocus, extra.previousFocus, meta.previousFocus);\n`, `  const createAxisForFocus = detectCreateConvergenceAxis({ userText: input.userText, meta, extra, ctxPack });\n  const imageFirstDomain = createAxisForFocus === 'imaginal_form_create'\n    ? resolveImageFirstCreateDomain({ userText: input.userText, relationshipContext: ctxPack.relationshipContext ?? extra.relationshipContext ?? meta.relationshipContext, relationshipCapture: ctxPack.relationshipCapture ?? extra.relationshipCapture ?? meta.relationshipCapture, resolvedRelationId: ctxPack.resolvedRelationId ?? extra.resolvedRelationId ?? meta.resolvedRelationId, targetLabel: ctxPack.targetLabel ?? extra.targetLabel ?? meta.targetLabel, activeDiagnosisFrame: ctxPack.activeDiagnosisFrame ?? extra.activeDiagnosisFrame ?? meta.activeDiagnosisFrame, topicDigest: ctxPack.topicDigest ?? extra.topicDigest ?? meta.topicDigest, situationTopic: ctxPack.situationTopic ?? extra.situationTopic ?? meta.situationTopic, cognitionMap: ctxPack.cognitionMap ?? extra.cognitionMap ?? meta.cognitionMap })\n    : null;\n  const imageFirstFocus = imageFirstDomain ? resolveImageFirstCreateFocusLabel(imageFirstDomain) : null;\n\n`, 'tcf image first focus resolve', 'const createAxisForFocus = detectCreateConvergenceAxis');
replaceOnce('src/lib/iros/tcf/tcfRotation.ts', `  const currentFocus = firstString(\n    starterCurrentFocus,`, `  const currentFocus = firstString(\n    imageFirstFocus,\n    starterCurrentFocus,`, 'tcf currentFocus image first', 'imageFirstFocus,\n    starterCurrentFocus');
replaceOnce('src/lib/iros/tcf/tcfRotation.ts', `  const nextFocus = firstString(starter?.nextFocus, starter?.next_focus, input.nextFocus, currentFocus, previousFocus);`, `  const nextFocus = firstString(imageFirstFocus, starter?.nextFocus, starter?.next_focus, input.nextFocus, currentFocus, previousFocus);`, 'tcf nextFocus image first', 'firstString(imageFirstFocus');

log('patch preseed types/starter');
replaceOnce('src/lib/iros/server/preseed/types.ts', `  currentFocus: string | null;\n  nextFocus: string | null;\n};`, `  currentFocus: string | null;\n  nextFocus: string | null;\n\n  createAxis?: 'imaginal_form_create' | 'word_create' | 'action_create' | 'none';\n  createMode?: 'image_first_create' | 'word_create' | 'action_create' | null;\n  focusDomain?: 'relation_waiting' | 'self_next_position' | 'creative_project' | 'field_setting' | 'unknown_generic' | null;\n  writerPatternKey?: string | null;\n  avoidActionPlan?: boolean;\n};`, 'preseed starter type create fields', 'createAxis?:');
insertAfter('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `import type { PreSeedDecision, PreSeedTcfStarter } from './types';\n`, `import { detectCreateConvergenceAxis, resolveImageFirstCreateDomain, resolveImageFirstCreateFocusLabel } from '../../create/convergenceAxis';\n`, 'starter import convergenceAxis', 'resolveImageFirstCreateDomain');
insertBefore('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const cDirection: PreSeedTcfStarter['cDirection'] =`, `  const createAskActionLike = hasAny(userText, [/次に.*何をすれば/u, /どうすれば/u, /どうしたら/u, /どう動けば/u, /どう進めれば/u, /何から/u]);\n  const createAxis = detectCreateConvergenceAxis({\n    userText,\n    preSeedFlowDirective: createAskActionLike ? { flowDirection: 'place_create', createReady: true, createSource: 'I_intention', inputIntent: 'ask_action' } : null,\n  });\n  const imageFirstDomain = createAxis === 'imaginal_form_create' ? resolveImageFirstCreateDomain({ userText, cognitionMap: map, topicDigest: source, situationTopic: map?.currentPosition ?? null }) : null;\n  const imageFirstFocus = imageFirstDomain ? resolveImageFirstCreateFocusLabel(imageFirstDomain) : null;\n\n`, 'starter create axis block', 'const createAskActionLike =');
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const cDirection: PreSeedTcfStarter['cDirection'] = isWriterCorrection`, `  const cDirection: PreSeedTcfStarter['cDirection'] = createAxis !== 'none' ? createAxis : isWriterCorrection`, 'starter cDirection create axis', `createAxis !== 'none'`);
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const userReaction: PreSeedTcfStarter['userReaction'] = isWriterCorrection`, `  const userReaction: PreSeedTcfStarter['userReaction'] = createAxis === 'imaginal_form_create' ? 'ask_more' : isWriterCorrection`, 'starter userReaction create axis', `createAxis === 'imaginal_form_create' ? 'ask_more'`);
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const convergence: PreSeedTcfStarter['convergence'] = isWriterCorrection`, `  const convergence: PreSeedTcfStarter['convergence'] = createAxis === 'imaginal_form_create' ? 'partial' : isWriterCorrection`, 'starter convergence create axis', `createAxis === 'imaginal_form_create' ? 'partial'`);
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const currentFocus =\n    map?.currentPosition ||`, `  const currentFocus =\n    imageFirstFocus ||\n    map?.currentPosition ||`, 'starter currentFocus image first', 'imageFirstFocus ||\n    map?.currentPosition');
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `  const nextFocus =\n    map?.destination ||`, `  const nextFocus =\n    imageFirstFocus ||\n    map?.destination ||`, 'starter nextFocus image first', 'imageFirstFocus ||\n    map?.destination');
replaceOnce('src/lib/iros/server/preseed/preSeedTcfStarter.ts', `    currentFocus,\n    nextFocus,\n  };`, `    currentFocus,\n    nextFocus,\n    createAxis,\n    createMode: createAxis === 'imaginal_form_create' ? 'image_first_create' : createAxis === 'word_create' ? 'word_create' : createAxis === 'action_create' ? 'action_create' : null,\n    focusDomain: imageFirstDomain,\n    writerPatternKey: createAxis === 'imaginal_form_create' ? 'IMAGE_FIRST_CREATE_V1' : null,\n    avoidActionPlan: createAxis === 'imaginal_form_create',\n  };`, 'starter return create fields', 'writerPatternKey: createAxis');

log('patch orchestratorWill/rotation/orchestrator');
insertAfter('src/lib/iros/orchestratorWill.ts', `import type { DescentGate } from './will/rotationEngine';\n`, `import type { PreSeedCreateSignal } from './create/convergenceAxis';\n`, 'will import PreSeedCreateSignal', 'PreSeedCreateSignal');
replaceOnce('src/lib/iros/orchestratorWill.ts', `  descentGate?: DescentGate | null;\n};`, `  descentGate?: DescentGate | null;\n  preSeedCreateSignal?: PreSeedCreateSignal | null;\n};`, 'will args preSeedCreateSignal', 'preSeedCreateSignal?: PreSeedCreateSignal');
replaceOnce('src/lib/iros/orchestratorWill.ts', `    spinLoop,\n    descentGate,\n  } = args;`, `    spinLoop,\n    descentGate,\n    preSeedCreateSignal,\n  } = args;`, 'will destructure preSeedCreateSignal', 'preSeedCreateSignal,\n  } = args;');
insertBefore('src/lib/iros/orchestratorWill.ts', `  /* =========================================================\n     ②.5 三軸回転`, `  if (preSeedCreateSignal?.createReady === true && preSeedCreateSignal.targetKind === 'imaginal_form_create') {\n    const anyGoal: any = goal;\n    anyGoal.kind = 'enableAction';\n    anyGoal.targetKind = 'imaginal_form_create';\n    anyGoal.createAxis = 'imaginal_form_create';\n    anyGoal.reason = anyGoal.reason ? String(anyGoal.reason) + ' / Pre-SEED place_create により形象Create収束を優先' : 'Pre-SEED place_create により形象Create収束を優先';\n    anyGoal.detail = { ...(anyGoal.detail && typeof anyGoal.detail === 'object' ? anyGoal.detail : {}), preSeedCreateSignal, targetKind: 'imaginal_form_create', createAxis: 'imaginal_form_create' };\n    goal = anyGoal as IrosGoalType;\n  }\n\n`, 'will goal create signal', 'targetKind: \'imaginal_form_create\'');
insertBefore('src/lib/iros/orchestratorWill.ts', `      // 未配線（後で繋ぐ）\n      actionSignal: null,`, `      createSignal:\n        preSeedCreateSignal?.createReady === true && preSeedCreateSignal.targetKind === 'imaginal_form_create'\n          ? { ready: true, source: 'preseed', axis: 'C', direction: 'imaginal_form_create', flowDirection: preSeedCreateSignal.flowDirection ?? 'place_create', avoidActionPlan: true }\n          : null,\n\n`, 'will pass createSignal to rotation', 'createSignal:\n        preSeedCreateSignal');
replaceOnce('src/lib/iros/will/rotationEngine.ts', `  userAcceptedDescent?: boolean | null;\n\n  /**\n   * LLM自然上昇`, `  userAcceptedDescent?: boolean | null;\n  createSignal?: { ready: boolean; source: 'preseed' | 'memory' | 'manual'; axis: 'C'; direction: 'imaginal_form_create' | 'word_create' | 'action_create'; flowDirection?: string | null; avoidActionPlan?: boolean } | null;\n\n  /**\n   * LLM自然上昇`, 'rotation type createSignal', 'createSignal?: {');
replaceOnce('src/lib/iros/will/rotationEngine.ts', `    userAcceptedDescent,\n    llmSignals,`, `    userAcceptedDescent,\n    createSignal,\n    llmSignals,`, 'rotation destructure createSignal', 'createSignal,\n    llmSignals');
insertAfter('src/lib/iros/will/rotationEngine.ts', `  if (hasSevereRisk) {\n    return {\n      shouldRotate: false,\n      nextDepth: baseDepth,\n      nextSpinLoop: spinLoop,\n      nextDescentGate: gate,\n      reason: 'SoulLayer risk_flags に重いリスクがあるため回転しない',\n    };\n  }\n`, `\n  if (createSignal?.ready === true && createSignal.direction === 'imaginal_form_create') {\n    return { shouldRotate: true, nextDepth: baseDepth, nextSpinLoop: 'TCF', nextDescentGate: 'accepted', reason: 'preseed_place_create:imaginal_form_create' };\n  }\n`, 'rotation image first branch', 'preseed_place_create:imaginal_form_create');
insertAfter('src/lib/iros/orchestrator.ts', `} from './orchestratorWill';\n`, `import { buildPreSeedCreateSignal } from './create/convergenceAxis';\n`, 'orchestrator import buildPreSeedCreateSignal', 'buildPreSeedCreateSignal');
insertBefore('src/lib/iros/orchestrator.ts', `  let { goal, priority } = computeGoalAndPriority({`, `  const preSeedCreateSignal = buildPreSeedCreateSignal({ userText: text, meta, extra: (meta as any).extra ?? null, ctxPack: (meta as any).extra?.ctxPack ?? (meta as any).ctxPack ?? null, preSeedCreateDirective: (meta as any).extra?.ctxPack?.preSeedCreateDirective ?? (meta as any).preSeedCreateDirective ?? null, createProgressBridge: (meta as any).extra?.ctxPack?.createProgressBridge ?? (meta as any).createProgressBridge ?? null, preSeedFlowDirective: (meta as any).extra?.ctxPack?.preSeedFlowDirective ?? (meta as any).preSeedFlowDirective ?? null, tcfStarter: (meta as any).extra?.ctxPack?.tcfStarter ?? (meta as any).tcfStarter ?? null });\n  if (preSeedCreateSignal) {\n    (meta as any).preSeedCreateSignal = preSeedCreateSignal;\n    (meta as any).targetKind = preSeedCreateSignal.targetKind ?? null;\n    (meta as any).createAxis = preSeedCreateSignal.targetKind ?? null;\n    const extra = ((meta as any).extra ??= {});\n    const ctxPack = (extra.ctxPack ??= {});\n    ctxPack.preSeedCreateSignal = preSeedCreateSignal;\n    ctxPack.targetKind = preSeedCreateSignal.targetKind ?? null;\n    ctxPack.createAxis = preSeedCreateSignal.targetKind ?? null;\n  }\n\n`, 'orchestrator build preSeedCreateSignal', 'const preSeedCreateSignal = buildPreSeedCreateSignal');
insertBefore('src/lib/iros/orchestrator.ts', `    spinLoop:\n      (typeof lastSpinLoop`, `    preSeedCreateSignal,\n`, 'orchestrator pass preSeedCreateSignal', '    preSeedCreateSignal,');

log('patch normalChat.ts');
insertAfter('src/lib/iros/slotPlans/normalChat.ts', `import { SHIFT_PRESET_C_SENSE_HINT, SHIFT_PRESET_T_CONCRETIZE } from '../language/shiftPresets';\n`, `import { resolveImageFirstCreateDomain, resolveImageFirstCreateFocusLabel } from '../create/convergenceAxis';\n`, 'normal import convergenceAxis', 'resolveImageFirstCreateFocusLabel');
insertBefore('src/lib/iros/slotPlans/normalChat.ts', `function buildShiftTConcretize(seedText: string, focusLabel?: string) {`, `function buildImageFirstCreateSlots(args: { userText: string; ctxPack?: any; meta?: any; flowDelta?: string | null }): NormalChatSlot[] {\n  const ctxPack = args.ctxPack ?? args.meta?.extra?.ctxPack ?? {};\n  const domain = ctxPack.focusDomain ?? ctxPack.tcfStarter?.focusDomain ?? resolveImageFirstCreateDomain({ userText: args.userText, relationshipContext: ctxPack.relationshipContext, relationshipCapture: ctxPack.relationshipCapture, resolvedRelationId: ctxPack.resolvedRelationId, targetLabel: ctxPack.targetLabel, activeDiagnosisFrame: ctxPack.activeDiagnosisFrame, topicDigest: ctxPack.topicDigest, situationTopic: ctxPack.situationTopic, cognitionMap: ctxPack.cognitionMap });\n  const line = ctxPack.focusLabel ?? ctxPack.tcfStarter?.currentFocus ?? ctxPack.tcfStarter?.nextFocus ?? resolveImageFirstCreateFocusLabel(domain);\n  return [\n    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { laneKey: 'T_CONCRETIZE', createAxis: 'imaginal_form_create', focusDomain: domain, user: null }) },\n    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 't_concretize', intent: 'place_imaginal_form', hint: 'image_first_create_v1', line, source: 'tcf_rotation', createAxis: 'imaginal_form_create', focusDomain: domain, writerPattern: 'IMAGE_FIRST_CREATE_V1', contract: ['first_line_places_imaginal_form', 'no_action_plan', 'no_message_draft', 'no_checklist', 'plain_words'], rules: { no_action_plan: true, no_message_draft: true, no_send_decision: true, no_checklist: true, no_bullets: true, questions_max: 0, lines_max: 4, forbidden_words: ['紙に書く', 'メモする', '一つに絞る', '短く送る', '送るなら', '送るか送らないか', '一通', '文面', '返信', '返事', '連絡'] }, seed_text: ['形象：' + line, '出力ルール：行動案・文案例・送る/送らない判断を冒頭に出さない。', 'まず内側に置く形を一つ提示し、その意味を短く説明する。', '最後に必要なら、その形を崩さない小さな保持だけを添える。'].join('\\n') }) },\n    { key: 'NEXT', role: 'assistant', style: 'neutral', content: '@NEXT_HINT ' + JSON.stringify({ mode: 'imaginal_create_hint', laneKey: 'T_CONCRETIZE', delta: args.flowDelta ?? null, hint: '行動案ではなく、内側の形を一つ置く', message: '次は行動を増やさず、形象を先に置く' }) },\n  ];\n}\n\n`, 'normal buildImageFirstCreateSlots', 'function buildImageFirstCreateSlots');
insertAfter('src/lib/iros/slotPlans/normalChat.ts', `  const t = norm(args.userText);\n`, `  const createAxisNow = String((args as any)?.ctxPack?.createAxis ?? '').trim() || String((args as any)?.ctxPack?.targetKind ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.createAxis ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.cDirection ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.createAxis ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.targetKind ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.createAxis ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.cDirection ?? '').trim();\n  const writerPatternNow = String((args as any)?.ctxPack?.writerPatternKey ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.writerPatternKey ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.writerPatternKey ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.writerPatternKey ?? '').trim();\n  if (createAxisNow === 'imaginal_form_create' || writerPatternNow === 'IMAGE_FIRST_CREATE_V1') {\n    return buildImageFirstCreateSlots({ userText: args.userText, ctxPack: args.ctxPack, meta: args.meta, flowDelta: args.flow?.delta ?? null });\n  }\n\n`, 'normal flow early image first branch', 'const createAxisNow =');

log('git diff');
console.log(git('diff', '--', ...touched));

if (!skipTypecheck) {
  log('npm run typecheck');
  execFileSync('npm', ['run', 'typecheck'], { cwd: repo, stdio: 'inherit' });
}

log('git status');
console.log(git('status', '--short'));

if (shouldCommit) {
  log('commit');
  execFileSync('git', ['add', ...touched], { cwd: repo, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', 'Wire Pre-SEED image-first create convergence'], { cwd: repo, stdio: 'inherit' });
}

console.log('\nPatch completed. Expected route: imaginal_form_create / IMAGE_FIRST_CREATE_V1 / place_imaginal_form');
