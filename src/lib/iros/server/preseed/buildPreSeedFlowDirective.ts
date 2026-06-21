import type {
  CreateIntegrity,
  CreateSource,
  FlowBand,
  PreSeedDecision,
  PreSeedFlowDirective,
  PreSeedFlowDirection,
  PreSeedInputIntent,
  SritcfAxis,
} from './types';

type BuildPreSeedFlowDirectiveArgs = {
  userText: string;
  preSeedDecision?: PreSeedDecision | null;
  decision?: PreSeedDecision | null;
  meta?: any;
  historyForTurn?: any[];
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function compactText(value: unknown): string {
  return normalizeText(value).replace(/[ \t\r\n　]/g, '').toLowerCase();
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function isFlowAcceptanceText(value: unknown): boolean {
  const c = compactText(value);
  return /やってみます|動いてみます|試してみます|進めてみます|その方向で|少し動|一歩や|それで行|その形で|置いてみます/u.test(c);
}

function isImaginalFormCreateRequest(value: unknown): boolean {
  const c = compactText(value);
  const asksNext =
    // IMAGE_FIRST_CREATE_PLACE_ASK_FLOW_DIRECTIVE_V1
    /どうすれば|どうしたら|次に|何をすれば|なにをすれば|どう動けば|どう進め|行動|やること|何を先に置けば|何を置けば|何を先に置く|何を置く|先に.*置けば|先に.*置くもの/u.test(c);
  const asksText =
    /なんて送|何て送|どう返|文面|文章|メッセージ|言葉にして|返信/u.test(c);

  return asksNext && !asksText;
}

// WORD_CREATE_ESCAPE_IMAGE_FIRST_GUARD_V1
function isWordCreateRequest(value: unknown): boolean {
  const c = compactText(value);
  return /相手に送るなら|送るなら|なんて送|何て送|どう送|どう返|返信文|返事文|返信|返事|文面|文章|メッセージ|一文|短い文|文を|言い方|言葉にして|言葉にする|作って|作る/u.test(c);
}

// ACTION_CREATE_ESCAPE_IMAGE_FIRST_GUARD_V3
function isActionCreateRequest(value: unknown): boolean {
  const c = compactText(value);
  return /今日.*何をすれば|今日は何をすれば|今日.*やる|今日中に.*やる|今から.*やる|実際にやること|やることを一つ|やることを1つ|一つだけ決め|1つだけ決め|次の一歩|次の一歩|具体的にください|具体的に決め|何から始めれば|どこから始めれば|このあと.*始めれば|小さな行動|行動を一つ|行動を1つ|最初の一歩|最初の一歩/u.test(c);
}

function buildCreateDirective(args: {
  imageFirstCreate: boolean;
  wordCreate: boolean;
  actionCreate: boolean;
  flowAcceptance: boolean;
  shouldUseCreate: boolean;
  shouldUseSmallAction: boolean;
}): PreSeedFlowDirective['createDirective'] {
  if (args.flowAcceptance) {
    return {
      mode: 'flow_acceptance',
      createObject: 'small_gesture',
      imaginalFormFirst: false,
      instruction:
        'ユーザーはすでに動く方向を受け取っている。行動を追加で命令せず、その小さな流れが現実に置かれ始めていることを短く支える。',
      writerMove: ['acknowledge_flow', 'stabilize_small_motion', 'do_not_add_homework'],
      avoid: ['forcing_more_action', 'too_many_options', 'over_explaining_relationship'],
    };
  }

  if (args.wordCreate) {
    return {
      mode: 'word_create',
      createObject: 'one_sentence',
      imaginalFormFirst: false,
      instruction:
        'SEED制御: この返信はWord Createである。形象固定文に戻さず、ユーザーが求めた文面・返信文・一文を短くそのまま出す。分析だけで終わらせない。',
      writerMove: ['form_one_sentence', 'make_sendable_text', 'keep_short_and_natural'],
      avoid: ['image_first_fixed_final', 'action_homework', 'over_explaining', 'too_many_options'],
    };
  }

  if (args.imageFirstCreate) {
    return {
      mode: 'image_first_create',
      createObject: 'inner_scene',
      imaginalFormFirst: true,
      instruction:
        'SEED制御: この返信は行動指示ではなく形象Createである。冒頭を文案・行動案・質問・選択肢から始めない。まず本人の内側に見える形象を一つ立てる。その形象から自然に出る一歩だけを添える。',
      writerMove: ['show_the_shape', 'name_the_scene', 'offer_one_small_form', 'let_the_user_feel_it_before_acting'],
      avoid: ['commanding_action', 'asking_user_to_decide_from_zero', 'too_many_options', 'homework', 'over_explaining_relationship'],
    };
  }

  if (args.shouldUseSmallAction) {
    return {
      mode: 'action_create',
      createObject: 'small_action',
      imaginalFormFirst: true,
      instruction:
        '大きな行動へ押さず、意図が現実に置ける最小形を一つだけ示す。先に形象、次に一歩。',
      writerMove: ['show_the_shape', 'place_one_small_action'],
      avoid: ['large_action', 'too_many_options', 'pressure_to_execute'],
    };
  }

  if (args.shouldUseCreate) {
    return {
      mode: 'word_create',
      createObject: 'one_sentence',
      imaginalFormFirst: true,
      instruction:
        '説明を増やさず、意図が言葉になる前の形を一つ置き、それを短い言葉にする。',
      writerMove: ['show_the_shape', 'form_one_sentence'],
      avoid: ['over_explaining', 'mind_reading', 'forcing_decision'],
    };
  }

  return null;
}

function getMetaObject(value: any): Record<string, any> {
  return value && typeof value === 'object' ? value : {};
}

function readPreviousDirective(meta: any): any | null {
  const m = getMetaObject(meta);
  const ctxPack = getMetaObject(m.ctxPack ?? m.extra?.ctxPack);
  return (
    ctxPack.preSeedFlowDirective ??
    m.preSeedFlowDirective ??
    m.extra?.preSeedFlowDirective ??
    null
  );
}

function inferInputIntent(userText: string, decision: PreSeedDecision): PreSeedInputIntent {
  const c = compactText(userText);
  const goalKind = String((decision as any).goalKind ?? decision.metaPatch?.goalKind ?? '').trim();
  const followupKind = String((decision as any).followupKind ?? decision.metaPatch?.followupKind ?? '').trim();

  if (isFlowAcceptanceText(userText)) return 'continue';
  if (goalKind === 'deepen' || /深め|もう少し|詳しく|掘って|見て/u.test(c)) return 'deepen';
  if (goalKind === 'explain_reason' || followupKind === 'reason_detail') return 'explain_reason';
  if (/なぜ|なんで|どうして|理由|根拠/u.test(c)) return 'explain_reason';
  if (/つまり|どういうこと|意味|わかりやすく|言い換え/u.test(c)) return 'clarify';
  if (/違う|ちょっと違う|そうじゃない|修正|ズレ/u.test(c)) return 'correct';
  if (/なんて送|何て送|どう返|文面|文章|メッセージ|言葉にして/u.test(c)) return 'create';
  if (/どうすれば|どうしたら|次に|行動|やること|何を先に置けば|何を置けば|何を先に置く|何を置く|先に.*置けば|先に.*置くもの/u.test(c)) return 'ask_action';
  if (/続き|そのまま|このまま/u.test(c)) return 'continue';

  return 'unknown';
}

function inferAxisAndBand(args: {
  userText: string;
  intent: PreSeedInputIntent;
  decision: PreSeedDecision;
}): { currentAxis: SritcfAxis | null; currentBand: FlowBand | null } {
  const c = compactText(args.userText);
  const kind = args.decision.kind;
  const sourceKind = String(args.decision.sourceKind ?? '').trim();

  if (args.intent === 'continue' && isFlowAcceptanceText(args.userText)) {
    return { currentAxis: 'F', currentBand: 'SF' };
  }

  if (args.intent === 'create' || args.intent === 'ask_action') {
    return { currentAxis: 'C', currentBand: 'RC' };
  }

  if (args.intent === 'explain_reason') {
    return { currentAxis: 'I', currentBand: 'IT' };
  }

  if (args.intent === 'correct') {
    return { currentAxis: 'R', currentBand: 'RC' };
  }

  if (/不安|怖い|つらい|苦しい|焦る|気になる|待つ/u.test(c)) {
    return { currentAxis: 'S', currentBand: 'SF' };
  }

  if (
    kind === 'relationship_reference' ||
    kind === 'person_reference' ||
    /関係|相手|あの人|彼|彼女|みゆ|リナ/u.test(c) ||
    /relationship|person/u.test(sourceKind)
  ) {
    return { currentAxis: 'R', currentBand: 'RC' };
  }

  if (/意図|方向|本当は|結局|核心|大事なのは/u.test(c)) {
    return { currentAxis: 'I', currentBand: 'IT' };
  }

  return { currentAxis: null, currentBand: null };
}

function getSameTargetStreak(meta: any): number {
  const m = getMetaObject(meta);
  const raw =
    m.sameTargetStreak ??
    m.flowMeta?.sameTargetStreak ??
    m.extra?.sameTargetStreak ??
    m.extra?.flowMeta?.sameTargetStreak ??
    0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function getSameGoalStreak(meta: any): number {
  const m = getMetaObject(meta);
  const raw =
    m.sameGoalStreak ??
    m.flowMeta?.sameGoalStreak ??
    m.extra?.sameGoalStreak ??
    m.extra?.flowMeta?.sameGoalStreak ??
    0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function inferIntentionFormed(args: {
  userText: string;
  intent: PreSeedInputIntent;
  currentAxis: SritcfAxis | null;
  currentBand: FlowBand | null;
  previousDirective: any | null;
}): boolean {
  const c = compactText(args.userText);

  if (/意図|方向|核心|本質|結局|わかった|分かった|気づいた|私は/u.test(c)) {
    return true;
  }

  if (args.previousDirective?.intentionFormed === true) {
    return true;
  }

  if (args.previousDirective?.intentionConvergence?.intentionReached === true) {
    return true;
  }

  if (args.currentAxis === 'I' || args.currentBand === 'IT') {
    if (args.intent === 'explain_reason' || args.intent === 'clarify') return true;
  }

  return false;
}

function inferCreateSource(args: {
  userText: string;
  currentAxis: SritcfAxis | null;
  currentBand: FlowBand | null;
}): CreateSource {
  const c = compactText(args.userText);

  if (/不安|怖い|焦る|つらい|苦しい/u.test(c)) return 'S_emotion';
  if (/相手|あの人|彼|彼女|関係|嫌われ|返事|反応/u.test(c)) return 'R_relation';
  if (/意図|方向|自分で|私は|選ぶ|決める/u.test(c)) return 'I_intention';
  if (/気づき|核心|本質|反転|結局/u.test(c)) return 'T_insight';

  if (args.currentAxis === 'C' && args.currentBand === 'RC') return 'R_relation';

  return 'unknown';
}

function inferCreateIntegrity(args: {
  userText: string;
  createSource: CreateSource;
  intentionFormed: boolean;
}): {
  createIntegrity: CreateIntegrity;
  createDistortionRisk: 'none' | 'weak' | 'medium' | 'strong';
  distortionReason: PreSeedFlowDirective['distortionReason'];
} {
  const c = compactText(args.userText);

  if (/嫌われ|怒らせ|見捨て|合わせ|相手が望|相手のため|返事がないから/u.test(c)) {
    return {
      createIntegrity: 'distorted',
      createDistortionRisk: 'strong',
      distortionReason: 'approval_seeking',
    };
  }

  if (/相手の気持ち|本音|絶対|必ず|来ると思|好きですか|どう思って/u.test(c)) {
    return {
      createIntegrity: 'reactive',
      createDistortionRisk: 'medium',
      distortionReason: 'overreading_other',
    };
  }

  if (args.createSource === 'R_relation' && !args.intentionFormed) {
    return {
      createIntegrity: 'partially_aligned',
      createDistortionRisk: 'medium',
      distortionReason: 'relationship_pressure',
    };
  }

  if (args.createSource === 'S_emotion') {
    return {
      createIntegrity: args.intentionFormed ? 'partially_aligned' : 'reactive',
      createDistortionRisk: args.intentionFormed ? 'weak' : 'medium',
      distortionReason: args.intentionFormed ? null : 'fear_based',
    };
  }

  if (args.intentionFormed || args.createSource === 'I_intention' || args.createSource === 'T_insight') {
    return {
      createIntegrity: 'aligned',
      createDistortionRisk: 'none',
      distortionReason: null,
    };
  }

  return {
    createIntegrity: 'unknown',
    createDistortionRisk: 'weak',
    distortionReason: null,
  };
}

function buildWriterSeed(args: {
  shouldLimitDeepening: boolean;
  shouldUseCreate: boolean;
  shouldUseSmallAction: boolean;
  shouldHoldAction: boolean;
  intentionReached: boolean;
  createDistortionRisk: 'none' | 'weak' | 'medium' | 'strong';
  imageFirstCreate: boolean;
  wordCreate: boolean;
  actionCreate: boolean;
  flowAcceptance: boolean;
}): string | null {
  if (args.shouldHoldAction) {
    return 'このターンでは行動提案を急がず、関係圧や不安反応から出たCreateを小さくし、自分の方向を失っていないかを先に整える。';
  }

  if (args.flowAcceptance) {
    return 'ユーザーはすでに小さく動く方向を受け取っている。新しい課題や選択肢を増やさず、その動きが現実に流れ始めていることを短く支える。';
  }

  if (args.actionCreate) {
    return 'PRESEED_ACTION_CREATE_DIRECTIVE: このターンはAction Createである。A軸の形象固定文に戻さない。ユーザーが求めているのは、今日やること・次の一歩・小さな行動である。返答は、実行できる一歩を一つだけ具体的に出す。手順を増やしすぎない。文面だけで終わらない。「一手」という語は使わず、「一歩」に統一する。';
  }

  if (args.wordCreate) {
    return 'PRESEED_WORD_CREATE_DIRECTIVE: このターンはWord Createである。返信文・文面・一文を求めているため、A軸の形象固定文に戻さない。冒頭から使える短い言葉を出す。分析だけで終わらせず、送れる文または一文を提示する。';
  }

  if (args.imageFirstCreate) {
    return 'PRESEED_CREATE_DIRECTIVE: このターンのCreateは行動指示ではない。Imaginal Form（形象）を先に立てる。返信の冒頭を、文案・行動案・質問・選択肢から始めてはいけない。まず、ユーザーの内側に見える場面・姿・形を一つ置く。ユーザーに考えさせたり、ゼロから選ばせたりしない。形象を置いたあと、必要なら自然に出る小さな一歩だけを添える。';
  }

  if (args.intentionReached && args.shouldUseSmallAction) {
    return '意図に到達しているため、これ以上の相手分析・原因分析を増やさず、核心を短く言葉にして、小さなCreateまたは実行可能な一歩へ収束させる。';
  }

  if (args.intentionReached) {
    return '意図に到達しているため、深掘りを増やしすぎず、核心を短く言葉にして、扱える形へ収束させる。';
  }

  if (args.shouldUseCreate) {
    return '意味を増やしすぎず、ユーザーが扱える小さな言葉・選択肢・構造として仮置きする。';
  }

  if (args.shouldLimitDeepening) {
    return '直前まで十分に分析している可能性があるため、新しい分析を増やしすぎず、既に出た核心を使って短く整理する。';
  }

  return null;
}

export function buildPreSeedFlowDirective(
  args: BuildPreSeedFlowDirectiveArgs
): PreSeedFlowDirective {
  const userText = normalizeText(args.userText);
    const decision = args.preSeedDecision ?? args.decision;

  if (!decision) {
    const fallbackText = normalizeText(userText);

    const fallbackFlowAcceptance = isFlowAcceptanceText(fallbackText);
    const fallbackWordCreate = isWordCreateRequest(fallbackText);
    const fallbackActionCreate = !fallbackWordCreate && isActionCreateRequest(fallbackText);
    const fallbackImageFirstCreate = !fallbackWordCreate && !fallbackActionCreate && isImaginalFormCreateRequest(fallbackText);

    const fallbackInputIntent: PreSeedFlowDirective['inputIntent'] =
      fallbackFlowAcceptance
        ? 'continue'
        : fallbackWordCreate
          ? 'create'
          // ACTION_CREATE_FALLBACK_INPUT_INTENT_OVERRIDE_V3
          : fallbackActionCreate || fallbackImageFirstCreate || /行動|どうすれば|どうしたら|次|何を先に置けば|何を置けば|何を先に置く|何を置く|先に.*置けば|先に.*置くもの/.test(fallbackText)
            ? 'ask_action'
            : /なぜ|なんで|理由|どうして|結局|つまり|ということ|ってこと/.test(fallbackText)
              ? 'explain_reason'
              : /深め|もっと|詳しく|掘り下げ/.test(fallbackText)
                ? 'deepen'
                : /違う|修正|ちょっと違う|そうじゃない/.test(fallbackText)
                  ? 'correct'
                  : /続き|さっき|この話|前の/.test(fallbackText)
                    ? 'continue'
                    : 'unknown';

    const hasIntentionSignal =
      /結局|つまり|私は|自分|方向|意図|核心|本質|気づ|わかった|分かった|待ちすぎ|待ち過ぎ|手放|選ぶ|決める/.test(fallbackText);

    const hasRelationSignal =
      /相手|反応|関係|彼|彼女|みゆ|リナ|返事|返信|嫌われ|合わせ/.test(fallbackText);

    const hasEmotionSignal =
      /不安|怖い|つらい|苦しい|焦る|迷う|気になる|寂しい|悲しい|怒り/.test(fallbackText);

    const hasApprovalRisk =
      /嫌われ|怒らせ|見捨て|合わせ|相手が望|相手のため|返事がないから|反応がないから/.test(fallbackText);

    const fallbackCreateReady =
      fallbackInputIntent === 'create' || fallbackInputIntent === 'ask_action';

    const fallbackCurrentAxis: PreSeedFlowDirective['currentAxis'] =
      fallbackFlowAcceptance
        ? 'F'
        : fallbackCreateReady
          ? 'C'
          : hasIntentionSignal
          ? 'I'
          : hasRelationSignal
            ? 'R'
            : hasEmotionSignal
              ? 'S'
              : null;

    const fallbackCurrentBand: PreSeedFlowDirective['currentBand'] =
      fallbackCurrentAxis === 'C' || fallbackCurrentAxis === 'R'
        ? 'RC'
        : fallbackCurrentAxis === 'I'
          ? 'IT'
          : fallbackCurrentAxis === 'S'
            ? 'SF'
            : null;

    const fallbackCreateSource: PreSeedFlowDirective['createSource'] =
      fallbackCreateReady && hasRelationSignal
        ? 'R_relation'
        : fallbackCreateReady && hasEmotionSignal
          ? 'S_emotion'
          : hasIntentionSignal
            ? 'I_intention'
            : 'unknown';

    const fallbackCreateIntegrity: PreSeedFlowDirective['createIntegrity'] =
      fallbackCreateReady && hasApprovalRisk
        ? 'distorted'
        : fallbackCreateReady && hasRelationSignal && !hasIntentionSignal
          ? 'partially_aligned'
          : hasIntentionSignal
            ? 'aligned'
            : 'unknown';

    const fallbackCreateDistortionRisk: PreSeedFlowDirective['createDistortionRisk'] =
      hasApprovalRisk
        ? 'strong'
        : fallbackCreateReady && hasRelationSignal && !hasIntentionSignal
          ? 'medium'
          : fallbackCreateReady
            ? 'weak'
            : 'weak';

    const fallbackShouldHoldAction =
      fallbackCreateReady && (fallbackCreateDistortionRisk === 'strong' || fallbackCreateIntegrity === 'distorted');

    const fallbackShouldUseCreate =
      fallbackCreateReady && !fallbackShouldHoldAction;

    const fallbackShouldUseSmallAction =
      fallbackShouldUseCreate && !fallbackWordCreate && fallbackCreateDistortionRisk !== 'strong';

    const fallbackIntentionReached =
      hasIntentionSignal && !fallbackCreateReady;

    const fallbackShouldLimitDeepening =
      fallbackIntentionReached || fallbackCreateReady;

    const fallbackFlowDirection: PreSeedFlowDirective['flowDirection'] =
      fallbackFlowAcceptance
        ? 'let_flow_continue'
        : fallbackShouldHoldAction
          ? 'hold_before_create'
          : fallbackShouldUseCreate
            ? 'place_create'
            : fallbackIntentionReached
              ? 'converge_to_intention'
              : fallbackCurrentAxis === 'R'
                ? 'relate_context'
                : fallbackCurrentAxis === 'S'
                  ? 'continue_observation'
                  : 'return_to_input';

    const fallbackConvergenceMode: PreSeedFlowDirective['convergenceMode'] =
      fallbackFlowAcceptance
        ? 'toward_flow'
        : fallbackShouldUseSmallAction
          ? 'toward_small_action'
          : fallbackShouldUseCreate
            ? 'toward_create'
            : fallbackIntentionReached
              ? 'toward_intention'
              : 'none';

    const fallbackWriterSeed =
      fallbackShouldHoldAction
        ? 'ユーザー入力だけではCreateの由来に関係圧や不安反応が混じる可能性があるため、行動提案を急がず、自分の方向を失っていないかを先に整える。'
        : fallbackFlowAcceptance
          ? 'ユーザーはすでに小さく動く方向を受け取っている。新しい課題や選択肢を増やさず、その動きが現実に流れ始めていることを短く支える。'
          : fallbackActionCreate
            ? 'PRESEED_ACTION_CREATE_DIRECTIVE: このCreateはAction Createである。形象固定文に戻さず、今日やること・次の一歩・小さな行動を一つだけ具体的に出す。「一手」という語は使わず、「一歩」に統一する。'
            : fallbackWordCreate
              ? 'PRESEED_WORD_CREATE_DIRECTIVE: このCreateはWord Createである。返信文・文面・一文を求めているため、形象固定文に戻さない。冒頭から使える短い言葉を出す。'
              : fallbackImageFirstCreate
              ? 'PRESEED_CREATE_DIRECTIVE: このCreateは行動指示ではない。Imaginal Form（形象）を先に立てる。返信の冒頭を、文案・行動案・質問・選択肢から始めてはいけない。まず本人の内側に見える場面・姿・形を一つ置く。本人に考えさせたり選ばせたりしない。形象を置いたあと、必要なら自然に出る小さな一歩だけを添える。'
              : fallbackShouldUseSmallAction
              ? 'ユーザーは言葉や行動の形を求めているため、大きな結論にせず、先に形象を置き、そこから小さく実行できる一歩へ収束させる。'
              : fallbackIntentionReached
                ? 'ユーザー入力だけでも意図の輪郭が出ているため、これ以上の相手分析・原因分析を増やさず、核心を短く言葉にして収束させる。'
                : null;

    return {
      source: 'preseed_input_flow',
      inputIntent: fallbackInputIntent,
      currentAxis: fallbackCurrentAxis,
      currentBand: fallbackCurrentBand,
      flowDirection: fallbackFlowDirection,
      convergenceMode: fallbackConvergenceMode,
      shouldDeepen: false,
      shouldLimitDeepening: fallbackShouldLimitDeepening,
      shouldUseCreate: fallbackShouldUseCreate,
      shouldUseSmallAction: fallbackShouldUseSmallAction,
      shouldHoldAction: fallbackShouldHoldAction,
      intentionFormed: hasIntentionSignal,
      tInsightReady: fallbackIntentionReached,
      intentionConvergence: {
        intentionReached: fallbackIntentionReached,
        shouldStopAnalysis: fallbackIntentionReached,
        shouldNameCore: fallbackIntentionReached,
        shouldPlaceCreate: fallbackShouldUseCreate,
        shouldMoveToSmallAction: fallbackShouldUseSmallAction,
        shouldLetFlowContinue: fallbackShouldUseSmallAction,
      },
      createReady: fallbackCreateReady,
      createSource: fallbackCreateSource,
      createIntegrity: fallbackCreateIntegrity,
      createDistortionRisk: fallbackCreateDistortionRisk,
      distortionReason: hasApprovalRisk ? 'approval_seeking' : null,
      createDirective: buildCreateDirective({
        imageFirstCreate: fallbackImageFirstCreate,
        wordCreate: fallbackWordCreate,
        actionCreate: fallbackActionCreate,
        flowAcceptance: fallbackFlowAcceptance,
        shouldUseCreate: fallbackShouldUseCreate,
        shouldUseSmallAction: fallbackShouldUseSmallAction,
      }),
      seedDirection: {
        targetLabel: null,
        targetType: null,
        flowSeed: fallbackFlowDirection,
        writerSeed: fallbackWriterSeed,
        avoidSeed: [
          '対象が未確定のため、相手の心を断定しない',
          fallbackShouldLimitDeepening ? '意図の輪郭が出ているため、分析を増やしすぎない' : null,
          fallbackShouldHoldAction ? '関係圧から出たCreateをそのまま行動化しない' : null,
        ].filter(Boolean) as string[],
      },
      writerGuidance: {
        mustKeepTarget: false,
        mustNotOverDeepen: fallbackShouldLimitDeepening,
        shouldShiftFromAnalysisToPlacement: fallbackIntentionReached || fallbackShouldUseCreate,
        shouldOfferSmallCreate: fallbackShouldUseSmallAction || fallbackShouldUseCreate,
        shouldAvoidOtherMindAssertion: true,
        shouldAvoidLargeAction: true,
        shouldLeaveOpenSpace: true,
        shouldUseImaginalForm: fallbackImageFirstCreate || (fallbackShouldUseCreate && !fallbackWordCreate && !fallbackActionCreate),
        shouldAvoidHomework: true,
        shouldAvoidTooManyOptions: true,
      },
      evidence: {
        fromUserInput: [
          'decision=null',
          hasIntentionSignal ? 'fallback:intention_signal' : null,
          hasRelationSignal ? 'fallback:relation_signal' : null,
          fallbackCreateReady ? 'fallback:create_request' : null,
        ].filter(Boolean) as string[],
        fromFlowMeta: [],
        fromHistory: [],
      },
    };
  }
  const previousDirective = readPreviousDirective(args.meta);

  const inputIntent = inferInputIntent(userText, decision);
  const { currentAxis, currentBand } = inferAxisAndBand({
    userText,
    intent: inputIntent,
    decision,
  });

  const sameTargetStreak = getSameTargetStreak(args.meta);
  const sameGoalStreak = getSameGoalStreak(args.meta);
  const shortInput = userText.length > 0 && userText.length <= 24;

  const intentionFormed = inferIntentionFormed({
    userText,
    intent: inputIntent,
    currentAxis,
    currentBand,
    previousDirective,
  });

  const tInsightReady =
    intentionFormed &&
    currentBand === 'IT' &&
    inputIntent !== 'create' &&
    inputIntent !== 'ask_action';

  const flowAcceptance = isFlowAcceptanceText(userText);
  const wordCreate = isWordCreateRequest(userText);
  const actionCreate = !wordCreate && isActionCreateRequest(userText);
  const imageFirstCreate = !wordCreate && !actionCreate && isImaginalFormCreateRequest(userText);

  const createReady =
    inputIntent === 'create' ||
    inputIntent === 'ask_action' ||
    /どう返|なんて送|何て送|文面|言葉にして|どうすれば|どうしたら|何を先に置けば|何を置けば|何を先に置く|何を置く|先に.*置けば|先に.*置くもの/u.test(userText);

  const createSource = inferCreateSource({
    userText,
    currentAxis,
    currentBand,
  });

  const { createIntegrity, createDistortionRisk, distortionReason } = inferCreateIntegrity({
    userText,
    createSource,
    intentionFormed,
  });

  const shouldLimitDeepening =
    intentionFormed ||
    sameTargetStreak >= 3 ||
    sameGoalStreak >= 3 ||
    (shortInput && (inputIntent === 'deepen' || inputIntent === 'continue')) ||
    createReady;

  const shouldDeepen =
    !shouldLimitDeepening &&
    (inputIntent === 'deepen' ||
      inputIntent === 'explain_reason' ||
      inputIntent === 'continue');

  const shouldHoldAction =
    createReady &&
    (createDistortionRisk === 'medium' || createDistortionRisk === 'strong') &&
    createIntegrity !== 'aligned';

  const shouldUseCreate =
    createReady &&
    !shouldHoldAction &&
    (createIntegrity === 'aligned' || createIntegrity === 'partially_aligned');

  const shouldUseSmallAction =
    shouldUseCreate &&
    !wordCreate &&
    (createDistortionRisk === 'none' || createDistortionRisk === 'weak');

  let flowDirection: PreSeedFlowDirection = 'continue_observation';

  if (inputIntent === 'correct') {
    flowDirection = 'correct_angle';
  } else if (flowAcceptance || currentAxis === 'F') {
    flowDirection = 'let_flow_continue';
  } else if (shouldHoldAction) {
    flowDirection = 'hold_before_create';
  } else if (shouldUseCreate) {
    flowDirection = 'place_create';
  } else if (intentionFormed) {
    flowDirection = 'converge_to_intention';
  } else if (currentAxis === 'R') {
    flowDirection = 'relate_context';
  } else if (currentAxis === 'I') {
    flowDirection = 'name_intention';
  } else if (inputIntent === 'clarify') {
    flowDirection = 'return_to_input';
  }

  const convergenceMode =
    flowDirection === 'let_flow_continue' ? 'toward_flow' :
    shouldUseSmallAction ? 'toward_small_action' :
    shouldUseCreate ? 'toward_create' :
    intentionFormed ? 'toward_intention' :
    'none';

  const intentionReached = intentionFormed && shouldLimitDeepening;

  const writerSeed = buildWriterSeed({
    shouldLimitDeepening,
    shouldUseCreate,
    shouldUseSmallAction,
    shouldHoldAction,
    intentionReached,
    createDistortionRisk,
    imageFirstCreate,
    wordCreate,
    actionCreate,
    flowAcceptance,
  });

  const avoidSeed: string[] = [];

  if (shouldLimitDeepening) avoidSeed.push('相手分析・原因分析を増やしすぎない');
  if (shouldHoldAction) avoidSeed.push('関係圧や不安反応から大きな行動へ進めない');
  avoidSeed.push('相手の本心を断定しない');
  avoidSeed.push('大きな行動提案にしない');

  const targetLabel =
    String(
      decision.ctxPackPatch?.memoryTargetLabel ??
        decision.ctxPackPatch?.targetLabel ??
        decision.metaPatch?.targetLabel ??
        decision.sourceKind ??
        ''
    ).trim() || null;

  const targetType =
    String(
      decision.ctxPackPatch?.memorySpace ??
        decision.ctxPackPatch?.targetType ??
        decision.metaPatch?.targetType ??
        decision.kind ??
        ''
    ).trim() || null;

  return {
    source: 'preseed_input_flow',
    inputIntent,
    currentAxis,
    currentBand,
    flowDirection,
    convergenceMode,
    shouldDeepen,
    shouldLimitDeepening,
    shouldUseCreate,
    shouldUseSmallAction,
    shouldHoldAction,
    intentionFormed,
    tInsightReady,
    intentionConvergence: {
      intentionReached,
      shouldStopAnalysis: intentionReached || shouldLimitDeepening,
      shouldNameCore: intentionReached || flowDirection === 'name_intention',
      shouldPlaceCreate: shouldUseCreate,
      shouldMoveToSmallAction: shouldUseSmallAction,
      shouldLetFlowContinue: flowDirection === 'let_flow_continue',
    },
    createReady,
    createSource,
    createIntegrity,
    createDistortionRisk,
    distortionReason,
    createDirective: buildCreateDirective({
      imageFirstCreate,
      wordCreate,
      actionCreate,
      flowAcceptance,
      shouldUseCreate,
      shouldUseSmallAction,
    }),
    seedDirection: {
      targetLabel,
      targetType,
      flowSeed: flowDirection,
      writerSeed,
      avoidSeed,
    },
    writerGuidance: {
      mustKeepTarget: Boolean(targetLabel || targetType),
      mustNotOverDeepen: shouldLimitDeepening,
      shouldShiftFromAnalysisToPlacement: shouldLimitDeepening || shouldUseCreate,
      shouldOfferSmallCreate: shouldUseSmallAction || shouldUseCreate,
      shouldAvoidOtherMindAssertion: true,
      shouldAvoidLargeAction: true,
      shouldLeaveOpenSpace: convergenceMode === 'toward_flow' || shouldUseSmallAction,
      shouldUseImaginalForm: imageFirstCreate || (shouldUseCreate && !wordCreate && !actionCreate),
      shouldAvoidHomework: true,
      shouldAvoidTooManyOptions: true,
    },
    evidence: {
      fromUserInput: [
        `inputIntent=${inputIntent}`,
        currentAxis ? `currentAxis=${currentAxis}` : 'currentAxis=null',
        currentBand ? `currentBand=${currentBand}` : 'currentBand=null',
      ],
      fromFlowMeta: [
        `sameTargetStreak=${sameTargetStreak}`,
        `sameGoalStreak=${sameGoalStreak}`,
        previousDirective?.flowDirection ? `previousFlowDirection=${previousDirective.flowDirection}` : 'previousFlowDirection=null',
      ],
      fromHistory: [],
    },
  };
}

























