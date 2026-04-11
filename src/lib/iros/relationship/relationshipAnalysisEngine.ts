// src/lib/iros/relationship/relationshipAnalysisEngine.ts

import type {
  RelationshipAnalysis,
  RelationshipAnalysisDomain,
  RelationshipAnalysisInput,
  RelationshipAnalysisPairType,
  RelationshipAnalysisTrait,
} from './schemas/relationshipAnalysisSchema';
import { toMemoryDerived } from './schemas/relationshipAnalysisSchema';

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function pickFirst(values: Array<string | null | undefined>, fallback: string): string {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return fallback;
}

function inferDomain(userText: string): RelationshipAnalysisDomain {
  const text = normalizeText(userText);

  if (/恋愛|好き|彼|彼女|結婚|夫婦|復縁|片想い/u.test(text)) {
    return 'romance';
  }

  if (/相性|組み合わせ/u.test(text)) {
    return 'compatibility';
  }

  return 'relationship';
}

function inferPairType(userText: string): RelationshipAnalysisPairType {
  const text = normalizeText(userText);

  if (/座|星座/u.test(text)) return 'star_sign';
  if (/土星|九星|一白|二黒|三碧|四緑|五黄|六白|七赤|八白|九紫/u.test(text)) return 'kyusei';
  if (/相性|タイプ|性格/u.test(text)) return 'type_type';

  return 'other';
}

function buildTraitA(input: RelationshipAnalysisInput): RelationshipAnalysisTrait {
  const memory = input.relationshipMemory;
  const facts = Array.isArray(memory?.facts) ? memory?.facts : [];
  const patterns = Array.isArray(memory?.patterns) ? memory?.patterns : [];

  return {
    coreDrive: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'core_drive')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'core_drive')?.note,
      ],
      '自分のやり方を保ちながら前に進めたい'
    ),
    movement: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'movement_a')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'movement_a')?.note,
      ],
      '先に動いて流れを取りに行きやすい'
    ),
    sensitivity: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'sensitivity_a')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'sensitivity_a')?.note,
      ],
      '主導権の揺れや押し返しに反応しやすい'
    ),
    strength: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'strength_a')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'strength_a')?.note,
      ],
      '前に進める力が強い'
    ),
  };
}

function buildTraitB(input: RelationshipAnalysisInput): RelationshipAnalysisTrait {
  const memory = input.relationshipMemory;
  const facts = Array.isArray(memory?.facts) ? memory?.facts : [];
  const patterns = Array.isArray(memory?.patterns) ? memory?.patterns : [];

  return {
    coreDrive: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'core_drive_b')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'core_drive_b')?.note,
      ],
      '自分の基準を崩さずに関係を保ちたい'
    ),
    movement: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'movement_b')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'movement_b')?.note,
      ],
      '引くより先に立て直そうとして強く出やすい'
    ),
    sensitivity: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'sensitivity_b')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'sensitivity_b')?.note,
      ],
      '譲らされる感じや軽く扱われる感じに反応しやすい'
    ),
    strength: pickFirst(
      [
        facts.find((fact) => normalizeText(fact?.key) === 'strength_b')?.value,
        patterns.find((pattern) => normalizeText(pattern?.key) === 'strength_b')?.note,
      ],
      '場を持ち直す粘りがある'
    ),
  };
}

function buildMemorySummary(input: RelationshipAnalysisInput): string[] | null {
  const derived = toMemoryDerived(input.relationshipMemory);
  if (!derived) return null;

  const summary = [
    ...(derived.relationPatterns ?? []),
    ...(derived.pressureTriggers ?? []),
    ...(derived.unresolvedTopics ?? []),
  ]
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0)
    .slice(0, 5);

  return summary.length > 0 ? summary : null;
}

export function buildRelationshipAnalysis(
  input: RelationshipAnalysisInput
): RelationshipAnalysis {
  const userText = normalizeText(input.userText);
  const memory = input.relationshipMemory ?? null;
  const memoryDerived = toMemoryDerived(memory);

  const domain = input.domain ?? inferDomain(userText);
  const pairType = input.pairType ?? inferPairType(userText);

  const traitA = buildTraitA(input);
  const traitB = buildTraitB(input);

  const isKyusei = pairType === 'kyusei';
  const isSameTypePair =
    /どうし|同士|同じ|おなじ/u.test(userText) ||
    (/五黄土星/u.test(userText) && !/一白|二黒|三碧|四緑|六白|七赤|八白|九紫/u.test(userText));

  const pressureTrigger = pickFirst(
    [memoryDerived?.pressureTriggers?.[0]],
    isSameTypePair
      ? '相手も同じ強さで返してくる感じ'
      : '相手が強く出てくる感じ'
  );

  const reactionPattern = pickFirst(
    [memoryDerived?.reactionPatterns?.[0]],
    isSameTypePair
      ? '譲れないまま押し返したくなる流れ'
      : '引けないまま防御が強くなる流れ'
  );

  const unresolvedTopic = pickFirst(
    [memoryDerived?.unresolvedTopics?.[0]],
    isSameTypePair
      ? '主導権と進め方の取り合いになりやすいこと'
      : '力の置き場が重なりやすいこと'
  );

  const relationPattern = pickFirst(
    [memoryDerived?.relationPatterns?.[0]],
    isSameTypePair
      ? '同じ強さを同じ場所で出しやすい'
      : '近づき方の違いがそのままズレになりやすい'
  );

  const coreTension = pickFirst(
    [relationPattern],
    isSameTypePair
      ? '同じ強さを同じ場所で出しやすい'
      : '強さの出しどころがぶつかりやすい'
  );

  const openingFrame = isSameTypePair
    ? '五黄土星どうしは、力が強く出やすい関係です。'
    : `${coreTension}関係です。`;

  const clashPoint = isSameTypePair
    ? '主導権や進め方を同じ土俵で握ろうとして、押し合いになりやすい'
    : pickFirst(
        [unresolvedTopic],
        '互いに譲るより先に動こうとして、正しさの押し合いになりやすい'
      );

  const misreadAtoB = isSameTypePair
    ? '相手が押してくるというより、自分のやり方を通しにきているように見えやすい'
    : pickFirst([pressureTrigger], '相手が強く押してくるように見えやすい');

  const misreadBtoA = isSameTypePair
    ? '相手が受け止めていないというより、こちらの強さに同じ強さで返してきているように見えやすい'
    : pickFirst([reactionPattern], '相手が引かずに重く出てくるように見えやすい');

  const hiddenCause = isSameTypePair
    ? '未熟さではなく、どちらも自分で流れを動かせるぶん、同じ場所で強さが重なりやすいことです。'
    : '未熟さではなく、守りたい基準と動くタイミングが重なりやすいことです。';

    const reframeAtoB = isSameTypePair
    ? '相手の押しの強さは、支配したいというより、自分で流れを動かしたい力として読むと変わります。'
    : '強く見える反応は、関係を立て直そうとする力として読むと変わります。';

  const reframeBtoA = isSameTypePair
    ? '相手の譲らなさは、対立したいというより、自分の基準で場を崩したくない力として読むと変わります。'
    : '押して見える反応は、流れを止めずに前へ運びたい力として読むと変わります。';

  const translation = {
    seenAtoB: misreadAtoB,
    seenBtoA: misreadBtoA,
    intentA: isSameTypePair
      ? '自分で流れを動かしたいまま前に出ている'
      : '自分の基準で進めながら関係を崩したくない',
    intentB: isSameTypePair
      ? '自分の基準で場を崩さずに持ちこたえようとしている'
      : '筋や形を守りながら見誤りたくない',
    translationKey: isSameTypePair
      ? '押してくる相手ではなく、動かしたい相手として読むことです。'
      : '圧や否定に見える反応を、守ろうとしている基準の違いとして読むことです。',
  };

  const bridgeKey = isSameTypePair
    ? '相手を止めるより先に、どこを任せてどこを自分が持つかを分けることです。'
    : '相手を弱いか強いかで見るより、どこで力を使っているかを分けて見ることです。';

  const roleA = isSameTypePair
    ? '一方が前へ押し出す力を持つことで、関係に推進力を入れます。'
    : `${traitA.strength}ことで、関係に推進力を入れます。`;

  const roleB = isSameTypePair
    ? 'もう一方が場を整える側へ回ることで、関係に安定を入れます。'
    : `${traitB.strength}ことで、関係に持続力を入れます。`;

  const synergy = isSameTypePair
    ? '同じ強さを競わせず、押す場と整える場を分けると、一気にまとまりやすくなります。'
    : '力の置き場が分かれると、押し合いではなく前へ進む力としてまとまりやすくなります。';

  const essenceClose = isSameTypePair
    ? 'この関係は、強さを競わせるより、役割と決定権を分けたときにいちばん活きます。'
    : 'この関係は、強さを競わせるより、強さの向きを分けたときにいちばん活きます。';

  return {
    domain,
    pairType,

    memoryUsed: Boolean(memory),
    memoryConfidence: typeof memory?.confidence === 'number' ? memory.confidence : null,
    memorySummary: buildMemorySummary(input),

    coreTension,
    openingFrame,

    traitA,
    traitB,

    friction: {
      clashPoint,
      misreadAtoB,
      misreadBtoA,
      hiddenCause,
    },

    translation,

    reinterpretation: {
      reframeAtoB,
      reframeBtoA,
      bridgeKey,
    },

    roleFit: {
      roleA,
      roleB,
      synergy,
    },

    essenceClose,

    memoryDerived,
  };
}
