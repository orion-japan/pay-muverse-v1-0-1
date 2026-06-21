type CaptureArgs = {
  supabase: any;
  userCode: string;
  conversationId: string;
  userText: string;
  traceId?: string | null;
};

type RelationshipStatus = 'confirmed_by_user' | 'candidate' | 'needs_confirmation';
type RelationshipConfidence = 'high' | 'middle' | 'low';

type RelationshipKind =
  | 'one_sided_love'
  | 'mutual_romance'
  | 'romantic_partner'
  | 'ex_partner'
  | 'affair_partner'
  | 'cheating_partner'
  | 'secret_relationship'
  | 'triangle_relationship'
  | 'ambiguous_romance'
  | 'workplace_romance'
  | 'married_person_romance'
  | 'second_partner'
  | 'dependence_relationship'
  | 'friend'
  | 'family'
  | 'client'
  | 'teacher'
  | 'student'
  | 'disciple'
  | 'coworker'
  | 'business_partner'
  | 'unknown';

type ExtractedRelationshipContext = {
  kind: RelationshipKind;
  valueText: string;
  valueNormalized: string;
  status: RelationshipStatus;
  confidence: RelationshipConfidence;
  sensitivity: 'relationship_context' | 'private_relationship';
  visibility: 'normal' | 'restricted';
  reusePolicy: 'allowed_for_relationship_context' | 'only_when_user_refers_to_relationship';
  userRole: string | null;
  note: string;
  detailLines: string[];
};

type CaptureResult = {
  captured: boolean;
  shouldAskConfirmation?: boolean;
  targetLabel?: string | null;
  targetSource?: string | null;
  kind?: RelationshipKind;
  status?: RelationshipStatus;
  confidence?: RelationshipConfidence;
  sensitivity?: string;
  source?: 'conversation';
  valueText?: string;
  valueNormalized?: string | null;
  directReply?: string;
  reason?: string;
};

type TargetResolution = {
  targetLabel: string | null;
  source: string | null;
  confidence: 'high' | 'low';
};

const PROJECT_LIKE_RE =
  /(Muverse|Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|Git|Next\.js|route\.ts|コード|PowerShell|typecheck|npm|実装|修正|エラー|ビルド|デプロイ|パッチ)/iu;

const PERSON_SUFFIX_RE = /(さん|先生|様|くん|ちゃん|氏)$/u;

const TARGET_TRAILING_RE =
  /(との関係|との恋愛|とのこと|の関係|の件|のこと|について)$/u;

const GENERIC_NON_PERSON_LABELS = new Set([
  '彼',
  '彼女',
  '相手',
  '好きな人',
  '片思い',
  '恋人',
  '元恋人',
  '不倫相手',
  '浮気相手',
  '友人',
  '友達',
  '家族',
  '先生',
  'クライアント',
  'スタッフ',
  '弟子',
  '同僚',
]);

const PRIVATE_KINDS = new Set<RelationshipKind>([
  'affair_partner',
  'cheating_partner',
  'secret_relationship',
  'triangle_relationship',
  'married_person_romance',
  'second_partner',
]);

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
  if (GENERIC_NON_PERSON_LABELS.has(s)) return null;

  return s;
}

function isQuestionOrConsultation(text: string): boolean {
  return /[?？]|(どう思|どうしたら|見て|占って|診断して|どうなる|どうすれば|ですか|でしょうか|かな)/u.test(text);
}

function isRelationshipConsultation(text: string): boolean {
  return /(関係を見て|関係見て|どう思|どうしたら|どうなる|片思いどう|不倫関係|三角関係|この関係|恋愛を見て|気持ちを見て)/u.test(text);
}

function extractPersonLabelFromText(text: string): string | null {
  const s = norm(text);
  if (!s) return null;

  const patterns = [
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)(?:は|が|と|との|に|を|の|って|$)/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:は|が|との|と)(?:私の|自分の|僕の|俺の)?(?:片思い|恋人|元恋人|不倫|浮気|秘密|三角関係|職場恋愛|友人|友達|家族|クライアント|先生|弟子|同僚)/u,
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})の件/u,
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (!m?.[1]) continue;
    const label = normalizePersonLabel(m[1]);
    if (label) return label;
  }

  return null;
}

function pickMessageText(row: any): string {
  return norm(row?.content ?? row?.text ?? row?.assistantText ?? row?.message ?? '');
}

function pickLabelFromMeta(meta: any): string | null {
  const candidates = [
    meta?.extra?.relationshipContextCaptureTargetLabel,
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
    console.warn('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][RECENT_MESSAGES_FAILED]', {
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

  return { targetLabel: null, source: null, confidence: 'low' };
}

function extractRelationshipContext(userText: string): ExtractedRelationshipContext | null {
  const s = norm(userText);
  if (!s) return null;
  if (PROJECT_LIKE_RE.test(s)) return null;

  // 保存層なので、質問・相談文は保存しない
  if (isQuestionOrConsultation(s) || isRelationshipConsultation(s)) return null;

  const patterns: Array<[RegExp, RelationshipKind, string, string | null]> = [
    [/(片思い|好きな人|一方的に好き)/u, 'one_sided_love', '気になっている相手', 'has_feelings'],
    [/(両思い)/u, 'mutual_romance', '両思いの関係', 'mutual_feelings'],
    [/(恋人|付き合っている|交際中|彼氏|彼女)/u, 'romantic_partner', '恋人・交際関係', 'partner'],
    [/(元恋人|元カレ|元カノ|元彼|元彼女|前の恋人)/u, 'ex_partner', '元恋人', 'ex_partner'],
    [/(不倫|既婚者との関係|既婚者と)/u, 'affair_partner', '表に出しにくい恋愛関係', 'private_partner'],
    [/(浮気相手|浮気関係|二股)/u, 'cheating_partner', '秘密性の高い恋愛関係', 'private_partner'],
    [/(秘密の関係|隠している関係|表に出せない関係)/u, 'secret_relationship', '秘密の関係', 'private_partner'],
    [/(三角関係)/u, 'triangle_relationship', '三角関係', 'private_or_complex_relation'],
    [/(曖昧な関係|曖昧な恋愛|はっきりしない関係)/u, 'ambiguous_romance', '曖昧な関係', 'unclear_relation'],
    [/(職場恋愛)/u, 'workplace_romance', '職場恋愛', 'workplace_romance'],
    [/(セカンド|二番目)/u, 'second_partner', '秘密性の高い関係', 'private_partner'],
    [/(依存関係|依存している|依存されている)/u, 'dependence_relationship', '依存を含む関係', 'dependence'],
    [/(友人|友達)/u, 'friend', '友人', 'friend'],
    [/(家族)/u, 'family', '家族', 'family'],
    [/(クライアント|顧客)/u, 'client', 'クライアント', 'client'],
    [/(先生|講師)/u, 'teacher', '先生', 'teacher'],
    [/(生徒)/u, 'student', '生徒', 'student'],
    [/(弟子)/u, 'disciple', '弟子', 'disciple'],
    [/(同僚|仕事仲間)/u, 'coworker', '同僚', 'coworker'],
    [/(ビジネスパートナー|共同経営|仕事のパートナー)/u, 'business_partner', '仕事上のパートナー', 'business_partner'],
  ];

  for (const [re, kind, label, userRole] of patterns) {
    if (!re.test(s)) continue;

    const isPrivate = PRIVATE_KINDS.has(kind);

    return {
      kind,
      valueText: label,
      valueNormalized: kind,
      status: 'confirmed_by_user',
      confidence: 'high',
      sensitivity: isPrivate ? 'private_relationship' : 'relationship_context',
      visibility: isPrivate ? 'restricted' : 'normal',
      reusePolicy: isPrivate
        ? 'only_when_user_refers_to_relationship'
        : 'allowed_for_relationship_context',
      userRole,
      note: s,
      detailLines: [
        'relationship_context:',
        `relationship.kind=${kind}`,
        'relationship.status=confirmed_by_user',
        'relationship.confidence=high',
        `relationship.sensitivity=${isPrivate ? 'private_relationship' : 'relationship_context'}`,
        `relationship.visibility=${isPrivate ? 'restricted' : 'normal'}`,
        `relationship.reuse_policy=${isPrivate ? 'only_when_user_refers_to_relationship' : 'allowed_for_relationship_context'}`,
        userRole ? `relationship.user_role=${userRole}` : '',
      ].filter(Boolean),
    };
  }

  return null;
}

function buildGuidanceHint(args: {
  targetLabel: string;
  ctx: ExtractedRelationshipContext;
  previousGuidanceHint?: string | null;
}): string {
  const lines = [
    `ユーザー確認済み関係性：${args.targetLabel}との関係について、${args.ctx.valueText}として扱う。`,
    `status=${args.ctx.status} / source=conversation / confidence=${args.ctx.confidence} / sensitivity=${args.ctx.sensitivity}`,
    ...args.ctx.detailLines,
    `心理的文脈：ユーザーが${args.targetLabel}との関係性を明示し、今後の関係相談でその前提を安全に扱う必要がある。`,
  ].filter(Boolean);

  const addition = lines.join('\n');
  const prev = norm(args.previousGuidanceHint);

  if (!prev) return addition;

  if (
    prev.includes('relationship_context:') &&
    prev.includes(`relationship.kind=${args.ctx.kind}`) &&
    prev.includes(args.targetLabel)
  ) {
    return prev;
  }

  return `${prev}\n\n${addition}`;
}

function buildSavedReply(targetLabel: string, ctx: ExtractedRelationshipContext): string {
  if (ctx.sensitivity === 'private_relationship') {
    return `うん、${targetLabel}との関係には、表に出しにくい前提があるものとして扱います。通常の人物情報としては出さず、関係相談の時だけ慎重に見ます。`;
  }

  return `うん、${targetLabel}との関係は「${ctx.valueText}」として見ていきます。`;
}

function buildConfirmationReply(targetLabel: string | null): string {
  if (targetLabel) {
    return `それは、${targetLabel}との関係性として見ておくね？`;
  }

  return 'その関係性は、誰との関係として見ておけばいいですか？';
}
function buildProvisionalRelationshipReply(targetLabel: string): string {
  return `${targetLabel}との関係として、いったん受け取っておきますね。名前や呼び名が出てきたら、同じ相手として見ていきます。`;
}

async function saveGuidanceHint(args: {
  supabase: any;
  userCode: string;
  targetLabel: string;
  guidanceHint: string;
  traceId?: string | null;
  conversationId: string;
  kind: RelationshipKind;
}): Promise<boolean> {
  const { data: existing, error: existingErr } = await args.supabase
    .from('iros_person_intent_state')
    .select('owner_user_code, target_type, target_label, q_primary, depth_stage, phase, intent_band, direction, focus_layer, core_need, guidance_hint, t_layer_hint, self_acceptance')
    .eq('owner_user_code', args.userCode)
    .eq('target_type', 'person')
    .eq('target_label', args.targetLabel)
    .maybeSingle();

  if (existingErr) {
    console.warn('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][EXISTING_LOAD_FAILED]', {
      traceId: args.traceId ?? null,
      userCode: args.userCode,
      targetLabel: args.targetLabel,
      kind: args.kind,
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
    console.warn('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][SAVE_FAILED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      targetLabel: args.targetLabel,
      kind: args.kind,
      message: upsertErr?.message ?? String(upsertErr),
    });
    return false;
  }

  return true;
}

export async function captureRelationshipContextFromConversation(args: CaptureArgs): Promise<CaptureResult> {
  const userText = norm(args.userText);

  if (!userText) return { captured: false, reason: 'empty_user_text' };

  const ctx = extractRelationshipContext(userText);
  if (!ctx) {
    return { captured: false, reason: 'no_supported_relationship_context' };
  }

  const recentMessages = await loadRecentMessages(args);
  const resolved = resolveTargetFromRecentContext({
    userText,
    recentMessages,
  });

  if (!resolved.targetLabel || resolved.confidence !== 'high') {
    const provisionalTargetLabel = ctx.valueText || '気になっている相手';
    const provisionalCtx: ExtractedRelationshipContext = {
      ...ctx,
      status: 'candidate',
      confidence: 'low',
    };

    const { data: existing } = await args.supabase
      .from('iros_person_intent_state')
      .select('guidance_hint')
      .eq('owner_user_code', args.userCode)
      .eq('target_type', 'person')
      .eq('target_label', provisionalTargetLabel)
      .maybeSingle();

    const guidanceHint = buildGuidanceHint({
      targetLabel: provisionalTargetLabel,
      ctx: provisionalCtx,
      previousGuidanceHint: existing?.guidance_hint ?? null,
    });

    const saved = await saveGuidanceHint({
      supabase: args.supabase,
      userCode: args.userCode,
      targetLabel: provisionalTargetLabel,
      guidanceHint,
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      kind: ctx.kind,
    });

    const directReply = buildProvisionalRelationshipReply(provisionalTargetLabel);

    console.info('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][PROVISIONAL_TARGET_SAVED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      kind: ctx.kind,
      targetLabel: provisionalTargetLabel,
      targetSource: 'provisional_relationship_label',
      saved,
      confidence: 'low',
      userTextHead: userText.slice(0, 120),
    });

    return {
      captured: saved,
      shouldAskConfirmation: false,
      targetLabel: provisionalTargetLabel,
      targetSource: 'provisional_relationship_label',
      kind: ctx.kind,
      status: 'candidate',
      confidence: 'low',
      sensitivity: ctx.sensitivity,
      source: 'conversation',
      valueText: ctx.valueText,
      valueNormalized: ctx.valueNormalized,
      directReply,
      reason: saved ? 'provisional_target_saved' : 'provisional_target_save_failed',
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
    ctx,
    previousGuidanceHint: existing?.guidance_hint ?? null,
  });

  const saved = await saveGuidanceHint({
    supabase: args.supabase,
    userCode: args.userCode,
    targetLabel,
    guidanceHint,
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    kind: ctx.kind,
  });

  if (!saved) return { captured: false, reason: 'save_failed' };

  const directReply = buildSavedReply(targetLabel, ctx);

  console.info('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][SAVED]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    userCode: args.userCode,
    targetLabel,
    targetSource: resolved.source,
    kind: ctx.kind,
    status: ctx.status,
    confidence: ctx.confidence,
    sensitivity: ctx.sensitivity,
    visibility: ctx.visibility,
    reusePolicy: ctx.reusePolicy,
    valueText: ctx.valueText,
    valueNormalized: ctx.valueNormalized,
  });

  return {
    captured: true,
    shouldAskConfirmation: false,
    targetLabel,
    targetSource: resolved.source,
    kind: ctx.kind,
    status: ctx.status,
    confidence: ctx.confidence,
    sensitivity: ctx.sensitivity,
    source: 'conversation',
    valueText: ctx.valueText,
    valueNormalized: ctx.valueNormalized,
    directReply,
  };
}
