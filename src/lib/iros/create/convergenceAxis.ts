export type CreateConvergenceAxis =
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

  // IMAGE_FIRST_CREATE_PLACE_ASK_PATTERNS_V2
  const isGenericNextActionAsk = hasAny(userText, [
    /次に.*何をすれば/u,
    /どうすれば/u,
    /どうしたら/u,
    /どう動けば/u,
    /どう進めれば/u,
    /何から/u,
    /先に.*置くもの/u,
    /先に.*置けば/u,
    /何を置く/u,
    /何を先に置く/u,
    /何を置けば/u,
    /何を先に置けば/u,
  ]);

  const hasExplicitRelationInCurrentText = hasAny(userText, [
    /相手/u,
    /恋愛/u,
    /彼/u,
    /彼女/u,
    /好き/u,
    /会う/u,
    /会え/u,
    /連絡/u,
    /LINE/u,
    /ライン/u,
    /返信/u,
    /返事/u,
    /気持ち/u,
  ]);

  if (isGenericNextActionAsk && !hasExplicitRelationInCurrentText) {
    return 'self_next_position';
  }

  if (hasRelationEvidence(args)) return 'relation_waiting';
  if (hasAny(source, [/Muverse/u, /本/u, /書籍/u, /動画/u, /画像/u, /企画/u, /事業/u, /実装/u, /コード/u, /サービス/u, /創造/u])) return 'creative_project';
  if (hasAny(source, [/場/u, /フィールド/u, /Field/u, /空間/u, /場づくり/u])) return 'field_setting';
  if (
    hasAny(userText, [
      /次に.*何をすれば/u,
      /どうすれば/u,
      /どうしたら/u,
      /どう動けば/u,
      /どう進めれば/u,
      /何から/u,
      /何を先に置けば/u,
      /何を置けば/u,
      /何を先に置く/u,
      /何を置く/u,
      /先に.*置けば/u,
      /先に.*置くもの/u,
    ])
  ) return 'self_next_position';
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
