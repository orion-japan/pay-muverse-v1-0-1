type CaptureArgs = {
  supabase: any;
  userCode: string;
  conversationId: string;
  userText: string;
  traceId?: string | null;
};

type FactField = 'age' | 'children';

type FactStatus = 'confirmed_by_user' | 'needs_confirmation';

type FactConfidence = 'high' | 'low';

type TargetResolution = {
  targetLabel: string | null;
  source: string | null;
  confidence: FactConfidence;
};

type ExtractedFact =
  | {
      field: 'age';
      valueText: string;
      valueNumber: number;
      valueNormalized: string;
      sensitivity: 'age';
      note: string;
    }
  | {
      field: 'children';
      valueText: string;
      valueNumber: number | null;
      valueNormalized: 'has_children' | 'no_children' | 'unknown';
      childGender: 'son' | 'daughter' | 'child' | null;
      childName: string | null;
      sensitivity: 'family_structure';
      note: string;
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

const PERSON_ALIAS: Record<string, string> = {
  'リナ': 'リナ',
  'リナちゃん': 'リナ',
  'りな': 'リナ',
  'りなちゃん': 'リナ',
  'Rina': 'リナ',
  'rina': 'リナ',

  'みゆ': 'みゆ',
  'ミユ': 'みゆ',
  'Miyu': 'みゆ',
  'miyu': 'みゆ',

  '浅野': '浅野',
  '浅野さん': '浅野',

  '畠山': '畠山',
  '畠山さん': '畠山',
};

const PROJECT_LIKE_RE =
  /(Muverse|Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|Git|Next\.js|route\.ts|コード|PowerShell|typecheck|npm|実装|修正|エラー|ビルド|デプロイ|パッチ)/iu;

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
  '彼',
  '彼女',
  '相手',
  '相談者',
]);

function isGenericNonPersonLabel(v: unknown): boolean {
  const s = String(v ?? '').trim().replace(/[ \t\r\n　]/g, '');
  return GENERIC_NON_PERSON_LABELS.has(s);
}

function isQuestionLike(text: string): boolean {
  return /[?？]|(いますか|いるの|いる？|います？|ありますか|ある？|何人|何歳|だっけ|でしたっけ|ですか|でしょうか|かな)/u.test(text);
}

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function normalizePersonLabel(v: unknown): string | null {
  let s = norm(v)
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  if (!s) return null;
  if (isGenericNonPersonLabel(s)) return null;

  const direct = PERSON_ALIAS[s] ?? PERSON_ALIAS[s.toLowerCase()];
  if (direct) return direct;

  s = s.replace(/(さん|先生|様|くん|ちゃん|氏)$/u, '');
  if (!s) return null;
  if (isGenericNonPersonLabel(s)) return null;

  return PERSON_ALIAS[s] ?? PERSON_ALIAS[s.toLowerCase()] ?? s;
}

function displayName(label: string): string {
  if (label === 'リナ') return 'リナちゃん';
  if (label === 'みゆ') return 'みゆ';
  return label;
}

function extractPersonLabelFromText(text: string): string | null {
  const s = norm(text);
  if (!s) return null;

  for (const alias of Object.keys(PERSON_ALIAS)) {
    if (s.includes(alias)) return PERSON_ALIAS[alias];
  }

  const m = s.match(/([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)(?:の|は|って|と|に|を|$)/u);
  if (m?.[1]) {
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
  };
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

  return {
    field: 'children',
    valueText: parts.join('・'),
    valueNumber: count,
    valueNormalized: 'has_children',
    childGender,
    childName,
    sensitivity: 'family_structure',
    note: s,
  };
}

function extractSupportedFact(userText: string): ExtractedFact | null {
  const s = norm(userText);
  if (!s) return null;
  if (PROJECT_LIKE_RE.test(s)) return null;

  // Person Fact Capture は「ユーザーが補足した事実」を保存する層。
  // 質問文は保存しない。質問は Person Context Pre-SEED / 通常回答側で扱う。
  if (isQuestionLike(s)) return null;

  const age = extractAgeFact(s);
  if (
    age &&
    /(だよ|だった|だったよ|っていってた|って言ってた|と言ってた|いってた|言ってた|なった|この前の誕生日|誕生日で)/u.test(s)
  ) {
    return age;
  }

  const children = extractChildrenFact(s);
  if (children) return children;

  return null;
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
function buildGuidanceHint(args: {
  targetLabel: string;
  fact: ExtractedFact;
  previousGuidanceHint?: string | null;
}): string {
  const dn = displayName(args.targetLabel);

  let addition = '';

  if (args.fact.field === 'age') {
    addition = [
      `ユーザー確認済み事実：${dn}は、この前の誕生日で${args.fact.valueNumber}歳になった。`,
      `status=confirmed_by_user / source=conversation / confidence=high / sensitivity=age`,
      `心理的文脈：ユーザーがMuの不明情報を補足し、${dn}の人物理解を修正している。`,
    ].join('\n');
  } else {
    const lines = [
      `ユーザー確認済み事実：${dn}の家族構成について、${args.fact.valueText}。`,
      `status=confirmed_by_user / source=conversation / confidence=high / sensitivity=family_structure`,
      `children.normalized=${args.fact.valueNormalized}`,
      args.fact.valueNumber != null ? `children.count=${args.fact.valueNumber}` : '',
      args.fact.childGender ? `children.kind=${args.fact.childGender}` : '',
      normalizeChildNameForDisplay(args.fact.childName) ? `children.name=${normalizeChildNameForDisplay(args.fact.childName)}` : '',
      `心理的文脈：ユーザーが${dn}の家族構成を補足し、人物理解を生活背景まで広げている。`,
    ].filter(Boolean);

    addition = lines.join('\n');
  }

  const prev = norm(args.previousGuidanceHint);
  if (!prev) return addition;

  if (args.fact.field === 'age' && prev.includes(dn) && prev.includes(`${args.fact.valueNumber}歳`)) {
    return prev;
  }

  const childNameForDuplicateCheck =
    args.fact.field === 'children'
      ? normalizeChildNameForDisplay(args.fact.childName)
      : null;

  if (
    args.fact.field === 'children' &&
    prev.includes(dn) &&
    prev.includes('家族構成') &&
    !/(ですくん|くんです)/u.test(prev) &&
    (!childNameForDuplicateCheck || prev.includes(childNameForDuplicateCheck))
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

function buildConfirmationReply(fact: ExtractedFact, targetLabel: string | null): string {
  if (targetLabel) {
    const dn = displayName(targetLabel);
    if (fact.field === 'children') {
      return `それは、${dn}の家族構成として見ておくね？`;
    }
    return `それは、${dn}の情報として見ておくね？`;
  }

  if (fact.field === 'children') {
    return 'その家族構成の情報は、誰の情報として見ておけばいいですか？';
  }

  return 'その情報は、誰の情報として見ておけばいいですか？';
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









