export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  normalizeAuthz,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';
import { type ImaginalIntentionLayer } from '@/lib/iros/imaginal/imaginalCopySeed';
import {
  applyImaginalFlowSeed,
  type ImaginalFlowSeedLike,
} from '@/lib/iros/imaginal/imaginalFlowSeed';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type FirstDiagnosisFutureKind =
  | 'feared_future'
  | 'receiving_future'
  | 'expanded_role_future'
  | 'creation_future'
  | 'repair_future'
  | 'confirmation_future'
  | 'release_future'
  | 'choice_future'
  | 'unknown_future';

type FirstDiagnosisInputType = 'line_dm' | 'other';

type FirstDiagnosisCentralTheme =
  | 'receiving_gratitude'
  | 'expanded_role'
  | 'creation_seed'
  | 'relationship_repair'
  | 'reply_confirmation'
  | 'priority_abandonment'
  | 'unknown';

type FirstDiagnosisPreSeed = {
  version: 'first_diagnosis_pre_seed_v1';
  input_type: FirstDiagnosisInputType;
  role_mapping: {
    user_side: 'right_green' | 'unknown';
    other_side: 'left_white' | 'unknown';
    target: 'user_only' | 'unknown';
  };
  observed_facts?: string[];
  user_side_signals?: string[];
  other_side_context?: string[];
  possible_future_kinds?: FirstDiagnosisFutureKind[];
  avoid_future_kinds?: FirstDiagnosisFutureKind[];
  avoid_phrases?: string[];
  central_theme?: FirstDiagnosisCentralTheme;
  central_observation?: string;
  confidence?: 'high' | 'medium' | 'low';
};

type ImaginalCoreSeed = {
  future_kind?: FirstDiagnosisFutureKind;
  central_theme?: FirstDiagnosisCentralTheme;
  current_future_imaginal?: string;
  current_future_meaning?: string;
  current_state_from_future?: string;
  current_word_reaction?: string;
  current_action_reaction?: string;
  shifted_future_imaginal?: string;
  shifted_future_meaning?: string;
  shifted_state_from_future?: string;
  shifted_word_direction?: string;
  shifted_action_direction?: string;
  evidence_bridge?: string;
  current_interpretation?: string;
  future_imaginal_image?: string;
  copy_material?: string;
  copy_tone?: string;
  copy_direction?: string;
  copy_ng?: string;
  undesired_future?: string;
  avoidance_wish?: string;
  word_from_undesired_future?: string;
  action_from_undesired_future?: string;
  creative_future?: string;
  creative_word_direction?: string;
};

type FlowPerspective = {
  observed_surface?: string;
  surface_polarity?: 'pos' | 'neg' | 'mixed';
  inner_polarity?: 'pos' | 'neg' | 'mixed';
  utterance_alignment?:
    | 'aligned'
    | 'partially_aligned'
    | 'misaligned'
    | 'overstated'
    | 'understated';
  direction_kind?:
    | 'creation'
    | 'receiving'
    | 'anxiety'
    | 'fear'
    | 'confirmation'
    | 'comparison'
    | 'avoidance'
    | 'destruction'
    | 'boundary'
    | 'mixed'
    | 'unknown';
  seen_future_direction?: string;
  direction_reason?: string;
};

type ImaginalDiagnosisSeed = ImaginalFlowSeedLike & {
  kind?: 'imaginal_first';
  image_pre_seed?: FirstDiagnosisPreSeed;
  imaginal_copy?: string;
  visible_wish?: string;
  seen_future?: string;
  word_reaction?: string;
  action_reaction?: string;
  intention_layer?: ImaginalIntentionLayer;
  imaginal_core_seed?: ImaginalCoreSeed;
  flow_perspective?: FlowPerspective;
  dominant_field?: 'anxiety' | 'comparison' | 'destruction' | 'creation' | 'unknown';
  creative_direction?: string;
  today_step?: string;
  image_type?:
    | 'line_or_dm'
    | 'email'
    | 'memo'
    | 'todo'
    | 'post_draft'
    | 'book_page'
    | 'application_page'
    | 'other';
  evidence_points?: string[];
  uncertain_points?: string[];
  user_name_candidate?: string;
  writer_directives?: string[];
};

function json(data: unknown, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

function normalizeDataUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (!v.startsWith('data:image/')) return null;
  if (!v.includes(';base64,')) return null;
  return v;
}

function cleanString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const s = value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join('、');
    return s || undefined;
  }

  const s = String(value ?? '').trim();
  return s || undefined;
}

function cleanStringArray(value: unknown, limit = 8): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
  return items.length ? items : undefined;
}

function normalizeFutureKind(value: unknown): FirstDiagnosisFutureKind {
  const v = String(value ?? '').trim();
  if (
    v === 'feared_future' ||
    v === 'receiving_future' ||
    v === 'expanded_role_future' ||
    v === 'creation_future' ||
    v === 'repair_future' ||
    v === 'confirmation_future' ||
    v === 'release_future' ||
    v === 'choice_future' ||
    v === 'unknown_future'
  ) {
    return v;
  }
  return 'unknown_future';
}

function normalizeFutureKindArray(value: unknown): FirstDiagnosisFutureKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(normalizeFutureKind)
    .filter((item, idx, arr) => arr.indexOf(item) === idx)
    .slice(0, 6);
  return items.length ? items : undefined;
}

function normalizeCentralTheme(value: unknown): FirstDiagnosisCentralTheme {
  const v = String(value ?? '').trim();
  if (
    v === 'receiving_gratitude' ||
    v === 'expanded_role' ||
    v === 'creation_seed' ||
    v === 'relationship_repair' ||
      v === 'reply_confirmation' ||
    v === 'priority_abandonment'
  ) {
    return v;
  }
  return 'unknown';
}

function normalizeInputType(value: unknown): FirstDiagnosisInputType {
  return String(value ?? '').trim() === 'line_dm' ? 'line_dm' : 'other';
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const v = String(value ?? '').trim();
  if (v === 'high' || v === 'low') return v;
  return 'medium';
}

function normalizePreSeedRoleMapping(value: unknown): FirstDiagnosisPreSeed['role_mapping'] {
  const v = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  const userSide = String(v.user_side ?? v.userSide ?? '').trim() === 'right_green'
    ? 'right_green'
    : 'unknown';

  const otherSide = String(v.other_side ?? v.otherSide ?? '').trim() === 'left_white'
    ? 'left_white'
    : 'unknown';

  const target = String(v.target ?? '').trim() === 'user_only'
    ? 'user_only'
    : 'unknown';

  return {
    user_side: userSide,
    other_side: otherSide,
    target,
  };
}

function normalizeFirstDiagnosisPreSeed(value: unknown): FirstDiagnosisPreSeed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const preSeed: FirstDiagnosisPreSeed = {
    version: 'first_diagnosis_pre_seed_v1',
    input_type: normalizeInputType(v.input_type ?? v.inputType),
    role_mapping: normalizePreSeedRoleMapping(v.role_mapping ?? v.roleMapping),
    observed_facts: cleanStringArray(v.observed_facts ?? v.observedFacts, 10),
    user_side_signals: cleanStringArray(v.user_side_signals ?? v.userSideSignals, 10),
    other_side_context: cleanStringArray(v.other_side_context ?? v.otherSideContext, 10),
    possible_future_kinds: normalizeFutureKindArray(v.possible_future_kinds ?? v.possibleFutureKinds),
    avoid_future_kinds: normalizeFutureKindArray(v.avoid_future_kinds ?? v.avoidFutureKinds),
    avoid_phrases: cleanStringArray(v.avoid_phrases ?? v.avoidPhrases, 12),
    central_theme: normalizeCentralTheme(v.central_theme ?? v.centralTheme),
    central_observation: cleanString(v.central_observation ?? v.centralObservation),
    confidence: normalizeConfidence(v.confidence),
  };

  return preSeed;
}



function hasHardReplyConfirmationSignal(preSeed: FirstDiagnosisPreSeed | undefined): boolean {
  if (!preSeed || preSeed.input_type !== 'line_dm') return false;

  const text = [
    ...(preSeed.observed_facts ?? []),
    ...(preSeed.user_side_signals ?? []),
    ...(preSeed.other_side_context ?? []),
    preSeed.central_observation ?? '',
  ].join('\n');

  return /まって|待って|寝ちゃった|ねちゃった|寝た|ねた|掛け直|かけ直|10分後|No answer|Missed|不在着信|電話に出ない|通話に出ない|折り返し|応答がない|返事がない|返信がない|既読スルー|未返信/u.test(text);
}
function strengthenLineDmConfirmationPreSeed(preSeed: FirstDiagnosisPreSeed): FirstDiagnosisPreSeed {
  if (preSeed.input_type !== 'line_dm') return preSeed;

  if (!hasHardReplyConfirmationSignal(preSeed)) return preSeed;

  const possible = preSeed.possible_future_kinds ?? [];
  const avoid = preSeed.avoid_future_kinds ?? [];

  return {
    ...preSeed,
    possible_future_kinds: [
      'confirmation_future',
      ...possible.filter((k) => k !== 'confirmation_future' && k !== 'choice_future'),
    ],
    avoid_future_kinds: [
      ...avoid,
      'choice_future',
    ].filter((v, i, arr) => arr.indexOf(v) === i),
    central_theme:
      preSeed.central_theme === 'unknown'
        ? 'reply_confirmation'
        : preSeed.central_theme,
    central_observation:
      preSeed.central_observation ||
      'ユーザーは相手を責めるより、返事・折り返し・応答の有無から関係の温度を確認しようとしている。',
  };
}
function defaultUnsupportedPreSeed(): FirstDiagnosisPreSeed {
  return {
    version: 'first_diagnosis_pre_seed_v1',
    input_type: 'other',
    role_mapping: {
      user_side: 'unknown',
      other_side: 'unknown',
      target: 'unknown',
    },
    observed_facts: [],
    user_side_signals: [],
    other_side_context: [],
    possible_future_kinds: ['unknown_future'],
    avoid_future_kinds: [],
    avoid_phrases: [],
    central_theme: 'unknown',
    central_observation: 'LINE/DMの会話スクリーンショットとして十分に確認できませんでした。',
    confidence: 'low',
  };
}

function normalizeDominantField(value: unknown): ImaginalDiagnosisSeed['dominant_field'] {
  const v = String(value ?? '').trim();
  if (v === 'anxiety' || v === 'comparison' || v === 'destruction' || v === 'creation') return v;
  return 'unknown';
}

function normalizeImageType(value: unknown): ImaginalDiagnosisSeed['image_type'] {
  const v = String(value ?? '').trim();
  if (
    v === 'line_or_dm' ||
    v === 'email' ||
    v === 'memo' ||
    v === 'todo' ||
    v === 'post_draft' ||
    v === 'book_page' ||
    v === 'application_page' ||
    v === 'other'
  ) {
    return v;
  }
  return 'other';
}

function normalizeIntentionLayer(value: unknown): ImaginalIntentionLayer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const layer: ImaginalIntentionLayer = {
    received_meaning: cleanString(v.received_meaning ?? v.receivedMeaning),
    seen_future: cleanString(v.seen_future ?? v.seenFuture),
    hidden_intention: cleanString(v.hidden_intention ?? v.hiddenIntention),
    future_distortion: cleanString(v.future_distortion ?? v.futureDistortion),
  };

  return Object.values(layer).some(Boolean) ? layer : undefined;
}

function normalizeImaginalCoreSeed(value: unknown): ImaginalCoreSeed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const seed: ImaginalCoreSeed = {
    future_kind: normalizeFutureKind(v.future_kind ?? v.futureKind),
    central_theme: normalizeCentralTheme(v.central_theme ?? v.centralTheme),
    current_future_imaginal: cleanString(v.current_future_imaginal ?? v.currentFutureImaginal),
    current_future_meaning: cleanString(v.current_future_meaning ?? v.currentFutureMeaning),
    current_state_from_future: cleanString(v.current_state_from_future ?? v.currentStateFromFuture),
    current_word_reaction: cleanString(v.current_word_reaction ?? v.currentWordReaction),
    current_action_reaction: cleanString(v.current_action_reaction ?? v.currentActionReaction),
    shifted_future_imaginal: cleanString(v.shifted_future_imaginal ?? v.shiftedFutureImaginal),
    shifted_future_meaning: cleanString(v.shifted_future_meaning ?? v.shiftedFutureMeaning),
    shifted_state_from_future: cleanString(v.shifted_state_from_future ?? v.shiftedStateFromFuture),
    shifted_word_direction: cleanString(v.shifted_word_direction ?? v.shiftedWordDirection),
    shifted_action_direction: cleanString(v.shifted_action_direction ?? v.shiftedActionDirection),
    evidence_bridge: cleanString(v.evidence_bridge ?? v.evidenceBridge),
    current_interpretation: cleanString(v.current_interpretation ?? v.currentInterpretation),
    future_imaginal_image: cleanString(v.future_imaginal_image ?? v.futureImaginalImage),
    copy_material: cleanString(v.copy_material ?? v.copyMaterial),
    copy_tone: cleanString(v.copy_tone ?? v.copyTone),
    copy_direction: cleanString(v.copy_direction ?? v.copyDirection),
    copy_ng: cleanString(v.copy_ng ?? v.copyNg),
    undesired_future: cleanString(v.undesired_future ?? v.undesiredFuture),
    avoidance_wish: cleanString(v.avoidance_wish ?? v.avoidanceWish),
    word_from_undesired_future: cleanString(v.word_from_undesired_future ?? v.wordFromUndesiredFuture),
    action_from_undesired_future: cleanString(v.action_from_undesired_future ?? v.actionFromUndesiredFuture),
    creative_future: cleanString(v.creative_future ?? v.creativeFuture),
    creative_word_direction: cleanString(v.creative_word_direction ?? v.creativeWordDirection),
  };
  return Object.values(seed).some(Boolean) ? seed : undefined;
}

function normalizeDiagnosisScope(value: unknown): ImaginalDiagnosisSeed['diagnosis_scope'] | undefined {
  return String(value ?? '').trim() === 'current_imaginal' ? 'current_imaginal' : undefined;
}

function normalizeFlowPriority(value: unknown): true | undefined {
  return value === true || String(value ?? '').trim() === 'true' ? true : undefined;
}

function normalizeFlowPolarity(value: unknown): FlowPerspective['surface_polarity'] {
  const v = String(value ?? '').trim();
  if (v === 'pos' || v === 'neg' || v === 'mixed') return v;
  return undefined;
}

function normalizeFlowUtteranceAlignment(value: unknown): FlowPerspective['utterance_alignment'] {
  const v = String(value ?? '').trim();
  if (
    v === 'aligned' ||
    v === 'partially_aligned' ||
    v === 'misaligned' ||
    v === 'overstated' ||
    v === 'understated'
  ) {
    return v;
  }
  return undefined;
}

function normalizeDirectionKind(value: unknown): FlowPerspective['direction_kind'] {
  const v = String(value ?? '').trim();
  if (
    v === 'creation' ||
    v === 'receiving' ||
    v === 'anxiety' ||
    v === 'fear' ||
    v === 'confirmation' ||
    v === 'comparison' ||
    v === 'avoidance' ||
    v === 'destruction' ||
    v === 'boundary' ||
    v === 'mixed' ||
    v === 'unknown'
  ) {
    return v;
  }
  return 'unknown';
}

function normalizeFlowPerspective(value: unknown): FlowPerspective | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const perspective: FlowPerspective = {
    observed_surface: cleanString(v.observed_surface ?? v.observedSurface),
    surface_polarity: normalizeFlowPolarity(v.surface_polarity ?? v.surfacePolarity),
    inner_polarity: normalizeFlowPolarity(v.inner_polarity ?? v.innerPolarity),
    utterance_alignment: normalizeFlowUtteranceAlignment(v.utterance_alignment ?? v.utteranceAlignment),
    direction_kind: normalizeDirectionKind(v.direction_kind ?? v.directionKind),
    seen_future_direction: cleanString(v.seen_future_direction ?? v.seenFutureDirection),
    direction_reason: cleanString(v.direction_reason ?? v.directionReason),
  };

  return Object.values(perspective).some(Boolean) ? perspective : undefined;
}


function strengthenConfirmationDiagnosisSeed(seed: ImaginalDiagnosisSeed | null): ImaginalDiagnosisSeed | null {
  if (!seed) return seed;

  const preSeed = seed.image_pre_seed;
  const isHardReplyConfirmation = hasHardReplyConfirmationSignal(preSeed);

  if (!isHardReplyConfirmation) return seed;

  const currentCore = seed.imaginal_core_seed ?? {};
  const currentFlow = seed.flow_perspective ?? {};

  return {
    ...seed,
    imaginal_core_seed: {
      ...currentCore,
      future_kind: 'confirmation_future',
      central_theme: 'reply_confirmation',
      current_future_imaginal:
        '待っても応答が戻らないかもしれない未来',
      current_future_meaning:
        '相手を責めたいのではなく、返事や折り返しの有無から関係の温度を確かめようとしている。',
      current_state_from_future:
        '返事が戻るまで安心が決まりにくく、画面の反応を見続けやすい状態。',
      current_word_reaction:
        '「待って」「掛け直す」「寝ちゃった？」のように、相手の状態と応答を確かめる言葉が出ている。',
      current_action_reaction:
        '待つ、掛け直す、通話結果を見るという確認の動きが出ている。',
      shifted_future_imaginal:
        '返事の有無で安心を失わず、自分の時間へ戻れる未来',
      shifted_future_meaning:
        '相手の反応を待つ間も、自分の状態を相手に預けすぎない。',
      shifted_word_direction:
        '追加で確認する前に、待つ時間を一つ決める。',
      shifted_action_direction:
        'いったん画面を閉じて、自分の作業や休む時間へ戻る。',
      copy_material:
        '待つ、掛け直す、返ってこないかもしれない未来',
      copy_tone:
        'やわらかいが核心を外さない',
      copy_direction:
        '確認し続ける未来から、自分の状態を取り戻す方向',
      copy_ng:
        '言葉を置き直す橋、関係修復、分かれ道、地図',
    },
    flow_perspective: {
      ...currentFlow,
      observed_surface:
        currentFlow.observed_surface || '相手を気遣いながら、待って掛け直している。',
      surface_polarity:
        currentFlow.surface_polarity || 'mixed',
      inner_polarity:
        'neg',
      utterance_alignment:
        currentFlow.utterance_alignment || 'partially_aligned',
      direction_kind:
        'confirmation',
      seen_future_direction:
        '返事や折り返しが戻らないかもしれない未来を見ている。',
      direction_reason:
        '待つ、掛け直す、通話に出ない、寝たか確認する流れが画像上にあるため。',
    },
    creative_direction:
      '返事の有無で安心を失わず、自分の時間へ戻る方向。',
    today_step:
      '追加で確認する前に、待つ時間を一つ決めて、その間は画面を閉じる。',
    writer_directives: [
      ...(seed.writer_directives ?? []),
      'reply_confirmation の場合は repair_future / boundary に戻さない',
      '見続けている未来は返事が戻らないかもしれない未来として書く',
      '創造の未来は相手の返事ではなく自分の状態を取り戻す未来として書く',
    ],
  };
}
function buildDisplayText(seed: ImaginalDiagnosisSeed, fallback: string): string {
  const copy = cleanString(seed.imaginal_copy);
  if (!copy) return fallback;
  const core = seed.imaginal_core_seed;

  return [
    'あなたのイマジナルコピー',
    copy,
    '',
    'いま見えている願い',
    cleanString(core?.current_state_from_future) ||
      cleanString(core?.avoidance_wish) ||
      cleanString(seed.visible_wish) ||
      'この画像を出した時点で反応している一点を、言葉にしようとしています。',
    '',
    '見続けている未来',
    cleanString(core?.current_future_imaginal) ||
      cleanString(core?.undesired_future) ||
      cleanString(seed.seen_future) ||
      'まだ断定せず、今立ち上がっている方向を観測しています。',
    '',
    '言葉に出ている反応',
    cleanString(core?.current_word_reaction) ||
      cleanString(core?.word_from_undesired_future) ||
      cleanString(seed.word_reaction) ||
      'その未来に触れて、確認や受け取りの言葉が出ています。',
    '',
    '行動に出ている反応',
    cleanString(core?.current_action_reaction) ||
      cleanString(core?.action_from_undesired_future) ||
      cleanString(seed.action_reaction) ||
      'その未来に触れて、もう少し見たい動きが出ています。',
    '',
    '創造の未来',
    cleanString(core?.shifted_future_imaginal) ||
      cleanString(core?.creative_future) ||
      cleanString(seed.creative_direction) ||
      '今見えている方向を、次の創造へ置き直すことです。',
    '',
    '今日の小さな一歩',
    cleanString(core?.shifted_word_direction) ||
      cleanString(core?.creative_word_direction) ||
      cleanString(seed.today_step) ||
      '見えている未来を一文にして、今日の行動へ戻してください。',
    '',
    'これは、画像をきっかけに見えた「今現在のイマジナル」です。',
  ].join('\n');
}

function safeParseDiagnosis(raw: string, preSeed?: FirstDiagnosisPreSeed): {
  displayText: string;
  seed: ImaginalDiagnosisSeed | null;
} {
  const fallback = { displayText: raw, seed: null };

  try {
    const parsed = JSON.parse(raw.trim());
    const seedRaw = parsed?.seed && typeof parsed.seed === 'object' && !Array.isArray(parsed.seed)
      ? parsed.seed
      : parsed;

    const coreSeed = normalizeImaginalCoreSeed(seedRaw?.imaginal_core_seed ?? seedRaw?.imaginalCoreSeed);
    const imagePreSeed =
      normalizeFirstDiagnosisPreSeed(seedRaw?.image_pre_seed ?? seedRaw?.imagePreSeed) ||
      preSeed;

    const seed: ImaginalDiagnosisSeed = {
      kind: 'imaginal_first',
      image_pre_seed: imagePreSeed,
      imaginal_copy: cleanString(seedRaw?.imaginal_copy ?? seedRaw?.imaginalCopy),
      visible_wish: cleanString(seedRaw?.visible_wish ?? seedRaw?.visibleWish),
      seen_future: cleanString(seedRaw?.seen_future ?? seedRaw?.seenFuture),
      word_reaction: cleanString(seedRaw?.word_reaction ?? seedRaw?.wordReaction),
      action_reaction: cleanString(seedRaw?.action_reaction ?? seedRaw?.actionReaction),
      intention_layer: normalizeIntentionLayer(seedRaw?.intention_layer ?? seedRaw?.intentionLayer),
      imaginal_core_seed: coreSeed,
      flow_perspective: normalizeFlowPerspective(seedRaw?.flow_perspective ?? seedRaw?.flowPerspective),
      diagnosis_scope: normalizeDiagnosisScope(seedRaw?.diagnosis_scope ?? seedRaw?.diagnosisScope),
      flow_priority: normalizeFlowPriority(seedRaw?.flow_priority ?? seedRaw?.flowPriority),
      image_seed: seedRaw?.image_seed ?? seedRaw?.imageSeed,
      current_flow_input_seed: seedRaw?.current_flow_input_seed ?? seedRaw?.currentFlowInputSeed,
      second_flow_input_seed: seedRaw?.second_flow_input_seed ?? seedRaw?.secondFlowInputSeed,
      dominant_field: normalizeDominantField(seedRaw?.dominant_field ?? seedRaw?.dominantField),
      creative_direction: cleanString(seedRaw?.creative_direction ?? seedRaw?.creativeDirection),
      today_step: cleanString(seedRaw?.today_step ?? seedRaw?.todayStep),
      image_type: normalizeImageType(seedRaw?.image_type ?? seedRaw?.imageType),
      evidence_points: cleanStringArray(seedRaw?.evidence_points ?? seedRaw?.evidencePoints),
      uncertain_points: cleanStringArray(seedRaw?.uncertain_points ?? seedRaw?.uncertainPoints),
      user_name_candidate: cleanString(seedRaw?.user_name_candidate ?? seedRaw?.userNameCandidate) || '',
      writer_directives: [
        'Mu文体で返す',
        '説明調にしない',
        '相手の気持ちは断定しない',
        '画像観測Pre-SEEDを正本にする',
        '怖い未来へ固定しない',
        '受け取り・役割拡張・創造の未来も読む',
      ],
    };

    Object.assign(seed, applyImaginalFlowSeed(seed));

    const displayText = buildDisplayText(seed, raw);

    return { displayText, seed };
  } catch {
    return fallback;
  }
}


function isLowQualityFirstDiagnosisText(text: string): boolean {
  const normalized = String(text ?? '').replace(/\s/g, '');
  if (normalized.length < 260) return true;

  const requiredHeadings = [
    'あなたのイマジナルコピー',
    'いま見えている願い',
    '見続けている未来',
    '言葉に出ている反応',
    '行動に出ている反応',
    '創造の未来',
    '今日の小さな一歩',
  ];

  const missingCount = requiredHeadings.filter((heading) => !text.includes(heading)).length;
  return missingCount >= 2;
}
function normalizeWriterDisplayText(value: unknown, fallback: string): string {
  const text = cleanString(value);
  const base = text || fallback;
  const note = 'これは、画像をきっかけに見えた「今現在のイマジナル」です。';
  const withoutNote = base
    .replace(/注意書き\s*[:：]?\s*/gu, '')
    .replace(/注意\s*[:：].*?(?=\n\n|\nこれは、画像をきっかけに見えた|$)/gsu, '')
    .replace(/ここに書かれたのは、画像をきっかけに立ち上がっている流れとして見えたもので、相手の状況や意図を断定するものではありません。\s*/gu, '')
    .replace(/これは、画像をきっかけに見えた「今現在のイマジナル」です。\s*/gu, '')
    .trim();
  return [withoutNote, note].filter(Boolean).join('\n\n').trim();
}

async function createFirstDiagnosisPreSeed(params: {
  apiKey: string;
  model: string;
  imageDataUrl: string;
  note: string;
  uploadType: string;
}): Promise<FirstDiagnosisPreSeed> {
  const { apiKey, model, imageDataUrl, note, uploadType } = params;

  const system = [
    'あなたはMuverseの初回イマジナル診断の画像観測者です。',
    '診断文は書かず、画像から観測Pre-SEEDだけを作ってください。',
    '対象はLINE/DMなどの会話スクリーンショットです。',
    '右側・緑の吹き出しはユーザー本人、左側・白の吹き出しは相手として読んでください。',
    '画面上部の名前は相手名です。ユーザー名として扱わないでください。',
    '読むものは、表示されている文章、左右の発話、時刻、既読表示、着信・不在着信、スタンプ、絵文字、返信間隔だけです。',
    '相手の気持ち、人格、運命は断定しないでください。',
    'observed_facts には画像上で見える事実だけを短く入れてください。',
    'user_side_signals には右側ユーザー発話から見える反応を短く入れてください。',
    'other_side_context には左側相手発話の文脈を短く入れてください。',
    'possible_future_kinds は候補を最大3つまで入れてください。',
    '候補は feared_future / receiving_future / expanded_role_future / creation_future / repair_future / confirmation_future / release_future / choice_future / unknown_future です。',
    'receiving_future は、感謝・助かった・続いている・大人気・良い報告などを受け取っている時です。',
    'expanded_role_future は、ユーザーの関わりや役割の影響が広がって見える時です。',
    'confirmation_future は、不在着信、No answer、Missed、応答なし、掛け直し、電話に出ない、寝ちゃった？など未応答そのものが画像に明確な時だけです。',
    '普通の既読、質問、近況確認、感謝への返答だけでは confirmation_future にしないでください。',
    'central_observation は、この画像の中心を一文で書いてください。',
    '出力はJSONのみ。pre_seed だけを持つオブジェクトにしてください。',
    'pre_seed.version は first_diagnosis_pre_seed_v1。',
    'pre_seed.input_type は line_dm または other。',
    'pre_seed.role_mapping は user_side, other_side, target を持たせてください。',
  ].join('\n');

  const userText = [
    'この画像を読み、初回イマジナル診断用のPre-SEEDだけをJSONで作ってください。',
    '重要: 文章内容、着信/不在着信、既読、スタンプ、絵文字、左右の発話を観測してください。',
    '重要: 既読表示だけを未応答や不安とは読まないでください。',
    '重要: 感謝・助かった・続いている・大人気などが中心なら receiving_future / expanded_role_future を優先してください。',
    `アップロード種別: ${uploadType}`,
    note ? `補足メモ: ${note}` : '',
  ].filter(Boolean).join('\n');

  const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!llmRes.ok) {
    const detail = await llmRes.text().catch(() => '');
    throw new Error(`pre_seed_llm_failed: ${detail.slice(0, 500)}`);
  }

  const data = await llmRes.json().catch(() => ({}));
  const raw = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
  if (!raw) return defaultUnsupportedPreSeed();

  try {
    const parsed = JSON.parse(String(raw).trim());
    return normalizeFirstDiagnosisPreSeed(parsed?.pre_seed ?? parsed?.preSeed ?? parsed) || defaultUnsupportedPreSeed();
  } catch {
    return defaultUnsupportedPreSeed();
  }
}


function chooseFutureKindFromPreSeed(preSeed: FirstDiagnosisPreSeed): FirstDiagnosisFutureKind {
  const kinds = preSeed.possible_future_kinds ?? [];
  const pick = (k: FirstDiagnosisFutureKind) => kinds.includes(k) ? k : null;

  const observedText = [
    preSeed.central_observation,
    ...(preSeed.observed_facts ?? []),
    ...(preSeed.user_side_signals ?? []),
    ...(preSeed.other_side_context ?? []),
  ].filter(Boolean).join(' ');

  const hasReceivingOrRole =
    Boolean(pick('receiving_future') || pick('expanded_role_future'));

  const hasScheduleCoordinationSignal =
    /(レストラン|予約|予定調整|日程調整|取りました|取れました|店|お店|地図|map|maps|Event updated|カレンダー|集合|待ち合わせ|返事もらえると|お返事もらえると|先に.{0,12}返事|先に.{0,12}お返事)/i.test(observedText);

  if (hasScheduleCoordinationSignal) {
    return (
      pick('choice_future') ||
      pick('repair_future') ||
      pick('confirmation_future') ||
      'choice_future'
    );
  }

  const hasHardNoResponseSignal =
    /不在着信|着信なし|応答なし|No answer|Missed|未読スルー|既読スルー|折り返し待ち|掛け直す|かけ直す|掛け直し|かけ直し|電話に出ない|寝ちゃった|ねちゃった/.test(observedText);

  if (hasHardNoResponseSignal && pick('confirmation_future') && !hasReceivingOrRole) {
    return 'confirmation_future';
  }

  return (
    pick('receiving_future') ||
    pick('expanded_role_future') ||
    pick('creation_future') ||
    pick('repair_future') ||
    pick('feared_future') ||
    pick('release_future') ||
    pick('choice_future') ||
    pick('confirmation_future') ||
    'unknown_future'
  );
}

function directionKindFromFutureKind(kind: FirstDiagnosisFutureKind): string {
  if (kind === 'confirmation_future') return 'confirmation';
  if (kind === 'receiving_future') return 'receiving';
  if (kind === 'expanded_role_future') return 'receiving';
  if (kind === 'creation_future') return 'creation';
  if (kind === 'repair_future') return 'boundary';
  if (kind === 'feared_future') return 'fear';
  if (kind === 'release_future') return 'boundary';
  if (kind === 'choice_future') return 'mixed';
  return 'unknown';
}

function buildCoreSeedFromPreSeed(preSeed: FirstDiagnosisPreSeed): string {
  const futureKind = chooseFutureKindFromPreSeed(preSeed);
  const directionKind = directionKindFromFutureKind(futureKind);
  const observed = [
    ...(preSeed.user_side_signals ?? []),
    ...(preSeed.observed_facts ?? []),
  ].filter(Boolean).slice(0, 5).join(' / ');

  const currentByKind: Record<string, string> = {
    confirmation_future: '返ってこないかもしれない未来を見ながら、確認を続けている。',
    receiving_future: '感謝や良い反応を受け取りながら、まだ控えめに畳んでいる。',
    expanded_role_future: '役割が広がる未来を見始めている。',
    creation_future: '創造が形になり始める未来を見ている。',
    repair_future: '関係や言葉を置き直す未来を見ている。',
    feared_future: '望まない結果になるかもしれない未来を見ている。',
    release_future: '手放してよいものを見ている。',
    choice_future: 'どちらに進むかを選び始めている。',
    unknown_future: 'まだ名前のついていない未来を見ている。',
  };

  const shiftedByKind: Record<string, string> = {
    confirmation_future: '返事の有無で安心を失わず、自分の時間へ戻る方向。',
    receiving_future: '感謝を自分の力として受け取り、無理なく持てる方向。',
    expanded_role_future: '役割を全部背負わず、引き受ける範囲を自分で選ぶ方向。',
    creation_future: '形になり始めたものを、自分のペースで育てる方向。',
    repair_future: '相手を変えようとせず、言葉と距離を置き直す方向。',
    feared_future: '怖い未来を確かめ続けず、今できる一歩へ戻る方向。',
    release_future: '握りしめていたものを少しゆるめる方向。',
    choice_future: '迷い続けるのではなく、今日選べる範囲を決める方向。',
    unknown_future: '今見えている反応を、次の創造へ置き直す方向。',
  };

  const copyByKind: Record<string, string> = {
    confirmation_future: '確かめながら、返ってこない不安の未来',
    receiving_future: '感謝を受け取りながら、芽を広げる未来',
    expanded_role_future: '役割の風船をそっと持つ未来',
    creation_future: '小さな形が灯りはじめる未来',
    repair_future: '言葉を置き直す橋の未来',
    feared_future: '見張りながら、不安を大きくする未来',
    release_future: '握った荷物を少しほどく未来',
    choice_future: '分かれ道の前で地図を広げる未来',
    unknown_future: 'まだ名前のない景色を見る未来',
  };

  const core: ImaginalCoreSeed = {
    future_kind: futureKind,
    central_theme: preSeed.central_theme,
    current_future_imaginal: currentByKind[futureKind],
    current_future_meaning: observed || preSeed.central_observation || '画像上の言葉と反応から見える現在の未来形象。',
    current_state_from_future: currentByKind[futureKind],
    current_word_reaction: (preSeed.user_side_signals ?? []).slice(0, 2).join(' / ') || undefined,
    current_action_reaction: observed || undefined,
    shifted_future_imaginal: shiftedByKind[futureKind],
    shifted_future_meaning: shiftedByKind[futureKind],
    shifted_word_direction: shiftedByKind[futureKind],
    shifted_action_direction: shiftedByKind[futureKind],
    evidence_bridge: observed || preSeed.central_observation,
    copy_material: copyByKind[futureKind],
  };

  return JSON.stringify({
    seed: {
      kind: 'imaginal_first',
      image_type: 'line_or_dm',
      image_pre_seed: preSeed,
      imaginal_copy: copyByKind[futureKind],
      visible_wish: core.current_state_from_future,
      seen_future: core.current_future_imaginal,
      imaginal_core_seed: core,
      flow_perspective: {
        observed_surface: preSeed.central_observation || observed || '会話画面の反応',
        surface_polarity: 'mixed',
        inner_polarity: directionKind === 'receiving' || directionKind === 'creation' ? 'mixed' : 'neg',
        utterance_alignment: 'partially_aligned',
        direction_kind: directionKind,
        seen_future_direction: core.current_future_imaginal,
        direction_reason: observed || preSeed.central_observation || '画像上の言葉と行動から判断',
      },
      diagnosis_scope: 'current_imaginal',
      flow_priority: true,
      dominant_field: directionKind === 'confirmation' || directionKind === 'fear' ? 'anxiety' : 'creation',
      creative_direction: core.shifted_future_imaginal,
      today_step: core.shifted_word_direction,
    },
  });
}
async function createFirstDiagnosisCoreSeed(params: {
  apiKey: string;
  model: string;
  preSeed: FirstDiagnosisPreSeed;
  note: string;
}): Promise<string> {
  const { apiKey, model, preSeed, note } = params;

  const system = [
    'あなたはMuverseの初回イマジナル診断のCore Seedを作るMuです。',
    '前段の image_pre_seed だけを正本にしてください。',
    'ここでは画像を見直しません。Pre-SEEDにない意味を足さないでください。',
    'Core Seedでは前回の診断文、過去のスクショ、過去の回答内容を使わないでください。',
    'このPOSTで渡された image_pre_seed だけを使ってください。',
    'Core Seedでは、Pre-SEEDの possible_future_kinds から中心となる future_kind を選んでください。',
    '合わない場合は unknown_future にしてください。既存テンプレへ無理に寄せないでください。',
    '未来のイマジナルは、怖い未来だけではありません。',
    'feared_future は、Pre-SEEDで明確に候補になっている場合だけ使ってください。',
    'receiving_future は、すでに来ている良い未来・感謝・成果を受け取りきれていない状態です。',
    'expanded_role_future は、もっとできることがある、もっと広げられる、大きな役割が見え始めている状態です。',
    'creation_future は、企画・仕事・作品・場が形になり始めている状態です。',
    'repair_future は、関係や言葉を置き直す未来です。',
    'CORE_CONFIRMATION_ESCAPE_RULES_V2',
    'confirmation_future は、返事・応答・既読・折り返し・待機・再接続を確かめ続けている未来です。',
    'confirmation_future の current_future_imaginal は「つながりを取り戻す未来」ではありません。',
    'confirmation_future の current_future_imaginal は「呼びかけても返ってこない未来」「待っても応答が戻らない未来」「自分だけがつなぎ直そうとしている未来」「このまま途切れるかもしれない未来」のいずれかに寄せてください。',
    'confirmation_future の shifted_future_imaginal は、相手から返事が来る未来にしないでください。',
    'confirmation_future の shifted_future_imaginal は、「返事の有無で安心を失わない未来」「確認し続ける流れから抜ける未来」「待つ時間を決めて自分の時間へ戻れる未来」「追加確認を減らし、自分の状態を取り戻す未来」のいずれかに寄せてください。',
    'confirmation_future の shifted_future_meaning には、「相手の返事が安心の条件ではない」「返事を待つ間も自分の状態を相手に預けすぎない」「確認ではなく自分の時間へ戻る」を入れてください。',
    'confirmation_future では、「落ち着いたタイミングで折り返しがある」「短い折り返しが安心材料になる」「返事が来ることで安心する」「相手からの返信で待ち方を置き直す」は shifted_future_imaginal に使わないでください。',
    '表面で「大丈夫」と相手を気づかっていても、その後に確認・待機・再接続の言葉が出ている場合、inner_polarity は neg、direction_kind は confirmation または anxiety にしてください。',
    'PRESEED_CONFIRMATION_FUTURE_RULES_V2',
    'confirmation_future は、返事・応答・既読・折り返し・待機・再接続を確かめ続けている未来です。',
    '右側ユーザー発言に「まって」「待って」「寝ちゃった？」「ねちゃった？」「掛け直す」「かけ直す」「10分後」「終わったらで大丈夫」「既読」「返事」「返信」「電話」に相当する確認・待機・再接続の動きがある場合は、confirmation_future を必ず候補に入れてください。',
    'confirmation_future は repair_future ではありません。repair_future は関係や言葉を置き直す方向です。confirmation_future は、返ってこないかもしれない未来を先に見て、確認し続けている状態です。',
    '確認・待機・再接続の動きが中心の場合、repair_future だけで終わらせないでください。',


    'release_future は、もう手放してよいものを見ている未来です。',
    'choice_future は、どちらへ進むかの分岐を見ている未来です。',
    'confirmation_future は、返事・応答・既読・折り返し・待機・再接続を確かめている未来です。',
    'Pre-SEEDの avoid_future_kinds と avoid_phrases を必ず守ってください。',
    'avoid_phrases にある語句は、current_future_imaginal / current_future_meaning / copy_material に使わないでください。',
    'LINE/DMでは、診断対象は右側・緑色のユーザー本人だけです。左側・白色の相手は文脈としてだけ使ってください。',
    '相手の気持ち、未来、運命、人格を断定しないでください。',
    'imaginal_core_seed.current_future_imaginal には、今ユーザーが見ている未来のイマジナル像を入れてください。',
    'imaginal_core_seed.current_future_meaning には、その未来をユーザーがどう意味づけているかを入れてください。',
    'imaginal_core_seed.current_state_from_future には、その未来を見ているから今どんな状態になっているかを入れてください。',
    'imaginal_core_seed.current_word_reaction には、その未来から出ている言葉を入れてください。',
    'imaginal_core_seed.current_action_reaction には、その未来から出ている行動を入れてください。',
    'shifted_future_imaginal には、創造の未来として置き直す未来を入れてください。',
    'shifted_future_meaning には、その未来で何が前提になるかを入れてください。',
    'copy_material は、future_kind に合う素材にしてください。怖い未来に固定しないでください。',
    'copy_ng には、Pre-SEEDの avoid_phrases と、画面上ラベル・浅い比喩を入れてください。',
    '出力はJSONのみ。display_text と seed を持つオブジェクトにしてください。',
    'display_text は仮文でかまいません。最終表示文は後段Writerが作ります。',
    'seed.kind は imaginal_first、diagnosis_scope は current_imaginal、flow_priority は true にしてください。seed.flow_perspective も必ず入れてください。seed.flow_perspective も必ず入れてください。',
    'seed.image_pre_seed には、渡されたPre-SEEDをそのまま入れてください。',
    'CORE_TRUST_FLOW_PRIORITY_RULES_V1',
    '迷った時ほど、future_kind の一般説明ではなく、フローを正本にしてください。',
    'seed.current_flow_input_seed と seed.second_flow_input_seed を必ず作ってください。',
    'current_flow_input_seed は、今ユーザーが見ている未来形象によって起きている内的状態です。',
    'second_flow_input_seed は、その内的状態を続けた場合に起こりやすい次状態です。創造方向ではありません。',
    'shifted_future_imaginal は、second_flow_input_seed へ移管し続ける流れから抜ける方向です。',
    'shifted_future_imaginal は、ポジティブな結末や相手から望ましい反応が来る未来ではありません。',
    'future_kind / central_theme / flow_perspective が迷う場合は、current_flow_input_seed と second_flow_input_seed の移管を優先してください。',
    'confirmation_future の場合、shifted_future_imaginal は「返事が来る未来」ではなく、「確認し続ける未来から抜ける未来」にしてください。',
    'receiving_future の場合、shifted_future_imaginal は「もっと褒められる未来」ではなく、「受け取ったものを自分の力として持てる未来」にしてください。',
    'expanded_role_future の場合、shifted_future_imaginal は「責任を抱える未来」ではなく、「役割の広がりを抱えすぎず受け取る未来」にしてください。',
    'comparison_future の場合、shifted_future_imaginal は「勝つ未来」ではなく、「比較から自分の創造方向へ戻る未来」にしてください。',
    'fear / anxiety / confirmation / comparison の場合、創造方向は安心材料を外部に求める方向ではなく、自分の状態を取り戻す方向にしてください。',
    'CORE_FLOW_PERSPECTIVE_OUTPUT_RULES_V2',
    'seed.flow_perspective を必ず入れてください。',
    'seed.flow_perspective.observed_surface には、表面に見える言葉・行動を入れてください。',
    'seed.flow_perspective.surface_polarity には、表面の言葉・行動が pos / neg / mixed のどれかを入れてください。',
    'seed.flow_perspective.inner_polarity には、内的状態が pos / neg / mixed のどれかを入れてください。',
    'seed.flow_perspective.utterance_alignment には、aligned / partially_aligned / misaligned / overstated / understated のいずれかを入れてください。',
    'seed.flow_perspective.direction_kind には、creation / receiving / anxiety / fear / confirmation / comparison / avoidance / destruction / boundary / mixed / unknown のいずれかを入れてください。',
    'confirmation_future の場合、direction_kind は confirmation または anxiety にしてください。',
    'CORE_FLOW_PERSPECTIVE_OUTPUT_RULES_V1',
    'seed.flow_perspective を必ず入れてください。',
    'seed.flow_perspective.observed_surface には、表面に見える言葉・行動を入れてください。',
    'seed.flow_perspective.surface_polarity には、表面の言葉・行動が pos / neg / mixed のどれかを入れてください。',
    'seed.flow_perspective.inner_polarity には、内的状態が pos / neg / mixed のどれかを入れてください。',
    'seed.flow_perspective.utterance_alignment には、aligned / partially_aligned / misaligned / overstated / understated のいずれかを入れてください。',
    'seed.flow_perspective.direction_kind には、creation / receiving / anxiety / fear / confirmation / comparison / avoidance / destruction / boundary / mixed / unknown のいずれかを入れてください。',
    'confirmation_future の場合、direction_kind は confirmation または anxiety にしてください。',
    'seed.image_type は line_or_dm にしてください。',
    'seed.imaginal_core_seed.future_kind を必ず入れてください。',
    'seed.imaginal_core_seed.central_theme を必ず入れてください。',
    'central_theme は receiving_gratitude / expanded_role / creation_seed / relationship_repair / reply_confirmation / priority_abandonment / unknown のいずれかにしてください。',
    'possible_future_kinds に expanded_role_future または creation_future が含まれる場合、receiving_future だけで止めないでください。',
    '相手の言葉に「皆さんを元気に」「ベースで生きれてます」「続いています」のような広がりや継続がある場合は、expanded_role を優先候補にしてください。',
    '右側ユーザーが相手の現在・活動・その後を確認している場合は、単なる感謝受け取りではなく、支援の影響がどこまで続いているかを見ている流れとして読んでください。',
  ].join('\n');

  const userText = [
    '以下の image_pre_seed を正本にして、Core SeedだけをJSONで作ってください。',
    note ? `補足メモ: ${note}` : '',
    JSON.stringify({ image_pre_seed: preSeed }, null, 2),
  ].filter(Boolean).join('\n');

  const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });

  if (!llmRes.ok) {
    const detail = await llmRes.text().catch(() => '');
    throw new Error(`core_seed_llm_failed: ${detail.slice(0, 500)}`);
  }

  const data = await llmRes.json().catch(() => ({}));
  const raw = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new Error('empty_core_seed');

  return String(raw);
}

async function writeDiagnosisFromSeed(params: {
  apiKey: string;
  model: string;
  seed: ImaginalDiagnosisSeed | null;
  fallback: string;
}): Promise<string> {
  const { apiKey, model, seed, fallback } = params;
  if (!seed?.imaginal_core_seed) return normalizeWriterDisplayText(fallback, fallback);

  const writerModel = process.env.MU_FIRST_DIAGNOSIS_WRITER_MODEL || model;
  const writerSystem = [
    'あなたはMuverseの初回イマジナル診断のWriterです。',
    '診断文はLLMとして自然に書いてください。ただし、根拠は writer_seed だけです。',
    '画像を再解釈してはいけません。',
    '記事、写真、スタンプ、背景、リンク、料理、植物、人物など、writer_seedにない素材を新しく意味づけしないでください。',
    'image_pre_seed、observed_facts、possible_future_kinds を根拠に新しい診断を作らないでください。',
    'writer_seed.current_flow / second_flow / creative_shift を正本にしてください。',
    'writer_seed.image_meaning は、画像から抽出済みの意味として使ってください。',
    'ただし、画像素材名をそのまま並べず、意味だけを診断文にしてください。',
    '見続けている未来には current_flow だけを書き、creative_shift を混ぜないでください。',
    '創造の未来には creative_shift だけを書き、見続けている未来と同じ内容にしないでください。',
    '出力はJSONのみ。display_text だけを持つオブジェクトにしてください。',
    '見出しは必ず7つ: あなたのイマジナルコピー / いま見えている願い / 見続けている未来 / 言葉に出ている反応 / 行動に出ている反応 / 創造の未来 / 今日の小さな一歩。',
    '各項目の本文は原則1文です。ただし、画像上の具体語がある場合は短く含めてください。',
    '各項目は短く。ただし診断全体は最低260文字以上にしてください。創造の未来は必ず「〇〇の未来」の形で書いてください。',
    '二文目、補足説明、理由説明、心理解説、関係解説は禁止です。',
    '「表面では」「内側では」「言葉と内側」「状態は深まり」「停滞へ」は禁止です。',
    '最後の1行は必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」にしてください。',
  ].join('\n');

  const seedAny = seed as any;
  const core = seedAny.imaginal_core_seed ?? {};
  const flow = seedAny.imaginal_flow_seed ?? {};
  const perspective = seedAny.flow_perspective ?? {};

  const imagePreSeed = seedAny.image_pre_seed ?? {};

  const writerSeed = {
    imaginal_copy: seedAny.imaginal_copy,
    image_meaning: {
      central_observation: imagePreSeed.central_observation,
      user_side_signals: imagePreSeed.user_side_signals,
      other_side_context: imagePreSeed.other_side_context,
    },
    future_kind: core.future_kind ?? seedAny.future_kind,
    direction_kind: perspective.direction_kind,
    current_flow: {
      surface: perspective.observed_surface,
      current_state: core.current_state_from_future,
      current_future: core.current_future_imaginal,
      current_meaning: core.current_future_meaning,
      flow_current: flow.current,
      transfer_current: flow.transferSeed?.current,
    },
    second_flow: {
      likely_state: core.second_flow_state,
      second_future: core.second_future_imaginal,
      flow_second: flow.second,
      transfer_second: flow.transferSeed?.second,
    },
    creative_shift: {
      shifted_future: core.shifted_future_imaginal,
      shifted_meaning: core.shifted_future_meaning,
      creative_direction: seedAny.creative_direction,
      transfer_shift: flow.transferSeed?.shift,
    },
    writing_rules: {
      do_not_reinterpret_image: true,
      do_not_add_unseen_materials: true,
      use_flow_seed_only: true,
    },
  };

  const writerUser = [
    '以下の writer_seed だけを正本にして、初回イマジナル診断の表示文を書いてください。',
    '画像そのもの、記事、写真、スタンプ、リンク、背景素材を新しく診断しないでください。',
    'writer_seed にない素材名を本文に出さないでください。',
    JSON.stringify({ writer_seed: writerSeed }, null, 2),
  ].join('\n');

  try {
    const writerRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: writerModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: writerSystem },
          { role: 'user', content: writerUser },
        ],
      }),
    });

    if (!writerRes.ok) {
      const detail = await writerRes.text().catch(() => '');
      console.warn('[mu-first-diagnosis] writer skipped:', detail.slice(0, 500));
      return normalizeWriterDisplayText(fallback, fallback);
    }

    const data = await writerRes.json().catch(() => ({}));
    const raw = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
    if (!raw) return normalizeWriterDisplayText(fallback, fallback);

    const parsed = JSON.parse(String(raw).trim());
    return normalizeWriterDisplayText(parsed?.display_text ?? parsed?.displayText, fallback);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] writer fatal skipped:', e?.message || e);
    return normalizeWriterDisplayText(fallback, fallback);
  }
}

async function uidToUserCode(uid: string): Promise<string | null> {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const q = await sb.from(c.table).select(c.codeCol).eq(c.uidCol, uid).maybeSingle();
    if (!q.error && q.data && q.data[c.codeCol]) return String(q.data[c.codeCol]);
  }

  return null;
}

async function consumeScreenshotCredit(userCode: string): Promise<boolean | null> {
  try {
    const { data, error } = await sb.rpc('consume_screenshot_credit', {
      p_user_code: userCode,
    });
    if (error) throw error;
    return Boolean(data);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] consume_screenshot_credit skipped:', e?.message || e);
    return null;
  }
}

async function getNextScreenshotDiagnosisDisplayId(userCode: string): Promise<number> {
  const { data, error } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .select('display_id')
    .eq('user_code', userCode)
    .not('display_id', 'is', null)
    .order('display_id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  const currentMax = Number(data?.display_id ?? 0);
  return Number.isFinite(currentMax) && currentMax > 0 ? currentMax + 1 : 1;
}

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
  diagnosisText: string;
  diagnosisSeedJson: ImaginalDiagnosisSeed | null;
}) {
  try {
    const displayId = await getNextScreenshotDiagnosisDisplayId(params.userCode);
    await sb.from('mu_screenshot_diagnosis_logs').insert({
      user_code: params.userCode,
      model: params.model,
      source: params.source,
      media_code: params.mediaCode,
      display_id: displayId,
      credit_used: 1,
      diagnosis_text: params.diagnosisText,
      diagnosis_seed_json: {
        ...(params.diagnosisSeedJson ?? {}),
        kind: 'imaginal_first',
        diagnosis_scope: 'current_imaginal',
        flow_priority: true,
      },
    });
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] log skipped:', e?.message || e);
  }
}

async function resolveUserCode(req: NextRequest): Promise<{ ok: true; userCode: string } | { ok: false; response: NextResponse }> {
  const authz = await verifyFirebaseAndAuthorize(req);
  if (!authz.ok) return { ok: false, response: json({ ok: false, error: authz.error ?? 'unauthorized' }, 401) };

  const { user } = normalizeAuthz(authz);
  let userCode = user?.user_code ?? null;
  if (!userCode && authz.uid) userCode = await uidToUserCode(authz.uid);
  if (!userCode) return { ok: false, response: json({ ok: false, error: 'no_user_code' }, 401) };

  return { ok: true, userCode };
}

export async function GET(req: NextRequest) {
  try {
    const resolved = await resolveUserCode(req);
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const { data: latest, error: latestErr } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
      .eq('user_code', userCode)
      .eq('source', 'mu_first')
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) return json({ ok: false, error: 'restore_failed' }, 500);

    if (!latest?.diagnosis_text) {
      return json({ ok: true, diagnosis: null, followup_messages: [], followup_remaining: 3, user_name_candidate: null });
    }

    const { data: userRow } = await sb
      .from('users')
      .select('first_followup_credit_count')
      .eq('user_code', userCode)
      .maybeSingle();

    const { data: followups } = await sb
      .from('mu_first_followup_logs')
      .select('question, answer, created_at')
      .eq('user_code', userCode)
      .eq('diagnosis_log_id', latest.id)
      .order('created_at', { ascending: true })
      .limit(3);

    const followupMessages = Array.isArray(followups)
      ? followups.flatMap((item: any) => [
          { role: 'user', content: String(item.question || '') },
          { role: 'assistant', content: String(item.answer || '') },
        ]).filter((item: any) => item.content)
      : [];

    const seed = latest.diagnosis_seed_json && typeof latest.diagnosis_seed_json === 'object' && !Array.isArray(latest.diagnosis_seed_json)
      ? (latest.diagnosis_seed_json as ImaginalDiagnosisSeed)
      : null;

    const dbRemaining = userRow && typeof userRow.first_followup_credit_count === 'number'
      ? userRow.first_followup_credit_count
      : null;

    return json({
      ok: true,
      diagnosis: latest.diagnosis_text,
      diagnosis_seed: seed,
      followup_messages: followupMessages,
      followup_remaining: dbRemaining === null ? Math.max(0, 3 - Math.floor(followupMessages.length / 2)) : dbRemaining,
      user_name_candidate: seed?.user_name_candidate || null,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] restore fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const diagReqId = `mu-first-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const totalStartedAt = Date.now();
    const logStep = (step: string, startedAt: number, extra?: Record<string, unknown>) => {
      const ms = Date.now() - startedAt;
      console.log(`[mu-first-diagnosis][timing] ${diagReqId} ${step}`, {
        ms,
        ...(extra ?? {}),
      });
    };
    const authStartedAt = Date.now();
    const resolved = await resolveUserCode(req);
    logStep('auth', authStartedAt, { ok: resolved.ok });
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const body = (await req.json().catch(() => ({}))) as {
      image_data_url?: string;
      note?: string;
      source?: string;
      media_code?: string | null;
      upload_type?: string;
    };

    const imageDataUrl = normalizeDataUrl(body.image_data_url);
    if (!imageDataUrl) return json({ ok: false, error: 'invalid_image' }, 400);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const creditStartedAt = Date.now();
    const creditConsumed = await consumeScreenshotCredit(userCode);
    logStep('credit', creditStartedAt, { creditConsumed });
    if (creditConsumed === false) return json({ ok: false, error: 'no_screenshot_credit' }, 402);

    const model = process.env.MU_FIRST_DIAGNOSIS_MODEL || 'gpt-5-mini';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : '';
    const uploadType = typeof body.upload_type === 'string' ? body.upload_type : 'line_dm';
    console.log(`[mu-first-diagnosis][timing] ${diagReqId} start`, {
      userCode,
      model,
      uploadType,
      noteLen: note.length,
      imageBytesApprox: Math.round(imageDataUrl.length * 0.75),
    });

    const preSeedStartedAt = Date.now();    const rawPreSeed = await createFirstDiagnosisPreSeed({
      apiKey,
      model,
      imageDataUrl,
      note,
      uploadType,
    });

    const preSeed = strengthenLineDmConfirmationPreSeed(rawPreSeed);
    logStep('llm.preSeed', preSeedStartedAt, {
      inputType: preSeed.input_type,
      possibleFutureKinds: preSeed.possible_future_kinds,
      centralTheme: preSeed.central_theme,
    });

    if (preSeed.input_type !== 'line_dm') {
      return json(
        {
          ok: false,
          error: 'unsupported_image_type',
          detail: '現在はLINEまたはDMの会話スクリーンショットのみ診断できます。',
          credit_consumed: creditConsumed,
        },
        400,
      );
    }
    const coreSeedStartedAt = Date.now();
    const useCoreLlm = process.env.MU_FIRST_USE_CORE_LLM === '1';
    const rawCoreSeed = useCoreLlm
      ? await createFirstDiagnosisCoreSeed({
          apiKey,
          model,
          preSeed,
          note,
        })
      : buildCoreSeedFromPreSeed(preSeed);
    logStep(useCoreLlm ? 'llm.coreSeed' : 'code.coreSeed', coreSeedStartedAt, {
      rawChars: String(rawCoreSeed).length,
    });

    const parseStartedAt = Date.now();
    const parsedDiagnosis = safeParseDiagnosis(String(rawCoreSeed), preSeed);
    logStep('parseAndFlowSeed', parseStartedAt, {
      hasSeed: Boolean(parsedDiagnosis.seed),
      futureKind: parsedDiagnosis.seed?.imaginal_core_seed?.future_kind,
      directionKind: parsedDiagnosis.seed?.flow_perspective?.direction_kind,
      hasFlowSeed: Boolean(parsedDiagnosis.seed?.imaginal_flow_seed),
    });

    if (!parsedDiagnosis.seed || parsedDiagnosis.seed.image_type !== 'line_or_dm') {
      return json(
        {
          ok: false,
          error: 'unsupported_image_type',
          detail: '現在はLINEまたはDMの会話スクリーンショットのみ診断できます。',
          credit_consumed: creditConsumed,
        },
        400,
      );
    }

    const writerStartedAt = Date.now();    let diagnosis = await writeDiagnosisFromSeed({
      apiKey,
      model,
      seed: parsedDiagnosis.seed,
      fallback: parsedDiagnosis.displayText,
    });
    logStep('llm.writer', writerStartedAt, {
      diagnosisChars: diagnosis?.length ?? 0,
    });
    if (!diagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    if (parsedDiagnosis.seed && isLowQualityFirstDiagnosisText(diagnosis)) {
      diagnosis = normalizeWriterDisplayText(
        buildDisplayText(parsedDiagnosis.seed, parsedDiagnosis.displayText),
        parsedDiagnosis.displayText,
      );
    }

    const logStartedAt = Date.now();    await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_first',
      mediaCode: body.media_code || null,
      diagnosisText: diagnosis,
      diagnosisSeedJson: parsedDiagnosis.seed,
    });
    logStep('db.logDiagnosis', logStartedAt);

    logStep('total', totalStartedAt, {
      userCode,
      model,
      diagnosisChars: diagnosis.length,
    });

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      diagnosis_seed: parsedDiagnosis.seed,
      user_name_candidate: parsedDiagnosis.seed?.user_name_candidate || null,
      credit_consumed: creditConsumed,
      model,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

