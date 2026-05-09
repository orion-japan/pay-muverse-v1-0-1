// src/lib/iros/conversation/focusResolution.ts
// iros — Focus & Resolution Director
//
// 目的:
// - 既存の goalKind / flow / ctxPack では決めきれていない
//   「今回どこを見るか」「どう着地させるか」を writer 前に確定する。
// - 本文は生成しない。writer に渡す方針だけを作る。
// - まずは副作用を抑えるため、恋愛・人間関係の連絡不安系だけを明示的に扱う。

export type FocusResolutionDomain =
  | 'relationship_contact_anxiety'
  | 'general';

export type FocusResolutionOutputShape =
  | 'simple_practical_resonance'
  | 'default';

export type FocusResolutionDecision = {
  enabled: boolean;
  domain: FocusResolutionDomain;
  reason: string;

  focus: string | null;
  resolution: string | null;
  nextAction: string | null;
  avoid: string[];
  outputShape: FocusResolutionOutputShape;

  writerHintLines: string[];
};

export type ResolveFocusResolutionInput = {
  userText?: string | null;
  conversationLine?: unknown;
  situationSummary?: unknown;
  situationTopic?: unknown;
  goalKind?: unknown;
  flowDelta?: unknown;
  returnStreak?: unknown;
};

function norm(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lower(value: unknown): string {
  return norm(value).toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function asJoined(input: ResolveFocusResolutionInput): string {
  return [
    input.userText,
    input.conversationLine,
    input.situationSummary,
    input.situationTopic,
    input.goalKind,
  ]
    .map(norm)
    .filter(Boolean)
    .join(' / ');
}

const RELATIONSHIP_PATTERNS: RegExp[] = [
  /彼/,
  /彼氏/,
  /彼女/,
  /好きな人/,
  /相手/,
  /恋愛/,
  /関係/,
  /LINE/i,
  /ライン/,
  /連絡/,
  /返事/,
  /返信/,
  /既読/,
  /未読/,
];

const CONTACT_ANXIETY_PATTERNS: RegExp[] = [
  /連絡.*(来ない|こない|ない|ありません)/,
  /返事.*(来ない|こない|ない|ありません)/,
  /返信.*(来ない|こない|ない|ありません)/,
  /既読.*(つかない|付かない|ならない)/,
  /未読/,
  /待てない/,
  /待つ.*できない/,
  /不安/,
  /追いかけ/,
  /追って/,
  /諦めきれない/,
  /あきらめきれない/,
  /逆になりそう/,
  /うまく行く/,
  /うまくいく/,
  /どうしますか/,
  /どうしたら/,
];

function isRelationshipContactAnxiety(joined: string): boolean {
  const text = joined;
  const hasRelationship = hasAny(text, RELATIONSHIP_PATTERNS);
  const hasContactAnxiety = hasAny(text, CONTACT_ANXIETY_PATTERNS);

  return hasRelationship && hasContactAnxiety;
}

function buildRelationshipContactAnxietyDecision(
  input: ResolveFocusResolutionInput,
  joined: string,
): FocusResolutionDecision {
  const userText = norm(input.userText);

  const asksSmooth =
    /スムーズ|即|すぐ|早く|うまく行く|うまくいく/.test(userText);

  const mayChase =
    /追いかけ|追って|待てない|諦めきれない|あきらめきれない|逆になりそう/.test(
      userText,
    );

  const focus = mayChase
    ? '連絡が来ない事実そのものではなく、不安を止めたくて追いかけそうになっている状態を見る'
    : '相手の反応を断定せず、連絡が来ない時間で自分の価値まで揺れそうになっている状態を見る';

  const resolution = asksSmooth || mayChase
    ? '関係を一気に動かそうとせず、送るなら一文だけに絞り、それ以上は追わない'
    : '相手を動かす説明ではなく、自分を崩さない短い一手に絞る';

  const nextAction = asksSmooth || mayChase
    ? '送るなら短い一文だけを出す。長文・連投・確認の追撃はしない'
    : 'まず一文だけで気持ちか要望を伝える。返答がなければ追撃ではなく待つ線を決める';

  const avoid = [
    '彼の本音を断定しない',
    '長文を勧めない',
    '連投を勧めない',
    '責める言い方を勧めない',
    '場・位置・反転・線などの構造語だけで説明しない',
    '抽象的な共鳴語だけで終わらない',
    '質問で終わらない',
  ];

  const writerHintLines = [
    'FOCUS_RESOLUTION_V1 (DO NOT OUTPUT)',
    'domain=relationship_contact_anxiety',
    `focus=${focus}`,
    `resolution=${resolution}`,
    `nextAction=${nextAction}`,
    'outputShape=simple_practical_resonance',
    'mustStart=まず結論を短く出す',
    'mustInclude=気持ちの受け止め / 苦しさの正体 / 今やること1つ / 必要ならそのまま送れる一文 / やらない方がいいこと',
    'style=深く読むが、普通の言葉に翻訳する。難しい比喩で逃げない',
    `avoid=${avoid.join(' / ')}`,
    `sourceHead=${joined.slice(0, 180)}`,
  ];

  return {
    enabled: true,
    domain: 'relationship_contact_anxiety',
    reason: 'matched_relationship_contact_anxiety',
    focus,
    resolution,
    nextAction,
    avoid,
    outputShape: 'simple_practical_resonance',
    writerHintLines,
  };
}

export function resolveFocusResolution(
  input: ResolveFocusResolutionInput,
): FocusResolutionDecision {
  const joined = asJoined(input);

  if (isRelationshipContactAnxiety(joined)) {
    return buildRelationshipContactAnxietyDecision(input, joined);
  }

  return {
    enabled: false,
    domain: 'general',
    reason: 'no_focus_resolution_match',
    focus: null,
    resolution: null,
    nextAction: null,
    avoid: [],
    outputShape: 'default',
    writerHintLines: [],
  };
}
