type CaptureArgs = {
  supabase: any;
  userCode: string;
  conversationId: string;
  userText: string;
  traceId?: string | null;
};

type FactField =
  | 'age'
  | 'children'
  | 'partner'
  | 'family_members'
  | 'role'
  | 'trait'
  | 'relationship_general';

type FactStatus = 'confirmed_by_user' | 'needs_confirmation';

type FactConfidence = 'high' | 'low';

type TargetResolution = {
  targetLabel: string | null;
  source: string | null;
  confidence: FactConfidence;
};

type ExtractedFact = {
  field: FactField;
  valueText: string;
  valueNumber: number | null;
  valueNormalized: string;
  sensitivity:
    | 'age'
    | 'family_structure'
    | 'role_context'
    | 'psychological_context'
    | 'relationship_context';
  note: string;
  detailLines?: string[];
  childGender?: 'son' | 'daughter' | 'child' | null;
  childName?: string | null;
};

type CaptureResult = {
  captured: boolean;
  shouldAskConfirmation?: boolean;
  targetLabel?: string | null;
  targetSource?: string | null;
  field?: FactField;
  status?: FactStatus;
  confidence?: FactConfidence;
  sensitivity?: string;
  source?: 'conversation';
  valueText?: string;
  valueNumber?: number | null;
  valueNormalized?: string | null;
  directReply?: string;
  reason?: string;
};

const PROJECT_LIKE_RE =
  /(Muverse|Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|Git|Next\.js|route\.ts|コード|PowerShell|typecheck|npm|実装|修正|エラー|ビルド|デプロイ|パッチ)/iu;

const PERSON_SUFFIX_RE = /(さん|先生|様|くん|ちゃん|氏)$/u;

const TARGET_TRAILING_RE =
  /(の診断結果|の診断内容|の診断|の情報|のこと|の状態|の現在地|の文脈|のメモ|のプロフィール|の話|の要点|の流れ|の背景|の件|との関係|について)$/u;

const GENERIC_NON_PERSON_LABELS = new Set([
  'お子',
  'お子さん',
  '子供',
  '子ども',
  'こども',
  '息子',
  '息子さん',
  '娘',
  '娘さん',
  '長男',
  '長女',
  '次男',
  '次女',
  '家族',
  '家族構成',
  '母',
  '母親',
  'お母さん',
  '父',
  '父親',
  'お父さん',
  '兄',
  'お兄さん',
  '姉',
  'お姉さん',
  '弟',
  '妹',
  '夫',
  '妻',
  '旦那',
  '旦那さん',
  '奥さん',
  '彼',
  '彼女',
  '相手',
  '相談者',
  '友人',
  '恋人',
  '元恋人',
  '先生',
  'クライアント',
  'スタッフ',
  '弟子',
]);

function isGenericNonPersonLabel(v: unknown): boolean {
  const s = String(v ?? '').trim().replace(/[ \t\r\n　]/g, '');
  return GENERIC_NON_PERSON_LABELS.has(s);
}

function isQuestionLike(text: string): boolean {
  return /[?？]|(いますか|いるの|いる？|います？|ありますか|ある？|何人|何歳|だっけ|でしたっけ|ですか|でしょうか|かな|どう思|見て|占って|診断して)/u.test(text);
}

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function normalizePersonLabel(v: unknown): string | null {
  let s = norm(v)
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  s = s.replace(TARGET_TRAILING_RE, '');
  s = s.replace(PERSON_SUFFIX_RE, '');

  if (!s) return null;
  if (isGenericNonPersonLabel(s)) return null;

  return s;
}

function displayName(label: string): string {
  return label;
}

function extractPersonLabelFromText(text: string): string | null {
  const s = norm(text);
  if (!s) return null;

  const patterns = [
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)(?:には|は|の|って|と|に|を|$)/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:には|は|の)(?:何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ|子供|子ども|お子さん|息子|娘|家族構成|夫|妻|旦那|奥さん|独身|離婚|職業|仕事|先生|クライアント|スタッフ|弟子|経営者|性格|慎重|場面緘黙|感受性|友人|恋人|元恋人|仕事関係|家族)/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})の件/u,
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (!m?.[1]) continue;
    const label = normalizePersonLabel(m[1]);
    if (label && !isGenericNonPersonLabel(label)) return label;
  }

  return null;
}

function normalizeCount(raw: string | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  if (/^[0-9０-９]+$/u.test(s)) {
    const half = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    const n = Number(half);
    return Number.isFinite(n) ? n : null;
  }

  const map: Record<string, number> = {
    一: 1,
    ひと: 1,
    二: 2,
    ふた: 2,
    三: 3,
    四: 4,
    五: 5,
  };

  return map[s] ?? null;
}

function extractAgeFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  const m = s.match(/(\d{1,3})\s*歳/u);
  if (!m?.[1]) return null;

  const age = Number(m[1]);
  if (!Number.isFinite(age) || age <= 0 || age > 120) return null;

  return {
    field: 'age',
    valueText: `${age}歳`,
    valueNumber: age,
    valueNormalized: String(age),
    sensitivity: 'age',
    note: s,
    detailLines: [`age.value=${age}`],
  };
}

function normalizeChildNameForDisplay(v: string | null | undefined): string | null {
  let s = norm(v);
  if (!s) return null;

  s = s
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  s = s.replace(/(です|でした|だよ|だ)$/u, '');
  s = s.replace(/(さん|くん|ちゃん|君|様)$/u, '');

  return s || null;
}

function extractChildName(userText: string): string | null {
  const s = norm(userText);

  const afterComma = s.match(/[、,]\s*([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{2,20})(?:くん|君|ちゃん|さん)?\s*$/u);
  if (afterComma?.[1]) return afterComma[1].trim();

  const named = s.match(/(?:名前は|息子さんは|娘さんは|お名前は)\s*([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{2,20})(?:くん|君|ちゃん|さん)?/u);
  if (named?.[1]) return named[1].trim();

  return null;
}

function extractChildrenFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!s) return null;
  if (!/(子供|子ども|お子さん|息子|娘|長男|長女|次男|次女)/u.test(s)) return null;

  const noChildren = /(子供|子ども|お子さん).{0,8}(いない|いません|なし|ない)/u.test(s);
  if (noChildren) {
    return {
      field: 'children',
      valueText: '子供はいない',
      valueNumber: 0,
      valueNormalized: 'no_children',
      childGender: null,
      childName: null,
      sensitivity: 'family_structure',
      note: s,
      detailLines: ['children.normalized=no_children', 'children.count=0'],
    };
  }

  const hasChildren =
    /(子供|子ども|お子さん|息子|娘|長男|長女|次男|次女)/u.test(s) &&
    /(いる|います|がいる|がいます|一人|１人|1人|ひとり|息子|娘|長男|長女|次男|次女)/u.test(s);

  if (!hasChildren) return null;

  const countMatch =
    s.match(/([0-9０-９一二三四五]|ひと|ふた)\s*人/u) ??
    s.match(/([0-9０-９一二三四五])\s*(?:人)?(?:息子|娘|子供|子ども)/u);

  const count = normalizeCount(countMatch?.[1]) ?? (/一人|１人|1人|ひとり/u.test(s) ? 1 : null);

  const childGender =
    /(息子|長男|次男)/u.test(s)
      ? 'son'
      : /(娘|長女|次女)/u.test(s)
        ? 'daughter'
        : 'child';

  const childName = normalizeChildNameForDisplay(extractChildName(s));

  const parts: string[] = [];
  if (count != null) parts.push(`子供は${count}人`);
  else parts.push('子供がいる');

  if (childGender === 'son') parts.push('息子');
  if (childGender === 'daughter') parts.push('娘');
  if (childName) parts.push(`名前は${childName}くん`);

  const detailLines = [
    'children.normalized=has_children',
    count != null ? `children.count=${count}` : '',
    childGender ? `children.kind=${childGender}` : '',
    childName ? `children.name=${childName}` : '',
  ].filter(Boolean);

  return {
    field: 'children',
    valueText: parts.join('・'),
    valueNumber: count,
    valueNormalized: 'has_children',
    childGender,
    childName,
    sensitivity: 'family_structure',
    note: s,
    detailLines,
  };
}

function extractPartnerFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!/(夫|妻|旦那|旦那さん|奥さん|独身|結婚|離婚|再婚|配偶者|パートナー|彼氏|彼女)/u.test(s)) return null;

  const patterns: Array<[RegExp, string, string]> = [
    [/(夫|旦那|旦那さん).{0,8}(いる|います|がいる|がいます)/u, 'married_husband', '夫がいる'],
    [/(妻|奥さん).{0,8}(いる|います|がいる|がいます)/u, 'married_wife', '妻がいる'],
    [/(結婚している|結婚してます|既婚)/u, 'married', '結婚している'],
    [/(独身)/u, 'single', '独身'],
    [/(離婚している|離婚しています|離婚した|バツイチ)/u, 'divorced', '離婚している'],
    [/(再婚している|再婚しています|再婚した)/u, 'remarried', '再婚している'],
    [/(パートナー).{0,8}(いる|います|がいる|がいます)/u, 'has_partner', 'パートナーがいる'],
    [/(彼氏).{0,8}(いる|います|がいる|がいます)/u, 'has_boyfriend', '彼氏がいる'],
    [/(彼女).{0,8}(いる|います|がいる|がいます)/u, 'has_girlfriend', '彼女がいる'],
  ];

  for (const [re, normalized, text] of patterns) {
    if (!re.test(s)) continue;
    return {
      field: 'partner',
      valueText: text,
      valueNumber: null,
      valueNormalized: normalized,
      sensitivity: 'family_structure',
      note: s,
      detailLines: [`partner.normalized=${normalized}`],
    };
  }

  return null;
}

function extractFamilyMemberFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!/(母|母親|お母さん|父|父親|お父さん|兄|お兄さん|姉|お姉さん|弟|妹|兄弟|姉妹)/u.test(s)) return null;
  if (!/(いる|います|がいる|がいます|です|だよ|だった|家族|兄弟|姉妹)/u.test(s)) return null;

  const members: Array<[RegExp, string, string]> = [
    [/(母|母親|お母さん)/u, 'mother', '母'],
    [/(父|父親|お父さん)/u, 'father', '父'],
    [/(兄|お兄さん)/u, 'older_brother', '兄'],
    [/(姉|お姉さん)/u, 'older_sister', '姉'],
    [/(弟)/u, 'younger_brother', '弟'],
    [/(妹)/u, 'younger_sister', '妹'],
  ];

  const found = members.filter(([re]) => re.test(s));
  if (found.length === 0) return null;

  const normalized = found.map(([, key]) => key);
  const labels = found.map(([, , label]) => label);

  return {
    field: 'family_members',
    valueText: `${labels.join('・')}がいる`,
    valueNumber: null,
    valueNormalized: normalized.join(','),
    sensitivity: 'family_structure',
    note: s,
    detailLines: [
      `family.members=${normalized.join(',')}`,
      `family.member_labels=${labels.join(',')}`,
    ],
  };
}

function extractRoleFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!/(先生|クライアント|スタッフ|弟子|経営者|社長|カウンセラー|占い師|講師|生徒|上司|部下|同僚|仕事仲間)/u.test(s)) return null;

  const roles: Array<[RegExp, string, string]> = [
    [/(先生|講師)/u, 'teacher', '先生'],
    [/(クライアント|顧客)/u, 'client', 'クライアント'],
    [/(スタッフ)/u, 'staff', 'スタッフ'],
    [/(弟子)/u, 'disciple', '弟子'],
    [/(経営者|社長)/u, 'business_owner', '経営者'],
    [/(カウンセラー)/u, 'counselor', 'カウンセラー'],
    [/(占い師)/u, 'fortune_teller', '占い師'],
    [/(生徒)/u, 'student', '生徒'],
    [/(上司)/u, 'boss', '上司'],
    [/(部下)/u, 'subordinate', '部下'],
    [/(同僚|仕事仲間)/u, 'coworker', '同僚'],
  ];

  for (const [re, normalized, text] of roles) {
    if (!re.test(s)) continue;
    return {
      field: 'role',
      valueText: text,
      valueNumber: null,
      valueNormalized: normalized,
      sensitivity: 'role_context',
      note: s,
      detailLines: [`role.kind=${normalized}`],
    };
  }

  return null;
}

function extractTraitFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!/(慎重|話しにくい|場面緘黙|感受性が強い|感受性|繊細|警戒心|優しい|頑固|責任感|受け身|自分から話さない)/u.test(s)) return null;

  const traits: Array<[RegExp, string, string]> = [
    [/(場面緘黙)/u, 'selective_mutism', '場面緘黙'],
    [/(感受性が強い|感受性)/u, 'high_sensitivity', '感受性が強い'],
    [/(慎重)/u, 'careful', '慎重'],
    [/(話しにくい)/u, 'hard_to_talk', '話しにくい'],
    [/(繊細)/u, 'sensitive', '繊細'],
    [/(警戒心)/u, 'guarded', '警戒心が強い'],
    [/(優しい)/u, 'kind', '優しい'],
    [/(頑固)/u, 'stubborn', '頑固'],
    [/(責任感)/u, 'responsible', '責任感が強い'],
    [/(受け身|自分から話さない)/u, 'passive', '受け身'],
  ];

  for (const [re, normalized, text] of traits) {
    if (!re.test(s)) continue;
    return {
      field: 'trait',
      valueText: text,
      valueNumber: null,
      valueNormalized: normalized,
      sensitivity: 'psychological_context',
      note: s,
      detailLines: [`trait.kind=${normalized}`],
    };
  }

  return null;
}

function extractGeneralRelationshipFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!/(友人|友達|恋人|元恋人|元カレ|元カノ|仕事関係|家族|知人|師弟|同僚)/u.test(s)) return null;

  const relations: Array<[RegExp, string, string]> = [
    [/(友人|友達)/u, 'friend', '友人'],
    [/(元恋人|元カレ|元カノ)/u, 'ex_partner', '元恋人'],
    [/(恋人)/u, 'romantic_partner', '恋人'],
    [/(仕事関係)/u, 'work_relationship', '仕事関係'],
    [/(家族)/u, 'family', '家族'],
    [/(知人)/u, 'acquaintance', '知人'],
    [/(師弟)/u, 'teacher_student', '師弟関係'],
    [/(同僚)/u, 'coworker', '同僚'],
  ];

  for (const [re, normalized, text] of relations) {
    if (!re.test(s)) continue;
    return {
      field: 'relationship_general',
      valueText: text,
      valueNumber: null,
      valueNormalized: normalized,
      sensitivity: 'relationship_context',
      note: s,
      detailLines: [
        `relationship_general.kind=${normalized}`,
        'relationship_general.reuse_policy=allowed_for_non_private_person_context',
      ],
    };
  }

  return null;
}

function extractSupportedFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!s) return null;
  if (PROJECT_LIKE_RE.test(s)) return null;

  // Person Fact Capture は「ユーザーが補足した事実」を保存する層。
  // 質問文・相談文は保存しない。質問は Person Context Pre-SEED / 通常回答側で扱う。
  if (isQuestionLike(s)) return null;

  const age = extractAgeFact(s);
  if (
    age &&
    /(だよ|だった|だったよ|っていってた|って言ってた|と言ってた|いってた|言ってた|なった|この前の誕生日|誕生日で)/u.test(s)
  ) {
    return age;
  }

  return (
    extractChildrenFact(s) ??
    extractPartnerFact(s) ??
    extractFamilyMemberFact(s) ??
    extractRoleFact(s) ??
    extractTraitFact(s) ??
    extractGeneralRelationshipFact(s)
  );
}

function pickMessageText(row: any): string {
  return norm(row?.content ?? row?.text ?? row?.assistantText ?? row?.message ?? '');
}

function pickLabelFromMeta(meta: any): string | null {
  const candidates = [
    meta?.extra?.personFactCaptureTargetLabel,
    meta?.extra?.ctxPack?.preSeedDecision?.ctxPackPatch?.targetLabel,
    meta?.extra?.ctxPack?.preSeedDecision?.metaPatch?.targetLabel,
    meta?.extra?.preSeedDecision?.ctxPackPatch?.targetLabel,
    meta?.extra?.preSeedDecision?.metaPatch?.targetLabel,
    meta?.extra?.ctxPack?.targetLabel,
    meta?.extra?.personContextTargetLabel,
    meta?.ctxPack?.targetLabel,
    meta?.targetLabel,
    meta?.personContextTargetLabel,
  ];

  for (const c of candidates) {
    const label = normalizePersonLabel(c);
    if (label) return label;
  }

  return null;
}

async function loadRecentMessages(args: CaptureArgs): Promise<any[]> {
  const sb = args.supabase;
  if (!sb?.from || !args.conversationId) return [];

  const { data, error } = await sb
    .from('iros_messages')
    .select('id, role, content, text, meta, created_at')
    .eq('conversation_id', args.conversationId)
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) {
    console.warn('[IROS/PERSON_FACT_CAPTURE][RECENT_MESSAGES_FAILED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      message: error?.message ?? String(error),
    });
    return [];
  }

  return Array.isArray(data) ? data : [];
}

function resolveTargetFromRecentContext(args: {
  userText: string;
  recentMessages: any[];
}): TargetResolution {
  const current = extractPersonLabelFromText(args.userText);
  if (current) {
    return { targetLabel: current, source: 'current_user_text', confidence: 'high' };
  }

  const usableRows = args.recentMessages
    .filter((row) => {
      const txt = pickMessageText(row);
      return !(txt && txt === norm(args.userText));
    })
    .slice(0, 5);

  for (const row of usableRows) {
    const fromMeta = pickLabelFromMeta(row?.meta ?? null);
    if (fromMeta) {
      return {
        targetLabel: fromMeta,
        source: `recent_${row?.role ?? 'unknown'}_meta`,
        confidence: 'high',
      };
    }
  }

  const previousAssistant = usableRows.find((row) => row?.role === 'assistant');
  if (previousAssistant) {
    const fromAssistantText = extractPersonLabelFromText(pickMessageText(previousAssistant));
    if (fromAssistantText) {
      return {
        targetLabel: fromAssistantText,
        source: 'previous_assistant_text',
        confidence: 'high',
      };
    }
  }

  const previousUser = usableRows.find((row) => row?.role === 'user');
  if (previousUser) {
    const fromUserText = extractPersonLabelFromText(pickMessageText(previousUser));
    if (fromUserText) {
      return {
        targetLabel: fromUserText,
        source: 'previous_user_text',
        confidence: 'high',
      };
    }
  }

  return { targetLabel: null, source: null, confidence: 'low' };
}

function factTopicLabel(field: FactField): string {
  switch (field) {
    case 'age':
      return '年齢';
    case 'children':
    case 'partner':
    case 'family_members':
      return '家族構成';
    case 'role':
      return '職業・立場';
    case 'trait':
      return '性格・傾向';
    case 'relationship_general':
      return '関係性';
    default:
      return '人物情報';
  }
}

function buildGuidanceHint(args: {
  targetLabel: string;
  fact: ExtractedFact;
  previousGuidanceHint?: string | null;
}): string {
  const dn = displayName(args.targetLabel);
  const topic = factTopicLabel(args.fact.field);

  const lines = [
    `ユーザー確認済み事実：${dn}の${topic}について、${args.fact.valueText}。`,
    `status=confirmed_by_user / source=conversation / confidence=high / sensitivity=${args.fact.sensitivity}`,
    `field=${args.fact.field}`,
    `value.normalized=${args.fact.valueNormalized}`,
    ...(args.fact.detailLines ?? []),
    `心理的文脈：ユーザーが${dn}の${topic}を補足し、人物理解を具体的な生活背景・関係文脈まで広げている。`,
  ].filter(Boolean);

  const addition = lines.join('\n');
  const prev = norm(args.previousGuidanceHint);
  if (!prev) return addition;

  const duplicateNeedles = [
    `field=${args.fact.field}`,
    `value.normalized=${args.fact.valueNormalized}`,
  ];

  if (
    prev.includes(dn) &&
    duplicateNeedles.every((needle) => prev.includes(needle)) &&
    !/(ですくん|くんです)/u.test(prev)
  ) {
    return prev;
  }

  return `${prev}\n\n${addition}`;
}

function buildSavedReply(targetLabel: string, fact: ExtractedFact): string {
  const dn = displayName(targetLabel);

  if (fact.field === 'age') {
    return `うん、${dn}は${fact.valueNumber}歳として見ていくね。`;
  }

  if (fact.field === 'children') {
    if (fact.valueNormalized === 'no_children') {
      return `うん、${dn}は子供はいない、という前提で見ていくね。`;
    }

    const countText = fact.valueNumber != null ? `${fact.valueNumber}人` : '';
    const relationText =
      fact.childGender === 'son'
        ? '息子さん'
        : fact.childGender === 'daughter'
          ? '娘さん'
          : 'お子さん';

    const childName = normalizeChildNameForDisplay(fact.childName);

    if (childName) {
      return `うん、${dn}には${relationText}${countText ? `が${countText}` : 'が'}いて、名前は${childName}くんですね。これで見ていくね。`;
    }

    return `うん、${dn}には${countText ? `${countText}の` : ''}${relationText}がいる、という前提で見ていくね。`;
  }

  return `うん、${dn}の${factTopicLabel(fact.field)}として「${fact.valueText}」を見ていくね。`;
}

function buildConfirmationReply(fact: ExtractedFact, targetLabel: string | null): string {
  const topic = factTopicLabel(fact.field);
  if (targetLabel) {
    const dn = displayName(targetLabel);
    return `それは、${dn}の${topic}として見ておくね？`;
  }

  return `その${topic}の情報は、誰の情報として見ておけばいいですか？`;
}

async function saveGuidanceHint(args: {
  supabase: any;
  userCode: string;
  targetLabel: string;
  guidanceHint: string;
  traceId?: string | null;
  conversationId: string;
  field: FactField;
}): Promise<boolean> {
  const { data: existing, error: existingErr } = await args.supabase
    .from('iros_person_intent_state')
    .select('owner_user_code, target_type, target_label, q_primary, depth_stage, phase, intent_band, direction, focus_layer, core_need, guidance_hint, t_layer_hint, self_acceptance')
    .eq('owner_user_code', args.userCode)
    .eq('target_type', 'person')
    .eq('target_label', args.targetLabel)
    .maybeSingle();

  if (existingErr) {
    console.warn('[IROS/PERSON_FACT_CAPTURE][EXISTING_LOAD_FAILED]', {
      traceId: args.traceId ?? null,
      userCode: args.userCode,
      targetLabel: args.targetLabel,
      field: args.field,
      message: existingErr?.message ?? String(existingErr),
    });
  }

  const payload = {
    owner_user_code: args.userCode,
    target_type: 'person',
    target_label: args.targetLabel,

    q_primary: existing?.q_primary ?? null,
    depth_stage: existing?.depth_stage ?? null,
    phase: existing?.phase ?? null,
    intent_band: existing?.intent_band ?? null,
    direction: existing?.direction ?? null,
    focus_layer: existing?.focus_layer ?? null,
    core_need: existing?.core_need ?? null,
    guidance_hint: args.guidanceHint,
    t_layer_hint: existing?.t_layer_hint ?? null,
    self_acceptance: existing?.self_acceptance ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await args.supabase
    .from('iros_person_intent_state')
    .upsert(payload, {
      onConflict: 'owner_user_code,target_type,target_label',
    });

  if (upsertErr) {
    console.warn('[IROS/PERSON_FACT_CAPTURE][SAVE_FAILED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      targetLabel: args.targetLabel,
      field: args.field,
      message: upsertErr?.message ?? String(upsertErr),
    });
    return false;
  }

  return true;
}

export async function capturePersonFactFromConversation(args: CaptureArgs): Promise<CaptureResult> {
  const userText = norm(args.userText);

  if (!userText) return { captured: false, reason: 'empty_user_text' };

  const fact = extractSupportedFact(userText);
  if (!fact) {
    return { captured: false, reason: 'no_supported_person_fact' };
  }

  const recentMessages = await loadRecentMessages(args);
  const resolved = resolveTargetFromRecentContext({
    userText,
    recentMessages,
  });

  if (!resolved.targetLabel || resolved.confidence !== 'high') {
    const directReply = buildConfirmationReply(fact, resolved.targetLabel);

    console.info('[IROS/PERSON_FACT_CAPTURE][NEEDS_CONFIRMATION]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      field: fact.field,
      targetLabel: resolved.targetLabel ?? null,
      targetSource: resolved.source ?? null,
      confidence: resolved.confidence,
      userTextHead: userText.slice(0, 120),
    });

    return {
      captured: false,
      shouldAskConfirmation: true,
      targetLabel: resolved.targetLabel,
      targetSource: resolved.source,
      field: fact.field,
      status: 'needs_confirmation',
      confidence: 'low',
      sensitivity: fact.sensitivity,
      source: 'conversation',
      valueText: fact.valueText,
      valueNumber: fact.valueNumber,
      valueNormalized: fact.valueNormalized,
      directReply,
      reason: 'needs_confirmation',
    };
  }

  const targetLabel = resolved.targetLabel;

  const { data: existing } = await args.supabase
    .from('iros_person_intent_state')
    .select('guidance_hint')
    .eq('owner_user_code', args.userCode)
    .eq('target_type', 'person')
    .eq('target_label', targetLabel)
    .maybeSingle();

  const guidanceHint = buildGuidanceHint({
    targetLabel,
    fact,
    previousGuidanceHint: existing?.guidance_hint ?? null,
  });

  const saved = await saveGuidanceHint({
    supabase: args.supabase,
    userCode: args.userCode,
    targetLabel,
    guidanceHint,
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    field: fact.field,
  });

  if (!saved) return { captured: false, reason: 'save_failed' };

  const directReply = buildSavedReply(targetLabel, fact);

  console.info('[IROS/PERSON_FACT_CAPTURE][SAVED]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    userCode: args.userCode,
    targetLabel,
    targetSource: resolved.source,
    field: fact.field,
    status: 'confirmed_by_user',
    confidence: 'high',
    sensitivity: fact.sensitivity,
    valueText: fact.valueText,
    valueNumber: fact.valueNumber,
    valueNormalized: fact.valueNormalized,
  });

  return {
    captured: true,
    shouldAskConfirmation: false,
    targetLabel,
    targetSource: resolved.source,
    field: fact.field,
    status: 'confirmed_by_user',
    confidence: 'high',
    sensitivity: fact.sensitivity,
    source: 'conversation',
    valueText: fact.valueText,
    valueNumber: fact.valueNumber,
    valueNormalized: fact.valueNormalized,
    directReply,
  };
}
