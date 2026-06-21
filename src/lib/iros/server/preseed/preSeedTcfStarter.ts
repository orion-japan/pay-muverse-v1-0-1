import type { CognitionMap } from '../../cognition/cognitionMap';
import type { PreSeedDecision, PreSeedTcfStarter } from './types';
import { detectCreateConvergenceAxis, resolveImageFirstCreateDomain, resolveImageFirstCreateFocusLabel } from '../../create/convergenceAxis';

function text(v: unknown): string {
  return String(v ?? '').trim();
}

function hasAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

export function buildPreSeedTcfStarter(args: {
  userText: string;
  decisionKind?: string | null;
  sourceAuthority?: string | null;
  cognitionMap?: CognitionMap | null;
}): PreSeedTcfStarter {
  const userText = text(args.userText);
  const map = args.cognitionMap ?? null;
  const sourceAuthority = text(args.sourceAuthority);
  const decisionKind = text(args.decisionKind);
  const source = [
    userText,
    decisionKind,
    sourceAuthority,
    map?.relationDomain,
    map?.currentPosition,
    map?.destination,
    map?.gap?.text,
    map?.trigger?.text,
    map?.source?.kind,
  ]
    .filter(Boolean)
    .join('\n');

  const isDiagnosis =
    /diagnosis|診断/u.test(decisionKind) ||
    /diagnosis|診断/u.test(sourceAuthority) ||
    map?.source?.kind === 'diagnosis_text' ||
    hasAny(source, [/スクショ診断/u, /ir診断/u, /診断/u, /深め/u]);

  const isPerson =
    decisionKind === 'person_reference' ||
    map?.source?.kind === 'person_context' ||
    map?.relationDomain === 'fellow' ||
    hasAny(source, [/人物/u, /相手/u, /関係/u, /距離/u, /気持ち/u]);

  const isImplementation =
    map?.relationDomain === 'project' ||
    hasAny(source, [/実装/u, /修正/u, /コード/u, /typecheck/u, /npm/u, /ファイル/u, /型/u]);

  const isWriterCorrection = hasAny(userText, [
    /違う/u,
    /そうじゃない/u,
    /ズレ/u,
    /言い方/u,
    /硬い/u,
    /修正して/u,
  ]);

  const createAskActionLike = hasAny(userText, [/次に.*何をすれば/u, /どうすれば/u, /どうしたら/u, /どう動けば/u, /どう進めれば/u, /何から/u]);
  const createAxis = detectCreateConvergenceAxis({
    userText,
    preSeedFlowDirective: createAskActionLike ? { flowDirection: 'place_create', createReady: true, createSource: 'I_intention', inputIntent: 'ask_action' } : null,
  });
  const imageFirstDomain = createAxis === 'imaginal_form_create' ? resolveImageFirstCreateDomain({ userText, cognitionMap: map, topicDigest: source, situationTopic: map?.currentPosition ?? null }) : null;
  const imageFirstFocus = imageFirstDomain ? resolveImageFirstCreateFocusLabel(imageFirstDomain) : null;

  const cDirection: PreSeedTcfStarter['cDirection'] = createAxis !== 'none' ? createAxis : isWriterCorrection
    ? 'writer_correction'
    : isDiagnosis
      ? 'diagnosis_deepen'
      : isImplementation
        ? 'implementation'
        : isPerson
          ? 'relation_boundary'
          : hasAny(source, [/構造/u, /設計/u, /仕様/u, /接続/u, /TCF/u, /Pre-SEED/u])
            ? 'structure_design'
            : 'none';

  const userReaction: PreSeedTcfStarter['userReaction'] = createAxis === 'imaginal_form_create' ? 'ask_more' : isWriterCorrection
    ? 'refine'
    : hasAny(userText, [/詳しく/u, /深め/u, /もう少し/u, /続きを/u, /教えて/u, /見て/u])
      ? 'ask_more'
      : hasAny(userText, [/修正してください/u, /お願いします/u, /入れて/u, /実装/u, /作って/u])
        ? 'action'
        : 'unknown';

  const convergence: PreSeedTcfStarter['convergence'] = createAxis === 'imaginal_form_create' ? 'partial' : isWriterCorrection
    ? 'partial'
    : cDirection === 'none'
      ? 'none'
      : userReaction === 'action'
        ? 'focused'
        : 'partial';

  const currentFocus =
    imageFirstFocus ||
    map?.currentPosition ||
    (isDiagnosis
      ? '診断本文を正本にして、今回の続き相談を読む'
      : isPerson
        ? '人物文脈を正本にして、対象人物との関係・状態を読む'
        : isImplementation
          ? '実装対象を確認し、動く形へ接続する'
          : null);

  const nextFocus =
    imageFirstFocus ||
    map?.destination ||
    (isDiagnosis
      ? 'ユーザーがどう受け取り、次にどう動くかへ着地する'
      : isPerson
        ? '対象人物の現在地・関係のズレ・次に見る焦点へ整理する'
        : isImplementation
          ? '型・ctxPack・TCF接続まで通る形にする'
          : null);

  return {
    cDirection,
    userReaction,
    convergence,
    currentFocus,
    nextFocus,
    createAxis,
    createMode: createAxis === 'imaginal_form_create' ? 'image_first_create' : createAxis === 'word_create' ? 'word_create' : createAxis === 'action_create' ? 'action_create' : null,
    focusDomain: imageFirstDomain,
    writerPatternKey: createAxis === 'imaginal_form_create' ? 'IMAGE_FIRST_CREATE_V1' : null,
    avoidActionPlan: createAxis === 'imaginal_form_create',
  };
}

export function attachPreSeedTcfStarter(args: {
  decision: PreSeedDecision;
  userText: string;
  cognitionMap?: CognitionMap | null;
}): PreSeedDecision {
  const tcfStarter = buildPreSeedTcfStarter({
    userText: args.userText,
    decisionKind: args.decision.kind,
    sourceAuthority: args.decision.sourceAuthority,
    cognitionMap: args.cognitionMap ?? args.decision.cognitionMap ?? null,
  });

  return {
    ...args.decision,
    tcfStarter,
    ctxPackPatch: {
      ...(args.decision.ctxPackPatch ?? {}),
      tcfStarter,
      preSeedTcfStarterApplied: true,
    },
    metaPatch: {
      ...(args.decision.metaPatch ?? {}),
      tcfStarter,
      preSeedTcfStarterApplied: true,
    },
    debug: {
      ...(args.decision.debug ?? {}),
      tcfStarterApplied: true,
      tcfStarterDirection: tcfStarter.cDirection,
    },
  };
}
