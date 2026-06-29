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

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type FutureBase = 'anxiety' | 'destruction' | 'comparison' | 'creation' | 'unknown';
type FutureLabel = '不安の未来' | '破壊の未来' | '比較の未来' | '創造の未来';

type ImageType =
  | 'line_dm'
  | 'email'
  | 'memo'
  | 'todo'
  | 'post_draft'
  | 'calendar'
  | 'book_page'
  | 'application_page'
  | 'other';

type ImaginalPreSeed = {
  version: 'imaginal_pre_seed_v2';
  image_observation: {
    image_type: ImageType;
    visible_facts: string[];
    read_state: 'read' | 'unread' | 'mixed' | 'unknown';
    reply_state: 'replied' | 'no_reply' | 'waiting' | 'unknown';
    call_state: 'missed_call' | 'called' | 'no_call' | 'unknown';
    user_words: string[];
    user_actions: string[];
    other_context: string[];
  };
  attention_point: string;
  wished_future_seed: {
    wished_future: string;
    wished_future_scene: string;
    wished_future_reason: string;
  };
  continued_future_seed: {
    continued_future: string;
    future_scene: string;
    future_base: FutureBase;
    future_label: FutureLabel;
    copy_seed: string;
    direction_reason: string;
  };
  gap_seed: {
    gap_between_wish_and_continued_future: string;
  };
};

type ContinuedFutureFlowSeed = {
  e_turn: 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
  polarity: 'pos' | 'neg' | 'mixed';
  yure: 'low' | 'middle' | 'high';
  margin: 'none' | 'small' | 'medium' | 'large';
  state_summary: string;
  state_hold_reason: string;
};

type WishedFutureTransferSeed = {
  wished_future_direction: string;
  transfer_direction: string;
  required_word_shift: string;
  required_action_shift: string;
  changed_future: string;
};

type DirectionKind =
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

type PolarityKind = 'pos' | 'neg' | 'mixed';
type UtteranceAlignmentKind = 'aligned' | 'partially_aligned' | 'misaligned' | 'overstated' | 'understated';
type DepthStageKind = 'S1' | 'S2' | 'S3' | 'T1' | 'T2' | 'T3';

type FlowPerspectiveSeed = {
  observed_surface: string;
  direction_kind: DirectionKind;
  surface_polarity: PolarityKind;
  inner_polarity: PolarityKind;
  utterance_alignment: UtteranceAlignmentKind;
  seen_future_direction: string;
  direction_reason: string;
};

type FlowInputSeed = {
  e_turn: 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
  depthStage: DepthStageKind;
  polarity: 'pos' | 'neg';
  utteranceAlignment: UtteranceAlignmentKind;
  basedOn: string;
};

type ImaginalFlowSeed = {
  transferSeed: {
    from_current_flow: string;
    to_second_flow: string;
    transfer_point: string;
    word_shift: string;
    action_shift: string;
  };
};

type ImaginalCoreSeed = {
  imaginal_copy_seed: string;
  copy_ending_label: '不安の未来' | '恐怖の未来' | '比較の未来' | '創造の未来';
  copy_material_seed: string[];
  copy_generation_policy: string[];
  copy_lateral_hint_seed: string[];
  wished_future_imaginal: string;
  seen_future_imaginal: string;
  shifted_future_imaginal: string;
  creative_direction: string;
  small_step: string;
};
type ImageShapeStateSeed = {
  connection_shape: string;
  response_shape: string;
  continuity_shape: string;
  time_shape: string;
  field_shape: string;
};
type WriterUsagePolicySeed = {
  attention_point: string;
  wished_future: string;
  continued_future: string;
  future_scene: string;
  wished_future_transfer_seed: string;
  image_shape_state_seed: string;
  output_priority: string[];
  prohibited_direct_use: string[];
};
type ImaginalDiagnosisSeed = {
  version: 'imaginal_diagnosis_seed_v2';
  flow_perspective: FlowPerspectiveSeed;
  current_flow_input_seed: FlowInputSeed;
  second_flow_input_seed: FlowInputSeed;
  imaginal_flow_seed: ImaginalFlowSeed;
  imaginal_core_seed: ImaginalCoreSeed;
  writer_usage_policy_seed: WriterUsagePolicySeed;
  pre_seed: ImaginalPreSeed;
  image_shape_state_seed: ImageShapeStateSeed;
  continued_future_flow_seed: ContinuedFutureFlowSeed;
  wished_future_transfer_seed: WishedFutureTransferSeed;
  writer_directives: string[];
};

const MU_IMAGINAL_CREDIT_COST = 5;
const MU_IMAGINAL_ALLOWED_USER_TYPES = ['premium', 'master', 'partner', 'admin'];
const FUTURE_LABELS: FutureLabel[] = ['不安の未来', '破壊の未来', '比較の未来', '創造の未来'];

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

function cleanString(value: unknown, fallback = ''): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function cleanArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return items.length ? items : fallback;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? '').trim();
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function normalizeFutureBase(value: unknown): FutureBase {
  return normalizeEnum(
    value,
    ['anxiety', 'destruction', 'comparison', 'creation', 'unknown'] as const,
    'unknown',
  );
}

function futureLabelFromBase(base: FutureBase): FutureLabel {
  if (base === 'destruction') return '破壊の未来';
  if (base === 'comparison') return '比較の未来';
  if (base === 'creation') return '創造の未来';
  return '不安の未来';
}

function normalizeFutureLabel(value: unknown, base: FutureBase): FutureLabel {
  const raw = cleanString(value);
  if (FUTURE_LABELS.includes(raw as FutureLabel)) return raw as FutureLabel;
  return futureLabelFromBase(base);
}

function stripFutureLabel(value: string): string {
  return value
    .replace(/(?:不安の未来|破壊の未来|比較の未来|創造の未来)[。\s]*$/u, '')
    .replace(/[。\s]+$/u, '')
    .trim();
}

function normalizeCopySeed(value: unknown, continuedFuture: string, label: FutureLabel): string {
  const raw = cleanString(value);
  const source = raw || `${continuedFuture}${label}`;
  const stripped = stripFutureLabel(source);
  return `${stripped}${label}`;
}

function normalizePreSeed(value: unknown): ImaginalPreSeed {
  const v = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
  const observation = v.image_observation && typeof v.image_observation === 'object'
    ? v.image_observation
    : {};
  const wished = v.wished_future_seed && typeof v.wished_future_seed === 'object'
    ? v.wished_future_seed
    : {};
  const continued = v.continued_future_seed && typeof v.continued_future_seed === 'object'
    ? v.continued_future_seed
    : {};
  const gap = v.gap_seed && typeof v.gap_seed === 'object' ? v.gap_seed : {};

  let futureBase = normalizeFutureBase(continued.future_base);
  const futureLabel = normalizeFutureLabel(continued.future_label, futureBase);

  if (futureBase === 'unknown') {
    futureBase =
      futureLabel === '破壊の未来' ? 'destruction'
      : futureLabel === '比較の未来' ? 'comparison'
      : futureLabel === '創造の未来' ? 'creation'
      : futureLabel === '不安の未来' ? 'anxiety'
      : 'unknown';
  }
  const continuedFuture = cleanString(
    continued.continued_future,
    'このまま安心を外側の反応に預け、待つ側に残される',
  );

  return {
    version: 'imaginal_pre_seed_v2',
    image_observation: {
      image_type: normalizeEnum(
        observation.image_type,
        ['line_dm', 'email', 'memo', 'todo', 'post_draft', 'calendar', 'book_page', 'application_page', 'other'] as const,
        'other',
      ),
      visible_facts: cleanArray(observation.visible_facts),
      read_state: normalizeEnum(
        observation.read_state,
        ['read', 'unread', 'mixed', 'unknown'] as const,
        'unknown',
      ),
      reply_state: normalizeEnum(
        observation.reply_state,
        ['replied', 'no_reply', 'waiting', 'unknown'] as const,
        'unknown',
      ),
      call_state: normalizeEnum(
        observation.call_state,
        ['missed_call', 'called', 'no_call', 'unknown'] as const,
        'unknown',
      ),
      user_words: cleanArray(observation.user_words),
      user_actions: cleanArray(observation.user_actions),
      other_context: cleanArray(observation.other_context),
    },
    attention_point: cleanString(v.attention_point, '画像の中で、ユーザーの心が止まっている一点'),
    wished_future_seed: {
      wished_future: cleanString(wished.wished_future, '遅れても、関係の中でちゃんとつながり直せる'),
      wished_future_scene: cleanString(wished.wished_future_scene, '遅れやすれ違いがあっても、短く状況が戻り、こちらも安心して自分の時間へ戻れる場面'),
      wished_future_reason: cleanString(wished.wished_future_reason, '画像を見返している奥に、待つだけで終わりたくない願いがあるため'),
    },
    continued_future_seed: {
      continued_future: continuedFuture,
      future_scene: cleanString(continued.future_scene, '反応を待ち、何度か確かめてもつながらず、待つ側に残る場面'),
      future_base: futureBase,
      future_label: futureLabel,
      copy_seed: normalizeCopySeed(continued.copy_seed, continuedFuture, futureLabel),
      direction_reason: cleanString(continued.direction_reason, '画像の一点に反応が集まり、未来の見方が固定されているため'),
    },
    gap_seed: {
      gap_between_wish_and_continued_future: cleanString(
        gap.gap_between_wish_and_continued_future,
        'つながり直せる未来を願っているのに、待つ側に残される未来を先に見ている',
      ),
    },
  };
}

function inferContinuedFutureFlow(preSeed: ImaginalPreSeed): ContinuedFutureFlowSeed {
  const base = preSeed.continued_future_seed.future_base;

  const e_turn =
    base === 'creation' ? 'e4'
    : base === 'comparison' ? 'e3'
    : base === 'destruction' ? 'e2'
    : 'e1';

  const polarity =
    base === 'creation' ? 'pos'
    : base === 'unknown' ? 'mixed'
    : 'neg';

  const yure =
    base === 'destruction' ? 'high'
    : base === 'anxiety' || base === 'comparison' ? 'middle'
    : base === 'creation' ? 'low'
    : 'middle';

  const margin =
    base === 'creation' ? 'medium'
    : base === 'destruction' ? 'none'
    : base === 'comparison' ? 'small'
    : base === 'anxiety' ? 'small'
    : 'small';

  const stateSummary =
    base === 'creation'
      ? '創りたい方向はすでに立ち上がっています。次の一手に絞ることで、言葉と行動が現実へ向かいやすい状態です。'
      : base === 'comparison'
        ? '自分の価値や安心を外側の反応で測りやすくなり、確かめるほど心の余白が狭くなります。'
        : base === 'destruction'
          ? '傷つく前に閉じる方向へ意識が寄り、関係や可能性を早めに切ってしまいやすくなります。'
          : base === 'anxiety'
            ? '安心を得たいほど外側の動きに意識が集まり、自分の時間や落ち着きを保ちにくくなります。'
            : '願っている未来と思い続けている未来が混ざり、どちらへ進むかが定まりにくい状態です。';

  const holdReason =
    base === 'creation'
      ? '創造の方向は出ていますが、言葉と行動が一点に集まりきらないと、現実化の手前で散りやすいためです。'
      : base === 'comparison'
        ? '反応を基準にすると、受け取ったものより足りないものへ意識が戻りやすいためです。'
        : base === 'destruction'
          ? '守ろうとする力が強くなるほど、未来を試す前に閉じる行動へ戻りやすいためです。'
          : base === 'anxiety'
            ? '安心の基準が自分の側ではなく外側に置かれると、同じ確認の流れへ戻りやすいためです。'
            : '見ている未来の方向が定まらないと、言葉と行動も定まりにくいためです。';

  return {
    e_turn,
    polarity,
    yure,
    margin,
    state_summary: stateSummary,
    state_hold_reason: holdReason,
  };
}

function inferWishedFutureTransfer(preSeed: ImaginalPreSeed): WishedFutureTransferSeed {
  const wished = preSeed.wished_future_seed.wished_future;
  const continued = preSeed.continued_future_seed.continued_future;
  const base = preSeed.continued_future_seed.future_base;

  const wordShift =
    base === 'creation'
      ? `広がっている思いを、「${wished}」へ向かう一文に絞る`
      : base === 'comparison'
        ? `反応で価値を測る言葉から、「${wished}」を先に置く言葉へ変える`
        : base === 'destruction'
          ? `壊れる前に閉じる言葉から、「${wished}」を守る言葉へ変える`
          : base === 'anxiety'
            ? `不安を確かめる言葉から、「${wished}」を先に置く言葉へ変える`
            : `迷いを確認する言葉から、「${wished}」を選ぶ言葉へ変える`;

  const actionShift =
    base === 'creation'
      ? '考えを広げ続けるだけでなく、今日ひとつ形にして置く行動へ変える'
      : base === 'comparison'
        ? '見比べて確かめ続ける行動から、小さく受け取り、ひとつ進める行動へ変える'
        : base === 'destruction'
          ? '先に閉じる行動から、一度だけ伝えて自分の場へ戻る行動へ変える'
          : base === 'anxiety'
            ? '外側の動きを追い続ける行動から、一度区切って自分の時間へ戻る行動へ変える'
            : '迷い続ける行動から、ひとつ選んで小さく置く行動へ変える';

  const changedFuture =
    base === 'creation'
      ? `言葉と行動が一点に集まることで、「${wished}」が形になり始めます。`
      : `言葉と行動を変えることで、「${wished}」に近づく未来へ移ります。`;

  return {
    wished_future_direction: wished,
    transfer_direction: `「${continued}」を見続ける位置から、「${wished}」へ向かう位置へ移る`,
    required_word_shift: wordShift,
    required_action_shift: actionShift,
    changed_future: changedFuture,
  };
}
function buildImageShapeStateSeed(preSeed: ImaginalPreSeed): ImageShapeStateSeed {
  const source = [
    preSeed.attention_point,
    preSeed.continued_future_seed.continued_future,
    preSeed.continued_future_seed.future_scene,
    preSeed.continued_future_seed.direction_reason,
    preSeed.wished_future_seed.wished_future,
    preSeed.wished_future_seed.wished_future_scene,
    ...preSeed.image_observation.visible_facts,
    ...preSeed.image_observation.user_words,
    ...preSeed.image_observation.user_actions,
    ...preSeed.image_observation.other_context,
  ].filter(Boolean).join('\n');

  const base = preSeed.continued_future_seed.future_base;

  const hasResponseGap =
    /(既読|Read|無応答|応答がない|応答がない|通話がつながら|つながらず|不在|No answer|Missed|折り返し.*ない|返ってこない)/iu.test(source);

  const hasCallOrReach =
    /(電話|通話|着信|呼びかけ|連絡|メッセージ|送信|届く|届いている|つながり|つながる)/iu.test(source);

  const hasRepeat =
    /(複数|連続|何度|何度も|繰り返|重な|並び|増え|積み重|何回|再試行|また|続く|連な)/iu.test(source);

  const hasLongTime =
    /(長い|長引|夜|深夜|夜遅|23時|時間差|待ち続|時間が過ぎ|朝まで|長時間|伸びて|遅く)/iu.test(source);

  const hasShortTime =
    /(短い|短時間|すぐ|直後|10分|数分|一度|一回|すぐに|区切り|短く)/iu.test(source);

  const connectionShape =
    base === 'creation'
      ? '内面で立ち上がった未来が、まだ外の形へ渡りきっていない'
      : hasCallOrReach
        ? 'つながるはずの線が途中で止まっている'
        : '内面で動いているものが、まだ場の中で形を結びきっていない';

  const responseShape =
    base === 'creation'
      ? '出したいものはあるが、言葉と行動の出口がまだ絞りきれていない'
      : hasResponseGap
        ? '届いている気配はあるが、安心として返ってこない'
        : '受け取りたいものが、まだ自分の安心として定着していない';

  const continuityShape =
    base === 'creation'
      ? hasRepeat
        ? '創りたい思いが何度も立ち上がり、形になる一点を探している'
        : 'ひとつの創造の芽が場に置かれようとしている'
      : hasRepeat
        ? '一度で終わらず、同じ呼びかけが場に重なっている'
        : 'ひとつの未完了が場に残り、意識がそこへ戻りやすくなっている';

  const timeShape =
    hasLongTime && hasShortTime
      ? '短く区切りたい願いに対して、待つ時間が長く伸びている'
      : hasLongTime
        ? '待つ時間が伸び、自分の時間を覆い始めている'
        : hasShortTime
          ? '短く区切りたい願いが立ち上がっている'
          : base === 'creation'
            ? 'まだ形にする時点が定まりきらず、未来が手前で揺れている'
            : '時間の区切りが曖昧になり、意識が同じ場に留まりやすくなっている';

  const fieldShape =
    base === 'creation'
      ? '創りたい未来が場に置かれ始めているが、言葉と行動の一点に集める必要がある'
      : hasRepeat
        ? '呼びかけが場に重なり、自分だけが回収を待つ形になっている'
        : '回収されない呼びかけが場に残り、自分の意識がそこへ留まりやすくなっている';

  return {
    connection_shape: connectionShape,
    response_shape: responseShape,
    continuity_shape: continuityShape,
    time_shape: timeShape,
    field_shape: fieldShape,
  };
}


function hasActionCompletionSignal(preSeed: ImaginalPreSeed, imageShape?: ImageShapeStateSeed): boolean {
  const source = JSON.stringify({ preSeed, imageShape });

  const hasCompletion =
    /(予約|予約しました|取りました|取れました|取った|確定|決まりました|決まった|時間|到着|着く予定|向かって|18:30|Event updated|予定|場所|店|レストラン|集合|手配|更新|完了|入れました|押さえました)/.test(source);

  const hasHardAnxiety =
    /(返事がない|既読だけ|無視|不在|出ない|待ち続け|怖い|切れる|終わる|ブロック|拒否)/.test(source);

  return hasCompletion && !hasHardAnxiety;
}

function hasReceivingReturnSignal(preSeed: ImaginalPreSeed): boolean {
  const source = JSON.stringify(preSeed);

  const hasReturn =
    /(感謝|救い|救われ|助か|助かりました|普通に生き|普通に生きれて|続いてます|成果|返ってき|ありがとう|ありがたい)/.test(source);

  const hasHardBoundary =
    /(拒否|迷惑|やめて|連絡しないで|ブロック|距離を置|境界線を引|関わらない)/.test(source);

  return hasReturn && !hasHardBoundary;
}
function inferDirectionKind(preSeed: ImaginalPreSeed, imageShape: ImageShapeStateSeed): DirectionKind {
  // 予定確定・予約完了・行動完了が見える場合は、receiving completion として扱う。
  if (hasActionCompletionSignal(preSeed, imageShape)) return 'receiving';
  // 予定確定・予約完了・行動完了が見える場合は、確認不安ではなく創造の完了として扱う。
  if (hasActionCompletionSignal(preSeed)) return 'creation';
  // receiving は boundary より優先。感謝・救い・成果が返っている場合は、まず受け取り構造として扱う。
  if (hasReceivingReturnSignal(preSeed)) return 'receiving';
  const source = [
    preSeed.attention_point,
    preSeed.continued_future_seed.continued_future,
    preSeed.continued_future_seed.future_scene,
    preSeed.continued_future_seed.direction_reason,
    preSeed.wished_future_seed.wished_future,
    imageShape.connection_shape,
    imageShape.response_shape,
    imageShape.continuity_shape,
    imageShape.time_shape,
    imageShape.field_shape,
  ].filter(Boolean).join('\n');

  const base = preSeed.continued_future_seed.future_base;

  if (base === 'creation') return 'creation';
  if (base === 'comparison') return 'comparison';
  if (base === 'destruction') return 'destruction';

  if (/(境界|守る|距離|線引き|自分の領域|これ以上)/u.test(source)) return 'boundary';
  if (/(受け取|感謝|届いたもの|成果|反応を受け取る)/u.test(source)) return 'receiving';
  if (/(証明|確かめ|確認|反応で安心|安心.*外側|返事.*安心|待つ側)/u.test(source)) return 'confirmation';
  if (/(失う|切れる|置いていかれる|返ってこない恐怖|怖い)/u.test(source)) return 'fear';
  if (/(先延ばし|見ない|避け|逃げ|保留)/u.test(source)) return 'avoidance';
  if (base === 'anxiety') return 'anxiety';

  return 'unknown';
}

function mapDirectionToDisplayLabel(direction: DirectionKind): FutureLabel {
  if (direction === 'creation') return '創造の未来';
  if (direction === 'receiving') return '創造の未来';
  if (direction === 'comparison') return '比較の未来';
  if (direction === 'confirmation' || direction === 'anxiety') return '不安の未来';
  if (direction === 'destruction' || direction === 'avoidance') return '破壊の未来';
  return '不安の未来';
}

function buildFlowPerspectiveSeed(
  preSeed: ImaginalPreSeed,
  imageShape: ImageShapeStateSeed,
): FlowPerspectiveSeed {
  const directionKind = inferDirectionKind(preSeed, imageShape);

  const surfacePolarity: PolarityKind =
    directionKind === 'creation' || directionKind === 'receiving' ? 'pos'
    : directionKind === 'mixed' || directionKind === 'unknown' ? 'mixed'
    : 'neg';

  const innerPolarity: PolarityKind =
    directionKind === 'creation' || directionKind === 'receiving' || directionKind === 'boundary' ? 'pos'
    : directionKind === 'mixed' || directionKind === 'unknown' ? 'mixed'
    : 'neg';

  const utteranceAlignment: UtteranceAlignmentKind =
    surfacePolarity === innerPolarity ? 'aligned'
    : surfacePolarity === 'mixed' || innerPolarity === 'mixed' ? 'partially_aligned'
    : 'misaligned';

  const observedSurface =
    directionKind === 'creation'
      ? '表面では、形にしたいものや進めたい未来が見えている'
      : directionKind === 'receiving'
        ? '表面では、感謝や成果が返ってきている場面として見えている'
        : '表面では、外側の反応を確かめたい動きとして見えている';

  const seenFutureDirection =
    directionKind === 'creation'
      ? '創りたい未来を形にする前で、言葉と行動が一点に集まりきっていない'
      : directionKind === 'receiving'
        ? '返ってきた感謝や成果を受け取り、それを次の創造へ進める未来を先に見ている'
        : directionKind === 'confirmation'
          ? '安心を外側の反応で確かめ続ける未来を先に見ている'
          : directionKind === 'fear'
            ? 'つながりが切れる、戻ってこない未来を先に見ている'
            : directionKind === 'comparison'
              ? '自分の価値や安心を外側との比較で測る未来を先に見ている'
              : directionKind === 'boundary'
                ? '自分の場を守る必要がある未来を見ている'
                : '安心が戻らないまま、自分だけが待つ側に残る未来を先に見ている';

  const directionReason =
    directionKind === 'creation'
      ? '形にしたい方向はあるが、まだ現実へ置く一点が定まりきっていないため'
      : directionKind === 'receiving'
        ? '相手から感謝や成果が返ってきており、その返りを受け取る場が立ち上がっているため'
        : '呼びかけが場に残り、安心の回収を外側に預ける形象が立ち上がっているため';

  return {
    observed_surface: observedSurface,
    direction_kind: directionKind,
    surface_polarity: surfacePolarity,
    inner_polarity: innerPolarity,
    utterance_alignment: utteranceAlignment,
    seen_future_direction: seenFutureDirection,
    direction_reason: directionReason,
  };
}

function buildCurrentFlowInputSeed(
  perspective: FlowPerspectiveSeed,
  flowSeed: ContinuedFutureFlowSeed,
  imageShape: ImageShapeStateSeed,
): FlowInputSeed {
  const depthStage: DepthStageKind =
    perspective.direction_kind === 'creation' || perspective.direction_kind === 'receiving' ? 'S2'
    : perspective.direction_kind === 'confirmation' || perspective.direction_kind === 'anxiety' ? 'S1'
    : perspective.direction_kind === 'fear' || perspective.direction_kind === 'destruction' ? 'S3'
    : 'S1';

  const basedOn =
    perspective.direction_kind === 'receiving'
      ? '感謝や成果はすでに返ってきている。それをさらに確認する材料にせず、成果として受け取る場が立ち上がっている。'
      : perspective.direction_kind === 'creation'
        ? '創りたい方向は立ち上がっているが、まだ形にする一点へ集まりきっていない内的状態'
        : `${imageShape.field_shape}。${flowSeed.state_summary}`;

  return {
    e_turn: flowSeed.e_turn,
    depthStage,
    polarity: perspective.inner_polarity === 'pos' ? 'pos' : 'neg',
    utteranceAlignment: perspective.utterance_alignment,
    basedOn,
  };
}

function buildSecondFlowInputSeed(
  perspective: FlowPerspectiveSeed,
  currentFlow: FlowInputSeed,
  imageShape: ImageShapeStateSeed,
): FlowInputSeed {
  const basedOn =
    perspective.direction_kind === 'receiving'
      ? '返ってきた感謝を成果として受け取ると、次の確認ではなく次の創造へ進みやすくなる。'
      : perspective.direction_kind === 'creation'
        ? 'このまま形にする一点が定まらないと、創造の芽が広がるだけで現実の場に置かれにくくなる'
        : `${imageShape.continuity_shape}。${imageShape.time_shape}。このまま続くと、安心を外側で確かめる流れが強くなる`;

  return {
    e_turn:
      perspective.direction_kind === 'creation' ? 'e4'
      : perspective.direction_kind === 'receiving' ? 'e4'
      : perspective.direction_kind === 'destruction' || perspective.direction_kind === 'fear' ? 'e2'
      : perspective.direction_kind === 'comparison' || perspective.direction_kind === 'confirmation' ? 'e3'
      : currentFlow.e_turn,
    depthStage: currentFlow.depthStage,
    polarity: currentFlow.polarity,
    utteranceAlignment: currentFlow.utteranceAlignment,
    basedOn,
  };
}

function buildImaginalFlowSeed(
  perspective: FlowPerspectiveSeed,
  currentFlow: FlowInputSeed,
  secondFlow: FlowInputSeed,
  preSeed?: ImaginalPreSeed,
): ImaginalFlowSeed {
  const receivingSubKind =
    perspective.direction_kind === 'receiving' && preSeed
      ? inferReceivingSubKind(preSeed)
      : 'generic';

  return {
    transferSeed: {
      from_current_flow: currentFlow.basedOn,
      to_second_flow: secondFlow.basedOn,
      transfer_point:
        perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
          ? '返ってきた一点を足場にして、確認から実行へ移る'
          : perspective.direction_kind === 'receiving'
            ? '返ってきた感謝を確認材料にせず、成果として受け取る'
            : perspective.direction_kind === 'creation'
              ? '広がった創造の芽を、今日置ける一点へ集める'
              : '安心を外側で回収しようとする位置から、自分の場へ戻る',
      word_shift:
        perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
          ? 'さらに確かめる言葉から、決まった一点で進める言葉へ変える'
          : perspective.direction_kind === 'receiving'
            ? 'さらに確かめる言葉から、受け取った成果を場に置く言葉へ変える'
            : perspective.direction_kind === 'creation'
              ? '広げる言葉から、今日置く一文へ変える'
              : '確かめ続ける言葉から、安心を自分の側へ戻す言葉へ変える',
      action_shift:
        perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
          ? '追加確認へ進む前に、決まった時間・場所・次の手順を一行にまとめて実行へ移る'
          : perspective.direction_kind === 'receiving'
            ? '追加確認へ進む前に、返ってきた事実を一度記録する行動へ変える'
            : perspective.direction_kind === 'creation'
              ? '考え続ける行動から、ひとつ形にして置く行動へ変える'
              : '外側を追い続ける行動から、一度区切って自分の場へ戻る行動へ変える',
    },
  };
}

function copyEndingLabelFromDirection(direction: DirectionKind): '不安の未来' | '恐怖の未来' | '比較の未来' | '創造の未来' {
  if (direction === 'creation') return '創造の未来';
  if (direction === 'receiving') return '創造の未来';
  if (direction === 'boundary') return '不安の未来';
  if (direction === 'fear' || direction === 'destruction' || direction === 'avoidance') return '恐怖の未来';
  if (direction === 'comparison') return '比較の未来';
  return '不安の未来';
}

function buildImaginalCopyByDirection(direction: DirectionKind): string {
  const end = copyEndingLabelFromDirection(direction);

  if (direction === 'creation') {
    return `未来は見えてるのに、まだ手が伸びきらない${end}`;
  }

  if (direction === 'receiving') {
    return `受け取ればいいのに、なぜか証明に戻る${end}`;
  }

  if (direction === 'confirmation') {
    return `つながりたいのに、安心を既読に預ける${end}`;
  }

  if (direction === 'fear') {
    return `会いたいのに、先に消える場面を見ている${end}`;
  }

  if (direction === 'comparison') {
    return `進みたいのに、反応で自分を測る${end}`;
  }

  if (direction === 'avoidance') {
    return `向き合いたいのに、見ないことで守ろうとする${end}`;
  }

  if (direction === 'destruction') {
    return `守りたいのに、終わらせて安心しようとする${end}`;
  }

  if (direction === 'boundary') {
    return `守りたいのに、境界線を置けずに揺れる${end}`;
  }

  return `安心したいのに、自分だけが待つ側に残る${end}`;
}
function buildImaginalCoreSeed(
  preSeed: ImaginalPreSeed,
  imageShape: ImageShapeStateSeed,
  perspective: FlowPerspectiveSeed,
  currentFlow: FlowInputSeed,
  secondFlow: FlowInputSeed,
  imaginalFlow: ImaginalFlowSeed,
): ImaginalCoreSeed {
  const displayLabel = mapDirectionToDisplayLabel(perspective.direction_kind);

  const copyEndingLabel = copyEndingLabelFromDirection(perspective.direction_kind);
  const receivingSubKind = perspective.direction_kind === 'receiving' ? inferReceivingSubKind(preSeed, imageShape) : 'generic';

  const copyMaterialSeed =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? [
          '返ってきた一点によって、場が待ちから行動へ移り始めている',
          '予定・時間・場所・返事・予約など、現実が動く材料が返ってきている',
          'コピー素材: 旗が立つ、予定が歩き出す、地図が開く、時計が味方する、席が息をする、など現実が動く比喩を使う。ただし例文を固定コピーにしない。',
          `currentFlow: ${currentFlow.basedOn}`,
          `secondFlow: ${secondFlow.basedOn}`,
          `創造方向: ${imaginalFlow.transferSeed.transfer_point}`,
        ]
      : perspective.direction_kind === 'receiving'
        ? [
            '返ってきた感謝や成果がある',
            '受け取る前に、次の確認へ進みそうになっている',
            'receivingのコピー素材: 花束を飾って進む、拍手を束ねて進む、贈り物を受け取って渡す、感謝の種が芽を出す、など創造側の完了した動きを使う。ただし例文を固定コピーにしない。居座る・残業する・増えるなど不安側の動詞は避ける。',
            `currentFlow: ${currentFlow.basedOn}`,
            `secondFlow: ${secondFlow.basedOn}`,
            `創造方向: ${imaginalFlow.transferSeed.transfer_point}`,
          ]
        : [
            `願っている方向: ${preSeed.gap_seed.gap_between_wish_and_continued_future}`,
            `見続けている未来形象: ${perspective.seen_future_direction}`,
            `currentFlow: ${currentFlow.basedOn}`,
            `secondFlow: ${secondFlow.basedOn}`,
            `形象: ${imageShape.field_shape}`,
            `創造方向: ${imaginalFlow.transferSeed.transfer_point}`,
          ];

  const copyGenerationPolicy = [
    'コピー本文はテンプレートではなく、毎回その場で生成する。',
    '本質をそのまま説明しない。',
    '少し笑える比喩、日常のイメージ、軽いズラしを使う。',
    'ユーザーを責める言い方にしない。',
    '感情に直接刺しすぎず、少し横から触れる。',
    '画像の表面語をそのまま使わない。',
    '例文を固定コピーとして使わない。',
    '末尾だけは copy_ending_label と完全一致させる。',
  ];

  const copyLateralHintSeed = [
    '増えていくものの比喩を使ってよい。ただしコピー内で使う比喩は1つだけにする。羊、待ち番号、通知バッジ、未回収の荷物、閉店後の呼び鈴などから自然に選ぶが固定しない。',
    '眠れない、区切れない、戻れない、置きっぱなし、増殖する、残業する、迷子になる、などの軽いズラしを使ってよい。ただし一文に詰め込みすぎない。',
    '「つながり直したい」「待つ側」「取り残される」「安心を外側」など、本質の直球語はコピーでは避ける。',
    'コピーは少し笑えるくらいでよい。深刻に言いすぎない。比喩を2つ以上混ぜない。願い側の説明を書かず、比喩だけで短く言う。',
    '比喩はSeedの状況から毎回選ぶか、その場で新しく作る。',
    'コピー本文は12〜18文字程度にする。末尾ラベルを含めても長くしない。',
    '「〜したいのに」「自分の落ち着き」「取り戻したい」など願い側の説明は①では避ける。',
    '比喩 + 軽い動き + copy_ending_label の形にする。',
    '名詞だけを連ねたコピーにしない。必ず動きのある言葉を1つ入れる。',
    '「増殖」「渋滞」だけで終わらせず、「育つ」「居座る」「残業する」「逃げる」「増えていく」などの動きを使う。',
    '漢字が詰まりすぎる言い方を避け、少し口語にする。',
    'receivingでは、比喩の動きは創造側にする。例: 飾る、束ねる、受け取る、渡す、進む、芽を出す。居座る、残業する、増える、逃げるは避ける。',
    'receivingでは、コピーを未完了形にしない。「〜したいのに」「〜しそう」「〜のに」で止めない。',
    'receivingでは、比喩 + 創造側の動詞 + copy_ending_label で一文を完結させる。',
  ];

  const imaginalCopy = [
    'Writer生成用のコピー素材です。この文をそのまま出さないこと。',
    ...copyMaterialSeed,
    ...copyGenerationPolicy,
    ...copyLateralHintSeed,
    `コピー末尾は必ず「${copyEndingLabel}」にすること。`,
  ].join('\n');

  const wishedFutureImaginal =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? '返ってきた一点を受け取り、確認を終えて現実の行動へ進むこと'
      : perspective.direction_kind === 'receiving'
        ? '返ってきた感謝や成果を、追加確認に変えず一度受け取ること'
        : perspective.direction_kind === 'creation'
          ? '内面に立ち上がった未来を、言葉と行動の一点として現実の場に置くこと'
          : '外側の反応を追い続ける位置から、自分の場へ安心を戻すこと';

  const seenFutureImaginal =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? '返ってきた一点を足場に、言葉の場が現実の行動へ移る未来を先に見ている（創造の未来）'
      : `${perspective.seen_future_direction}（${displayLabel}）`;

  const shiftedFutureImaginal =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? '決まった一点を受け取り、次の確認ではなく次の行動へ移る未来'
      : perspective.direction_kind === 'receiving'
        ? '感謝を確認材料にせず、受け取った成果として自分の場に置く未来'
        : perspective.direction_kind === 'creation'
          ? '創造の芽を、今日置ける一手として場に出す未来'
          : '未完了の呼びかけを抱え続けず、短く区切って自分の時間を回復する未来';

  const creativeDirection =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? '返ってきた一点を足場にして、確認から実行へ移る'
      : perspective.direction_kind === 'receiving'
        ? '返ってきたものを追い確認に使わず、成果として受け取る'
        : perspective.direction_kind === 'creation'
          ? '創造の方向を、言葉と行動の一点に集める'
          : '安心を外側に預けるのではなく、自分の場へ戻す';

  const smallStep =
    perspective.direction_kind === 'receiving' && receivingSubKind === 'completion'
      ? '決まった時間・場所・次の手順を一行にまとめ、その後は実行へ移る'
      : perspective.direction_kind === 'receiving'
        ? '返ってきた感謝を一文でメモし、追加確認を一度止める'
        : perspective.direction_kind === 'creation'
          ? '今日ひとつ、考えを形として置く'
          : '一度だけ区切りの言葉を置き、その後は自分の時間へ戻る';

  return {
    imaginal_copy_seed: imaginalCopy,
    copy_ending_label: copyEndingLabel,
    copy_material_seed: copyMaterialSeed,
    copy_generation_policy: copyGenerationPolicy,
    copy_lateral_hint_seed: copyLateralHintSeed,
    wished_future_imaginal: wishedFutureImaginal,
    seen_future_imaginal: seenFutureImaginal,
    shifted_future_imaginal: shiftedFutureImaginal,
    creative_direction: creativeDirection,
    small_step: smallStep,
  };
}


type ReceivingSubKind = 'gratitude' | 'completion' | 'generic';

function inferReceivingSubKind(
  preSeed: ImaginalPreSeed,
  imageShape?: ImageShapeStateSeed,
): ReceivingSubKind {
  const source = JSON.stringify({ preSeed, imageShape });

  const hasCompletion =
    /(予約|取りました|取ってくれ|取れました|確定|決まりました|決まった|時間|到着|着く予定|向かって|18:30|Event updated|予定|場所|店|レストラン|集合|手配|更新)/.test(source);

  if (hasCompletion) return 'completion';

  const hasGratitude =
    /(感謝|ありがとう|ありがと|救い|救われ|助か|助かりました|成果|返ってき|普通に生き|続いてます)/.test(source);

  if (hasGratitude) return 'gratitude';

  return 'generic';
}
function buildEffectiveImageShapeStateSeed(
  imageShape: ImageShapeStateSeed,
  perspective: FlowPerspectiveSeed,
  preSeed?: ImaginalPreSeed,
): ImageShapeStateSeed {
  if (perspective.direction_kind !== 'receiving') return imageShape;

  const subKind = preSeed ? inferReceivingSubKind(preSeed, imageShape) : 'generic';

  if (subKind === 'completion') {
    return {
      connection_shape: '返ってきた一点によって、場が待ちから行動へ移り始めている',
      response_shape: '届いた返事を確認材料ではなく、現実を進める足場として受け取れる状態にある',
      continuity_shape: '確認を重ねる流れから、決まった一点を使って次の行動へ移る流れが立ち上がっている',
      time_shape: '待つ時間から、決まった時間に合わせて動く時間へ切り替わる地点にいる',
      field_shape: '言葉の場が、予定・場所・行動へ移る形になっている',
    };
  }

  return {
    connection_shape: '返ってきた感謝や成果が、すでに場に届いている',
    response_shape: '届いたものを、確認材料ではなく成果として受け取れる状態にある',
    continuity_shape: '受け取った成果を、次の確認ではなく次の創造へ渡せる流れが立ち上がっている',
    time_shape: '確認を重ねる時間から、受け取って次へ進む時間へ切り替わる地点にいる',
    field_shape: '感謝や成果が場に返ってきており、それを自分の場に置ける形になっている',
  };
}
function buildWriterUsagePolicySeed(): WriterUsagePolicySeed {
  return {
    attention_point:
      'use_as_shape_source_only: 画像上で反応が集まる一点を知るために使う。診断本文には、attention_pointの語句を直接出さない。必要な場合は image_shape_state_seed の形象語へ変換して使う。',
    wished_future:
      'use_as_future_direction: ②願っている未来の正本として使う。ただし、スクショ由来の表面語や長い状況説明をそのまま引用せず、願っている未来の方向として短く整える。',
    continued_future:
      'use_as_continued_future_direction: ③思い続けている未来の正本として使う。ただし、Missed、No answer、既読、時刻、着信履歴などの表示文字をそのまま本文に出さず、未来の方向として整える。',
    future_scene:
      'do_not_write_directly: future_sceneは本文に直接使わない。連続、長い、短い、未完了、待ち続ける、重なりなどの形象を作る根拠としてのみ使う。',
    wished_future_transfer_seed:
      'use_as_transfer_direction_only: ⑤未来を変える言葉と行動の方向として使う。required_word_shift、required_action_shift、changed_futureなどのキー名や文を丸写ししない。ユーザー向けの自然文へ変換する。',
    image_shape_state_seed:
      'use_as_primary_shape_material: ④くり返す出来事や起こりえる出来事では、image_shape_state_seedを主材料にする。connection_shape、response_shape、continuity_shape、time_shape、field_shape を使い、画像事実ではなく形象の状態として書く。',
    output_priority: [
      '1. image_shape_state_seed',
      '2. continued_future_flow_seed',
      '3. pre_seed.gap_seed',
      '4. pre_seed.wished_future_seed.wished_future',
      '5. pre_seed.continued_future_seed.continued_future',
      '6. wished_future_transfer_seed',
      '7. attention_point と future_scene は直接使わず、形象化の根拠に限定する',
    ],
    prohibited_direct_use: [
      'Missed',
      'No answer',
      '既読',
      'Read',
      '時刻',
      '23時台',
      '不在着信',
      'ミーティング',
      'attention_point',
      'future_scene',
      'required_word_shift',
      'required_action_shift',
      'changed_future',
    ],
  };
}
function extractAssistantContent(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function safeParseJsonObject(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function normalizeDiagnosisText(value: unknown, seed: ImaginalDiagnosisSeed): string {
  const raw = cleanString(value);
  const fallback = [
    'Muのイマジナル診断',
    '',
    'イマジナルコピー',
    seed.pre_seed.continued_future_seed.copy_seed,
    '',
    '願っている未来',
    `あなたが本当は向かいたい未来は、${seed.pre_seed.wished_future_seed.wished_future_scene}です。`,
    '',
    '思い続けている未来',
    `けれど今、長く思い続けている未来は、${seed.pre_seed.continued_future_seed.copy_seed}です。`,
    '',
    'くり返す出来事や起こりえる出来事',
    `この未来を見続けると、${seed.continued_future_flow_seed.state_summary}`,
    '',
    '未来を変える言葉と行動',
    `願っている未来を現実に近づけるには、言葉を「${seed.wished_future_transfer_seed.required_word_shift}」に変え、行動を「${seed.wished_future_transfer_seed.required_action_shift}」に置き換えることです。`,
    '',
    'これは、画像をきっかけに見えた「今現在のイマジナル」です。',
  ].join('\n');

  const text = raw || fallback;
  const note = 'これは、画像をきっかけに見えた「今現在のイマジナル」です。';
  const withoutDuplicateNote = text
    .replace(/これは、画像をきっかけに見えた「今現在のイマジナル」です。\s*/gu, '')
    .trim();

  return [withoutDuplicateNote, note].filter(Boolean).join('\n\n');
}

async function uidToUserCode(uid: string): Promise<string | null> {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const q = await sb
      .from(c.table)
      .select(c.codeCol)
      .eq(c.uidCol, uid)
      .maybeSingle();

    if (!q.error && q.data && q.data[c.codeCol]) {
      return String(q.data[c.codeCol]);
    }
  }

  return null;
}

async function getMuScreenshotUserType(userCode: string): Promise<string> {
  const { data, error } = await sb
    .from('users')
    .select('click_type')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  return String(data?.click_type || 'other').toLowerCase();
}

function canUseMuImaginalDiagnosis(userType: string): boolean {
  return MU_IMAGINAL_ALLOWED_USER_TYPES.includes(String(userType || '').toLowerCase());
}

async function hasEnoughMuScreenshotSofiaCredit(userCode: string): Promise<boolean> {
  const { data, error } = await sb
    .from('users')
    .select('sofia_credit')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;

  const credit = Number(data?.sofia_credit ?? 0);
  return Number.isFinite(credit) && credit >= MU_IMAGINAL_CREDIT_COST;
}

async function consumeMuScreenshotSofiaCredit(userCode: string): Promise<boolean | null> {
  try {
    const { data, error } = await sb.rpc('consume_mu_screenshot_sofia_credit', {
      p_user_code: userCode,
      p_amount: MU_IMAGINAL_CREDIT_COST,
    });

    if (error) throw error;
    return Boolean(data);
  } catch (e: any) {
    console.warn('[mu-imaginal-diagnosis] consume_mu_screenshot_sofia_credit failed:', e?.message || e);
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

async function deleteDiagnosisLog(id: string): Promise<void> {
  if (!id) return;

  const { error } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .delete()
    .eq('id', id);

  if (error) {
    console.warn('[mu-imaginal-diagnosis] rollback log delete failed:', error.message);
  }
}

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
  conversationId: string | null;
  diagnosisText: string;
  diagnosisSeedJson: ImaginalDiagnosisSeed;
}) {
  const displayId = await getNextScreenshotDiagnosisDisplayId(params.userCode);

  const { data, error } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .insert({
      user_code: params.userCode,
      model: params.model,
      source: params.source,
      media_code: params.mediaCode,
      conversation_id: params.conversationId,
      display_id: displayId,
      mode: 'imaginal',
      credit_used: MU_IMAGINAL_CREDIT_COST,
      credit_cost: MU_IMAGINAL_CREDIT_COST,
      diagnosis_text: params.diagnosisText,
      diagnosis_seed_json: params.diagnosisSeedJson,
    })
    .select('id')
    .single();

  if (error) throw error;
  return String(data?.id || '');
}

export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) {
      return json({ ok: false, error: authz.error ?? 'unauthorized' }, 401);
    }

    const { user } = normalizeAuthz(authz);
    let userCode = user?.user_code ?? null;

    if (!userCode && authz.uid) {
      userCode = await uidToUserCode(authz.uid);
    }

    if (!userCode) {
      return json({ ok: false, error: 'no_user_code' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as {
      image_data_url?: string;
      source?: string;
      media_code?: string | null;
      conversation_id?: string | null;
      conversationId?: string | null;
    };

    const imageDataUrl = normalizeDataUrl(body.image_data_url);
    if (!imageDataUrl) {
      return json({ ok: false, error: 'invalid_image' }, 400);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json({ ok: false, error: 'missing_openai_api_key' }, 500);
    }

    const userType = await getMuScreenshotUserType(userCode);
    if (!canUseMuImaginalDiagnosis(userType)) {
      return json({ ok: false, error: 'screenshot_diagnosis_plan_required' }, 403);
    }

    const hasCredit = await hasEnoughMuScreenshotSofiaCredit(userCode);
    if (!hasCredit) {
      return json({ ok: false, error: 'no_mu_screenshot_credit' }, 402);
    }

    const model = process.env.MU_IMAGINAL_DIAGNOSIS_MODEL || process.env.MU_SCREENSHOT_DIAGNOSIS_MODEL || 'gpt-5-mini';

    const preSeedSystem = [
      'あなたはMuverseの新イマジナル診断の一次解析を行うMuです。',
      '画像を見て、ユーザーがいま思い続けている未来と、本当は願っている未来をSeed化してください。',
      '診断文は書かないでください。出力はJSONのみです。',
      '画像に写っている事実を見てください。既読、未読、Read表示、返信の有無、コール、不在着信、通話履歴があれば観測してください。',
      'ただし、相手の気持ちや未来は断定しないでください。見る対象は、画像を送ったユーザーの中で立ち上がっている未来です。',
      '重要: continued_future は状態説明ではなく、ユーザーが先に見てしまっている「このまま続いた先の未来」にしてください。',
      '重要: future_scene は、画像の事実から立ち上がる未来の一場面として書いてください。画像にない場所・姿勢・生活状況は足さないでください。',
      '重要: copy_seed は、continued_future を短く圧縮し、必ず末尾を「不安の未来」「破壊の未来」「比較の未来」「創造の未来」のいずれかで閉じてください。',
      '重要: wished_future は「安心して自分の未来へ進めること」のような汎用語で逃げないでください。画像に即して、何が回復すると願っているかを書いてください。',
      '重要: wished_future_scene は、相手の具体的なセリフを指定しないでください。相手を動かす未来ではなく、関係の場がどう回復するか、自分がどう安心して戻れるかを書いてください。',
      '思い続けている未来の基本分類は、不安 / 破壊 / 比較 / 創造 の4つです。',
      'future_base と future_label は必ず対応させてください。不安の未来=anxiety、破壊の未来=destruction、比較の未来=comparison、創造の未来=creation です。',
      '創造の未来は、すでに創りたい方向や置きたい未来が立ち上がっている状態です。単なる前向きさではなく、言葉や行動へ移せる未来として扱ってください。',
      '確認、受け取り、境界線、混在、不明は内部状態として見てもよいですが、continued_future、future_scene、copy_seed、future_labelにはそのまま出さないでください。',
      'JSONは version, image_observation, attention_point, wished_future_seed, continued_future_seed, gap_seed を持つオブジェクトにしてください。',
      'version は imaginal_pre_seed_v2 にしてください。',
      'wished_future_seed は wished_future, wished_future_scene, wished_future_reason を持ってください。',
      'continued_future_seed は continued_future, future_scene, future_base, future_label, copy_seed, direction_reason を持ってください。',
      'copy_seed の良い例: このままつながれず、私だけ待つ側に残される不安の未来。',
      'wished_future_scene の良い例: 遅れやすれ違いがあっても、短く状況が戻り、こちらも安心して自分の時間へ戻れる場面。',
      'copy_seed の悪い例: 既読の向こうで、私が先に進む瞬間。これは状態コピーであり、見続けている未来ではありません。',
      'wished_future_scene の悪い例: 相手が「ミーティング終わったよ、ごめんね。大丈夫？」と言ってくれる場面。これは相手のセリフを指定しすぎています。',
    ].join('\n');

    const preSeedRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: preSeedSystem },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'この画像から、診断文ではなく ImaginalPreSeed JSON だけを作ってください。',
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!preSeedRes.ok) {
      const detail = await preSeedRes.text().catch(() => '');
      console.error('[mu-imaginal-diagnosis] preseed LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const preSeedData = await preSeedRes.json().catch(() => ({}));
    const rawPreSeed = extractAssistantContent(preSeedData);

    if (!rawPreSeed) {
      return json({ ok: false, error: 'empty_preseed' }, 502);
    }

    const preSeed = normalizePreSeed(safeParseJsonObject(rawPreSeed));
    const continuedFutureFlowSeed = inferContinuedFutureFlow(preSeed);
    const wishedFutureTransferSeed = inferWishedFutureTransfer(preSeed);
    const imageShapeStateSeed = buildImageShapeStateSeed(preSeed);
    const writerUsagePolicySeed = buildWriterUsagePolicySeed();
    const flowPerspectiveSeed = buildFlowPerspectiveSeed(preSeed, imageShapeStateSeed);
const effectiveImageShapeStateSeed = buildEffectiveImageShapeStateSeed(imageShapeStateSeed, flowPerspectiveSeed, preSeed);
    const currentFlowInputSeed = buildCurrentFlowInputSeed(flowPerspectiveSeed, continuedFutureFlowSeed, effectiveImageShapeStateSeed);
    const secondFlowInputSeed = buildSecondFlowInputSeed(flowPerspectiveSeed, currentFlowInputSeed, effectiveImageShapeStateSeed);
    const imaginalFlowSeed = buildImaginalFlowSeed(flowPerspectiveSeed, currentFlowInputSeed, secondFlowInputSeed, preSeed);
    const imaginalCoreSeed = buildImaginalCoreSeed(preSeed, effectiveImageShapeStateSeed, flowPerspectiveSeed, currentFlowInputSeed, secondFlowInputSeed, imaginalFlowSeed);

    const diagnosisSeed: ImaginalDiagnosisSeed = {
      version: 'imaginal_diagnosis_seed_v2',
      writer_usage_policy_seed: writerUsagePolicySeed,
      flow_perspective: flowPerspectiveSeed,
      current_flow_input_seed: currentFlowInputSeed,
      second_flow_input_seed: secondFlowInputSeed,
      imaginal_flow_seed: imaginalFlowSeed,
      imaginal_core_seed: imaginalCoreSeed,      image_shape_state_seed: effectiveImageShapeStateSeed,
      pre_seed: preSeed,
      continued_future_flow_seed: continuedFutureFlowSeed,
      wished_future_transfer_seed: wishedFutureTransferSeed,
      writer_directives: [
        'Mu文体で返す',
        '画像を見直さない',
        'PreSeedとFlow結果だけを正本にする',
        'image_shape_state_seedを画像由来の形象として使う',
        'writer_usage_policy_seedの使用可否に従う',
        'イマジナルコピーは、思い続けている未来と願っている未来の差分から作る',
        'wished_future_seed.wished_futureを願っている未来の正本にする',
        'continued_future_seed.continued_futureを思い続けている未来の正本にする',
        '相手の気持ちは断定しない',
        '相手の具体的なセリフを指定しない',
        '画像にない場所・姿勢・生活状況を足さない',
        '確認の未来、受け取りの未来、境界線の未来、混在の未来、不明の未来を表示しない',
        '診断文は5項目で返す',
      ],
    };
    const writerDiagnosisSeed = {
      version: diagnosisSeed.version,
      flow_perspective: diagnosisSeed.flow_perspective,
      current_flow_input_seed: diagnosisSeed.current_flow_input_seed,
      second_flow_input_seed: diagnosisSeed.second_flow_input_seed,
      imaginal_flow_seed: diagnosisSeed.imaginal_flow_seed,
      imaginal_core_seed: diagnosisSeed.imaginal_core_seed,
      image_shape_state_seed: diagnosisSeed.image_shape_state_seed,
      writer_usage_policy_seed: diagnosisSeed.writer_usage_policy_seed,
      writer_instruction: {
        use_this_seed_only: true,
        do_not_use_raw_pre_seed: true,
        primary_source: 'imaginal_core_seed',
        secondary_source: 'flow_perspective / current_flow_input_seed / second_flow_input_seed / imaginal_flow_seed.transferSeed',
        do_not_write_surface_terms: [
          'Missed',
          'No answer',
          '既読',
          'Read',
          '時刻',
          '23時台',
          '不在着信',
          'ミーティング',
          '通話',
          '電話',
          '折り返し',
          'メッセージ',
        ],
        internal_direction_labels: ['creation', 'receiving', 'anxiety', 'fear', 'confirmation', 'comparison', 'avoidance', 'destruction', 'boundary', 'mixed', 'unknown'],
    section_rules: {
          copy: '①は imaginal_core_seed.copy_material_seed、copy_generation_policy、copy_lateral_hint_seed、copy_ending_label からWriterが毎回新しく生成する。テンプレート化しない。直球語と願い側の説明を避ける。比喩は1つだけ。本文は12〜18文字程度。名詞だけを連ねず、必ず動きのある言葉を1つ入れる。形式は「比喩 + 動き + copy_ending_label」。コピー本文に「未来」を入れない。末尾だけcopy_ending_labelに完全一致させる。',
          copy_ending_rule: 'コピーの末尾は必ず「不安の未来」「恐怖の未来」「比較の未来」「創造の未来」のいずれかにする。',
          wished_future: '②は imaginal_core_seed.wished_future_imaginal を正本にする。',
          continued_future: '③は imaginal_core_seed.seen_future_imaginal を正本にする。creation / receiving / anxiety / confirmation などの内部英語ラベルは本文に出さない。',
          spoken_reaction: '表面の言葉と内的状態のズレは flow_perspective.utterance_alignment から自然に説明する。',
          action_reaction: '行動に出る反応は current_flow_input_seed と second_flow_input_seed から説明する。',
          repeated_event: '④は second_flow_input_seed と image_shape_state_seed を使う。',
          creative_direction: '⑤は imaginal_core_seed.creative_direction と imaginal_flow_seed.transferSeed を使う。⑤は手順説明を長くしすぎない。I層の移動、つまり「どこからどこへ意識と行動が移るか」を短く書く。',
          small_step: '今日の小さな一歩は imaginal_core_seed.small_step を使う。',
        },
      },
    };
    if (process.env.DEBUG_IMAGINAL_SEED === '1') {
      console.log(
        '[mu-imaginal-diagnosis] preSeed',
        JSON.stringify(preSeed, null, 2)
      );
      console.log(
        '[mu-imaginal-diagnosis] continuedFutureFlowSeed',
        JSON.stringify(continuedFutureFlowSeed, null, 2)
      );
      console.log(
        '[mu-imaginal-diagnosis] wishedFutureTransferSeed',
        JSON.stringify(wishedFutureTransferSeed, null, 2)
      );
      console.log(
        '[mu-imaginal-diagnosis] diagnosisSeed',
        JSON.stringify(writerDiagnosisSeed, null, 2)
      );
    }

    const writerSystem = [
      'あなたはMuverseの新イマジナル診断のWriterです。',
      '渡された writerDiagnosisSeed だけを正本にしてください。画像を見直さないでください。rawのpre_seedは本文に使わないでください。',
      'writerDiagnosisSeed は flow_perspective、current_flow_input_seed、second_flow_input_seed、imaginal_flow_seed、imaginal_core_seed を含みます。これを正本にしてください。',
      'image_shape_state_seed は、画像事実を形象化したSeedです。Missed、No answer、既読、時刻、不在着信などの表示文字を本文に直接出さず、connection_shape、response_shape、continuity_shape、time_shape、field_shape の形象として使ってください。',
      'writer_usage_policy_seed は、Seed内の各項目を本文に使うかどうかの指示です。必ずこの指示に従ってください。attention_point と future_scene は直接本文に使わず、形象化の根拠としてだけ使ってください。wished_future と continued_future は未来の方向として使い、画像語をそのまま出さないでください。wished_future_transfer_seed は⑤の方向として使い、キー名や文を丸写ししないでください。',
      '画像の事実説明ではなく、ユーザーが見続けている未来形象、currentFlow、secondFlow、creativeDirection を診断してください。secondFlow は創造方向ではなく、その未来形象を見続けた場合の次状態です。',
      'image_observation は状況に即すための根拠です。画像説明として羅列しないでください。future_scene、attention_point、visible_facts、read_state、reply_state、call_state を本文にそのまま出さないでください。',
      'receivingの場合は、居座る・残業する・増えるなど不安側の動詞を使わないでください。飾る、束ねる、受け取る、渡す、進む、芽を出すなど創造側の動詞を使ってください。receivingではコピーを未完了形にしないでください。「〜したいのに」「〜のに」で止めず、比喩 + 創造側の動詞 + copy_ending_label で完結させてください。',
      '①イマジナルコピーは、imaginal_core_seed.copy_material_seed、copy_generation_policy、copy_lateral_hint_seed、copy_ending_label を素材にして、Writerが毎回新しく生成してください。テンプレート化しないでください。願い側の説明を書かず、短い比喩コピーにしてください。「〜したいのに」「自分の落ち着き」「取り戻したい」「待つ側」「安心を外側」などの直球語を避けてください。比喩は1つだけにしてください。コピー本文は12〜18文字程度にしてください。名詞だけを連ねたコピーにせず、必ず動きのある言葉を1つ入れてください。たとえば「通知バッジ増殖」ではなく「通知バッジだけ育つ」「通知バッジが居座る」「呼び鈴だけ残業する」のようにしてください。ただし例文を固定コピーとして使わないでください。コピー本文に「未来」という語を入れないでください。「未来」は末尾のcopy_ending_labelにだけ含めてください。コピーの末尾は必ず copy_ending_label と完全一致させてください。',
      '①は改善案にしないでください。「変える」「仕組み」「循環へ移る」ではなく、今見続けている未来のズレを言葉にしてください。',
      '①の型は「〇〇したいのに、□□の未来」のようにしてください。',
      '②願っている未来は、imaginal_core_seed.wished_future_imaginal を正本にしてください。表面の出来事ではなく、本当は向かいたい方向として書いてください。',
      '③見続けている未来は、imaginal_core_seed.seen_future_imaginal と flow_perspective.direction_kind を正本にしてください。',
      '④くり返す出来事や起こりえる出来事は、second_flow_input_seed と image_shape_state_seed をもとに書いてください。これは創造方向ではなく、今の未来形象を見続けた場合に起こりやすい次状態です。',
      '⑤未来を変える言葉と行動は、imaginal_flow_seed.transferSeed、imaginal_core_seed.creative_direction、small_step をもとに書いてください。',
      '⑤では、抽象論ではなく、画像から見えている状況に即して、言葉と行動の置き換えを具体的に説明してください。',
      '相手の気持ち、相手の未来、相手の人格を断定しないでください。',
      '「確認の未来」「受け取りの未来」「境界線の未来」「混在の未来」「不明の未来」は表示しないでください。',
      '出力はJSONのみです。キーは diagnosis だけにしてください。',
      '特定の比喩を固定テンプレートにしないでください。羊、通知、画面、スマホ、待合室などは使ってもよいですが、毎回Seedから自然に選んでください。',
      'receivingなどの内部英語ラベルを本文に出さないでください。',
      '本文にSeed名、JSONキー名、内部タグ、画像観測ログを出さないでください。copy_material_seedという語を本文に出さないでください。',
      'diagnosis の本文は必ず次の5項目にしてください: ① イマジナルコピー、② 願っている未来、③ 思い続けている未来、④ くり返す出来事や起こりえる出来事、⑤ 未来を変える言葉と行動。',
      '最後に必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」を入れてください。',
    ].join('\n');
    const writerRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: writerSystem },
          {
            role: 'user',
            content: [
              '以下のSeed群を正本として、Muのイマジナル診断文を書いてください。',
              JSON.stringify(writerDiagnosisSeed, null, 2),
            ].join('\n\n'),
          },
        ],
      }),
    });

    if (!writerRes.ok) {
      const detail = await writerRes.text().catch(() => '');
      console.error('[mu-imaginal-diagnosis] writer LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const writerData = await writerRes.json().catch(() => ({}));
    const rawWriter = extractAssistantContent(writerData);
    const writerJson = safeParseJsonObject(rawWriter);
    const diagnosis = normalizeDiagnosisText(writerJson.diagnosis, diagnosisSeed);

    let diagnosisLogId = '';

    try {
      diagnosisLogId = await logDiagnosis({
        userCode,
        model,
        source: body.source || 'mu_imaginal',
        mediaCode: body.media_code || null,
        conversationId: body.conversation_id || body.conversationId || null,
        diagnosisText: diagnosis,
        diagnosisSeedJson: diagnosisSeed as any,
      });
    } catch (e: any) {
      console.error('[mu-imaginal-diagnosis] log failed:', e?.message || e);
      return json({ ok: false, error: 'log_failed' }, 500);
    }

    const creditConsumed = await consumeMuScreenshotSofiaCredit(userCode);
    if (creditConsumed === false) {
      await deleteDiagnosisLog(diagnosisLogId);
      return json({ ok: false, error: 'no_mu_screenshot_credit' }, 402);
    }

    if (creditConsumed === null) {
      await deleteDiagnosisLog(diagnosisLogId);
      return json({ ok: false, error: 'credit_consume_failed' }, 500);
    }

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      diagnosis_seed: diagnosisSeed,
      diagnosis_log_id: diagnosisLogId || null,
      source: body.source || 'mu_imaginal',
      credit_consumed: MU_IMAGINAL_CREDIT_COST,
      model,
    });
  } catch (e: any) {
    console.error('[mu-imaginal-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}


