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
  | 'release_future'
  | 'choice_future'
  | 'unknown_future';

type FirstDiagnosisInputType = 'line_dm' | 'other';

type FirstDiagnosisCentralTheme =
  | 'receiving_gratitude'
  | 'expanded_role'
  | 'creation_seed'
  | 'relationship_repair'
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
    v === 'release_future' ||
    v === 'choice_future'
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

function buildDisplayText(seed: ImaginalDiagnosisSeed, fallback: string): string {
  const copy = cleanString(seed.imaginal_copy);
  if (!copy) return fallback;
  const core = seed.imaginal_core_seed;

  return [
    'あなたのイマジナルコピー',
    copy,
    '',
    'いま見えている願い',
    cleanString(core?.current_state_from_future) || cleanString(core?.avoidance_wish) || cleanString(seed.visible_wish) || 'この画像を出した時点で反応している一点を、言葉にしようとしています。',
    '',
    '見続けている未来',
    cleanString(core?.current_future_imaginal) || cleanString(core?.undesired_future) || cleanString(seed.seen_future) || 'まだ断定せず、今立ち上がっている方向を観測しています。',
    '',
    '言葉に出ている反応',
    cleanString(core?.current_word_reaction) || cleanString(core?.word_from_undesired_future) || cleanString(seed.word_reaction) || 'その未来に触れて、確認や受け取りの言葉が出ています。',
    '',
    '行動に出ている反応',
    cleanString(core?.current_action_reaction) || cleanString(core?.action_from_undesired_future) || cleanString(seed.action_reaction) || 'その未来に触れて、もう少し見たい動きが出ています。',
    '',
    '創造の方向',
    cleanString(core?.shifted_future_imaginal) || cleanString(core?.creative_future) || cleanString(seed.creative_direction) || '今見えている方向を、次の創造へ置き直すことです。',
    '',
    '今日の小さな一歩',
    cleanString(core?.shifted_word_direction) || cleanString(core?.creative_word_direction) || cleanString(seed.today_step) || '見えている未来を一文にして、今日の行動へ戻してください。',
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
      'FLOW_PERSPECTIVE_RULES_V1',
      '必ず seed.flow_perspective を作ってください。',
      'flow_perspective は、画像の表面ではなく、この画像を出した人の中で立ち上がっている未来の方向を判定するSeedです。',
      'flow_perspective.observed_surface には、表面上は何をしているように見えるかを入れてください。例: 創造している、確認している、感謝を受け取っている、怒っている、待っている、進めようとしている。',
      'flow_perspective.surface_polarity には、表面の言葉・行動が pos / neg / mixed のどれに見えるかを入れてください。',
      'flow_perspective.inner_polarity には、内的状態が pos / neg / mixed のどれかを入れてください。表面が創造方向に見えても、根の未来形象が不安・恐怖・確認・比較であれば inner_polarity は neg にしてください。',
      'flow_perspective.utterance_alignment には、表面の言葉・行動と内的状態の整合を入れてください。aligned / partially_aligned / misaligned / overstated / understated のいずれかです。',
      'flow_perspective.direction_kind には、今見ている未来の方向を入れてください。creation / receiving / anxiety / fear / confirmation / comparison / avoidance / destruction / boundary / mixed / unknown のいずれかです。',
      'flow_perspective.seen_future_direction には、今その人が見続けている未来の方向を短く入れてください。',
      'flow_perspective.direction_reason には、画像上のどの観測からその方向と読んだかを入れてください。',
      'current_flow_input_seed は、画像の表面説明ではなく、未来形象が作る内的状態として作ってください。',
      'second_flow_input_seed は、その内的状態を見続けた場合に起こりやすい次状態として作ってください。創造方向ではありません。',
      '創造方向は imaginal_core_seed.shifted_future_imaginal に入れてください。',
    'あなたはMuverseの初回イマジナル診断の画像観測Pre-SEEDを作る観測者です。',
    'ここでは診断文を書かないでください。',
    'ここではイマジナルコピーを作らないでください。',
    'ここでは未来を確定しないでください。',
    '目的は、画像から「何を読めばよいか」を決めるための観測Seedを作ることです。',
    '現在の対象はLINE/DMなどの会話スクリーンショット限定です。',
    'LINE/DMではない、または会話画面として確認できない場合は input_type を other、confidence を low にしてください。',
    'LINE/DMの場合、原則として右側・緑色の吹き出しがユーザー本人、左側・白色の吹き出しが相手です。',
    '画面上部の名前は通常、相手名です。ユーザー名として扱わないでください。',
    '診断対象はユーザー本人だけです。相手の願い・不安・未来を診断対象にしないでください。',
    'observed_facts には、画像上で確認できる事実だけを入れてください。',
    'user_side_signals には、右側・緑色のユーザー発言から見える反応を入れてください。',
    'other_side_context には、左側・白色の相手発言を文脈として入れてください。',
    'possible_future_kinds には候補だけを入れてください。複数可です。',
    '候補は feared_future / receiving_future / expanded_role_future / creation_future / repair_future / release_future / choice_future / unknown_future です。',
    'feared_future は、放置、拒絶、喪失、約束不履行などの根拠が右側ユーザー発言に明確にある場合だけ候補にしてください。',
    'receiving_future は、感謝・成果・助かった・褒められた等の良い未来をユーザーが受け取りきれていない時に候補にしてください。',
    'expanded_role_future は、ユーザーが「もっとできる」「もっと広げられる」「大きな役割があるかもしれない」という方向を見始めている時に候補にしてください。',
    'creation_future は、仕事・企画・作品・場づくりなどが形になり始めている時に候補にしてください。',
    'avoid_future_kinds には、この画像では使わない方がよい未来種別を入れてください。',
    'avoid_phrases には、この画像で使うとズレる言葉を入れてください。',
    '相手の気持ち、運命、人格を断定しないでください。',
    '魂、使命、覚醒、波動、宿命、高次元、宇宙からのメッセージ、あなたは〇〇タイプです、必ず変わります、絶対に叶います、相手はあなたを好きです、相手は本気ではありません、は禁止です。',
    '出力はJSONのみ。pre_seed だけを持つオブジェクトにしてください。',
    'pre_seed.version は first_diagnosis_pre_seed_v1 にしてください。',
    'pre_seed.input_type は line_dm または other にしてください。',
    'pre_seed.role_mapping は user_side, other_side, target を持たせてください。',
  ].join('\n');

  const userText = [
      'USER_FLOW_PERSPECTIVE_RULES_V1',
      '重要: flow_perspective で、表面の言葉・行動と内的状態のズレを必ず判定してください。',
      '表面がポジティブでも、根の未来形象が不安・恐怖・確認・比較であれば inner_polarity は neg にしてください。',
      'second_flow_input_seed は創造方向ではなく、その内的状態を続けた場合に起こりやすい次状態として作ってください。',
    'この画像から、初回イマジナル診断の画像観測Pre-SEEDだけを作ってください。',
    '診断文、コピー、未来の確定文はまだ作らないでください。',
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
    'Core Seedでは、Pre-SEEDの possible_future_kinds から中心となる future_kind を選んでください。',
    '合わない場合は unknown_future にしてください。既存テンプレへ無理に寄せないでください。',
    '未来のイマジナルは、怖い未来だけではありません。',
    'feared_future は、Pre-SEEDで明確に候補になっている場合だけ使ってください。',
    'receiving_future は、すでに来ている良い未来・感謝・成果を受け取りきれていない状態です。',
    'expanded_role_future は、もっとできることがある、もっと広げられる、大きな役割が見え始めている状態です。',
    'creation_future は、企画・仕事・作品・場が形になり始めている状態です。',
    'repair_future は、関係や言葉を置き直す未来です。',
    'release_future は、もう手放してよいものを見ている未来です。',
    'choice_future は、どちらへ進むかの分岐を見ている未来です。',
    'Pre-SEEDの avoid_future_kinds と avoid_phrases を必ず守ってください。',
    'avoid_phrases にある語句は、current_future_imaginal / current_future_meaning / copy_material に使わないでください。',
    'LINE/DMでは、診断対象は右側・緑色のユーザー本人だけです。左側・白色の相手は文脈としてだけ使ってください。',
    '相手の気持ち、未来、運命、人格を断定しないでください。',
    'imaginal_core_seed.current_future_imaginal には、今ユーザーが見ている未来のイマジナル像を入れてください。',
    'imaginal_core_seed.current_future_meaning には、その未来をユーザーがどう意味づけているかを入れてください。',
    'imaginal_core_seed.current_state_from_future には、その未来を見ているから今どんな状態になっているかを入れてください。',
    'imaginal_core_seed.current_word_reaction には、その未来から出ている言葉を入れてください。',
    'imaginal_core_seed.current_action_reaction には、その未来から出ている行動を入れてください。',
    'shifted_future_imaginal には、創造の方向として置き直す未来を入れてください。',
    'shifted_future_meaning には、その未来で何が前提になるかを入れてください。',
    'copy_material は、future_kind に合う素材にしてください。怖い未来に固定しないでください。',
    'copy_ng には、Pre-SEEDの avoid_phrases と、画面上ラベル・浅い比喩を入れてください。',
    '出力はJSONのみ。display_text と seed を持つオブジェクトにしてください。',
    'display_text は仮文でかまいません。最終表示文は後段Writerが作ります。',
    'seed.kind は imaginal_first、diagnosis_scope は current_imaginal、flow_priority は true にしてください。',
    'seed.image_pre_seed には、渡されたPre-SEEDをそのまま入れてください。',
    'seed.image_type は line_or_dm にしてください。',
    'seed.imaginal_core_seed.future_kind を必ず入れてください。',
    'seed.imaginal_core_seed.central_theme を必ず入れてください。',
    'central_theme は receiving_gratitude / expanded_role / creation_seed / relationship_repair / priority_abandonment / unknown のいずれかにしてください。',
    'possible_future_kinds に expanded_role_future または creation_future が含まれる場合、receiving_future だけで止めないでください。',
    '相手の言葉に「皆さんを元気に」「ベースで生きれてます」「続いています」のような広がりや継続がある場合は、expanded_role を優先候補にしてください。',
    '右側ユーザーが相手の現在・活動・その後を確認している場合は、単なる感謝受け取りではなく、支援の影響がどこまで続いているかを見ている流れとして読んでください。',
  ].join('\n');

  const userText = [
    '以下の image_pre_seed を正本にして、初回イマジナル診断のCore Seedを作ってください。',
    '怖い未来へ固定しないでください。',
    'Pre-SEEDの avoid_future_kinds と avoid_phrases を必ず守ってください。',
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
      'WRITER_FLOW_PERSPECTIVE_RULES_V1',
      'seed.flow_perspective / seed.imaginal_core_seed / seed.imaginal_flow_seed.transferSeed を正本にしてください。',
      'direction_kind は Writer 側で変更しないでください。一次解析で確定した方向判定に従ってください。',
      'surface_polarity と inner_polarity がズレている場合は、「表面では〇〇に見えるが、内側では△△の未来を見ている」という構造で書いてください。',
      'surface_polarity と inner_polarity がズレている場合は、utterance_alignment と imaginal_flow_seed.transferSeed.transferMeaning を使って説明してください。',
      '表面がポジティブでも inner_polarity が neg の場合は、無理に創造方向として褒めず、根の不安・恐怖・確認・比較を状態移管として扱ってください。',
      'secondFlow は創造方向ではありません。その内的状態を続けた場合に起こりやすい次状態として扱ってください。',
      'direction_kind が anxiety / fear / confirmation / comparison / destruction / avoidance の場合は、その先にある怖さまで書いてください。',
      'direction_kind が receiving / creation / boundary の場合は、無理に恐怖へ寄せず、その方向の未来像として書いてください。',
      '表示文には flow_perspective、transferSeed、currentFlow、secondFlow、Seed、JSON などの内部名を出さないでください。',
    'あなたはMuverseの初回イマジナル診断のWriterです。',
    '前段の image_pre_seed と imaginal_core_seed だけを正本にして、ユーザー表示用の診断文を書いてください。',
    '画像を新しく読み直さないでください。',
    '意味を追加しないでください。',
    '既存テンプレに寄せないでください。',
    '怖い未来へ固定しないでください。',
    'seed.image_pre_seed.possible_future_kinds / avoid_future_kinds / avoid_phrases を必ず守ってください。',
    'もっとも重要な正本は seed.image_pre_seed と seed.imaginal_core_seed です。',
    'LINE/DM画像では、右側の緑吹き出しをユーザー本人として扱ってください。',
    '左側の白吹き出しは相手側の文脈として扱ってください。',
    '診断対象は相手ではなく、ユーザー本人のイマジナルです。',
    '相手の感謝文を中心に診断しないでください。中心は、相手の言葉に対してユーザー本人がどんな未来を見て、どんな反応をしているかです。',
    '相手から感謝されている場面でも、「感謝を受け取る」だけで止めないでください。',
    '右側ユーザーが相手の現在・活動・その後の変化を確認している場合は、支援の影響がどこまで続いているか、役割や活動へ広がる可能性を見ている流れとして扱ってください。',
    '「たいしたことしてない」は、単なる受け取り拒否だけでなく、その出来事の意味をまだ測っている反応として読んでください。',
    '「見続けている未来」は、imaginal_core_seed.future_kind に合わせてください。',
    'feared_future の時だけ、怖い未来を書いてください。',
    'receiving_future の時は、すでに来ている良い未来を受け取りきれていない流れを書いてください。',
    'expanded_role_future の時は、もっとできることがある、もっと広げられる、大きな役割が見え始めている未来を書いてください。',
    'creation_future の時は、創造が形になり始めている未来を書いてください。',
    'repair_future の時は、関係や言葉を置き直す未来を書いてください。',
    'release_future の時は、手放してよいものを見ている未来を書いてください。',
    'choice_future の時は、分岐を見ている未来を書いてください。',
    'unknown_future の時は、断定せず、今見えている反応だけをやわらかく出してください。',
    '「自分は重要ではない」「取り残される」「もう会えなくなる」「関係から外される」は、avoid_phrases に含まれる場合は使わないでください。',
    '「言葉に出ている反応」は、ユーザーを責めず、何を受け取り、何を見ようとしているかで書いてください。',
    '「行動に出ている反応」は、圧・批判・過剰介入と強く書きすぎないでください。',
    '「創造の方向」は、相手を変える手順ではなく、ユーザーが未来のイマジナルを置き直す方向で書いてください。',
    'コピーはSeedではありません。コピーはWriterの仕事です。',
    'コピーは current_future_imaginal / current_future_meaning / copy_material / future_kind から作ってください。',
    'コピーは12〜24文字程度。現在状態ラベル、画面上ラベル、物体比喩は禁止です。',
    '文体はMuの口調にしてください。やわらかく、近く、でも核心は外さない言い方にしてください。',
    'ユーザーを裁く言い方、分析して突き放す言い方、専門家が診断するような硬い言い方は避けてください。',
    '一文は短めにしてください。',
    '相手の気持ち、未来、運命、人格を断定しないでください。',
    '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
    '出力はJSONのみ。display_text だけを持つオブジェクトにしてください。',
    'display_textには内部キー名、currentFlow、secondFlow、Seed、JSON、imaginal_core_seed、image_pre_seedという言葉を出さないでください。',
    '番号付きリストは禁止です。「1.」「2.」「3.」などを出さないでください。',
    '独自タイトルは禁止です。「Muの初回イマジナル診断」のようなタイトルを出さないでください。',
    '構成は見出しだけで分けてください。',
    '見出しは必ずこの順番で出してください。',
    'あなたのイマジナルコピー',
    'いま見えている願い',
    '見続けている未来',
    '言葉に出ている反応',
    '行動に出ている反応',
    '創造の方向',
    '今日の小さな一歩',
    '各見出しの後に本文を書いてください。見出しに番号や記号を付けないでください。',
    '最後の1行は必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」にしてください。',
    '全体で900文字以内。',
  ].join('\n');

  const writerSeed: ImaginalDiagnosisSeed = { ...seed };
  delete writerSeed.imaginal_copy;

  const writerUser = [
    '以下のSeedを正本にして、初回イマジナル診断の表示文だけを作ってください。',
    'imaginal_copy は渡していません。必ずCore Seedから作ってください。',
    '番号付きリスト、独自タイトル、診断表形式は禁止です。',
    '必ず「あなたのイマジナルコピー」から始めてください。',
    JSON.stringify(writerSeed, null, 2),
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
    const resolved = await resolveUserCode(req);
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

    const creditConsumed = await consumeScreenshotCredit(userCode);
    if (creditConsumed === false) return json({ ok: false, error: 'no_screenshot_credit' }, 402);

    const model = process.env.MU_FIRST_DIAGNOSIS_MODEL || 'gpt-5-mini';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : '';
    const uploadType = typeof body.upload_type === 'string' ? body.upload_type : 'line_dm';

    const preSeed = await createFirstDiagnosisPreSeed({
      apiKey,
      model,
      imageDataUrl,
      note,
      uploadType,
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

    const rawCoreSeed = await createFirstDiagnosisCoreSeed({
      apiKey,
      model,
      preSeed,
      note,
    });

    const parsedDiagnosis = safeParseDiagnosis(String(rawCoreSeed), preSeed);

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

    const diagnosis = await writeDiagnosisFromSeed({
      apiKey,
      model,
      seed: parsedDiagnosis.seed,
      fallback: parsedDiagnosis.displayText,
    });
    if (!diagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_first',
      mediaCode: body.media_code || null,
      diagnosisText: diagnosis,
      diagnosisSeedJson: parsedDiagnosis.seed,
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
