type CaptureArgs = {
  supabase: any;
  userCode: string;
  conversationId: string;
  userText: string;
  traceId?: string | null;
};

type CaptureResult = {
  captured: boolean;
  targetLabel?: string;
  field?: string;
  valueText?: string;
  valueNumber?: number | null;
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

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function normalizePersonLabel(v: unknown): string | null {
  let s = norm(v)
    .replace(/[「」『』（）()【】\[\]]/g, '')
    .replace(/[ \t\r\n　]/g, '');

  if (!s) return null;

  const direct = PERSON_ALIAS[s] ?? PERSON_ALIAS[s.toLowerCase()];
  if (direct) return direct;

  s = s.replace(/(さん|先生|様|くん|ちゃん|氏)$/u, '');
  if (!s) return null;

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
  if (m?.[1]) return normalizePersonLabel(m[1]);

  return null;
}

function extractAgeFact(userText: string): { age: number; valueText: string } | null {
  const s = norm(userText);
  const m = s.match(/(\d{1,3})\s*歳/u);
  if (!m?.[1]) return null;

  const age = Number(m[1]);
  if (!Number.isFinite(age) || age <= 0 || age > 120) return null;

  return { age, valueText: `${age}歳` };
}

function looksLikeConfirmedAgeSupplement(userText: string): boolean {
  const s = norm(userText);

  if (!extractAgeFact(s)) return false;
  if (PROJECT_LIKE_RE.test(s)) return false;

  return /(だよ|だった|だったよ|っていってた|って言ってた|と言ってた|いってた|言ってた|なった|この前の誕生日|誕生日で)/u.test(s);
}

function pickMessageText(row: any): string {
  return norm(row?.content ?? row?.text ?? row?.assistantText ?? row?.message ?? '');
}

function pickLabelFromMeta(meta: any): string | null {
  const candidates = [
    meta?.extra?.ctxPack?.preSeedDecision?.ctxPackPatch?.resolvedTarget?.label,
    meta?.extra?.ctxPack?.preSeedDecision?.ctxPackPatch?.targetLabel,
    meta?.extra?.ctxPack?.preSeedDecision?.metaPatch?.targetLabel,
    meta?.extra?.ctxPack?.resolvedTarget?.label,
    meta?.extra?.ctxPack?.targetLabel,
    meta?.extra?.personFactCaptureTargetLabel,
    meta?.extra?.personContextTargetLabel,
    meta?.ctxPack?.resolvedTarget?.label,
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
    .limit(10);

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
}): { targetLabel: string | null; source: string | null } {
  const current = extractPersonLabelFromText(args.userText);
  if (current) return { targetLabel: current, source: 'current_user_text' };

  for (const row of args.recentMessages) {
    const txt = pickMessageText(row);

    // current user message が先頭に来ることがあるので、同一本文は対象解決に使わない
    if (txt && txt === norm(args.userText)) continue;

    const fromMeta = pickLabelFromMeta(row?.meta ?? null);
    if (fromMeta) {
      return {
        targetLabel: fromMeta,
        source: `recent_${row?.role ?? 'unknown'}_meta`,
      };
    }

    const fromText = extractPersonLabelFromText(txt);
    if (fromText) {
      return {
        targetLabel: fromText,
        source: `recent_${row?.role ?? 'unknown'}_text`,
      };
    }
  }

  return { targetLabel: null, source: null };
}

function buildGuidanceHint(args: {
  targetLabel: string;
  age: number;
  previousGuidanceHint?: string | null;
}): string {
  const dn = displayName(args.targetLabel);

  const addition = [
    `ユーザー確認済み事実：${dn}は、この前の誕生日で${args.age}歳になった。`,
    `心理的文脈：ユーザーがMuの不明情報を補足し、${dn}の人物理解を修正している。`,
  ].join('\n');

  const prev = norm(args.previousGuidanceHint);
  if (!prev) return addition;

  if (prev.includes(dn) && prev.includes(`${args.age}歳`)) {
    return prev;
  }

  return `${prev}\n\n${addition}`;
}

export async function capturePersonFactFromConversation(args: CaptureArgs): Promise<CaptureResult> {
  const userText = norm(args.userText);

  if (!userText) return { captured: false, reason: 'empty_user_text' };
  if (!looksLikeConfirmedAgeSupplement(userText)) {
    return { captured: false, reason: 'no_confirmed_age_supplement' };
  }

  const ageFact = extractAgeFact(userText);
  if (!ageFact) return { captured: false, reason: 'no_age_fact' };

  const recentMessages = await loadRecentMessages(args);
  const resolved = resolveTargetFromRecentContext({
    userText,
    recentMessages,
  });

  if (!resolved.targetLabel) {
    console.info('[IROS/PERSON_FACT_CAPTURE][TARGET_UNRESOLVED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      userTextHead: userText.slice(0, 120),
    });

    return { captured: false, reason: 'target_unresolved' };
  }

  const targetLabel = resolved.targetLabel;

  const { data: existing, error: existingErr } = await args.supabase
    .from('iros_person_intent_state')
    .select('owner_user_code, target_type, target_label, q_primary, depth_stage, phase, intent_band, direction, focus_layer, core_need, guidance_hint, t_layer_hint, self_acceptance')
    .eq('owner_user_code', args.userCode)
    .eq('target_type', 'person')
    .eq('target_label', targetLabel)
    .maybeSingle();

  if (existingErr) {
    console.warn('[IROS/PERSON_FACT_CAPTURE][EXISTING_LOAD_FAILED]', {
      traceId: args.traceId ?? null,
      userCode: args.userCode,
      targetLabel,
      message: existingErr?.message ?? String(existingErr),
    });
  }

  const guidanceHint = buildGuidanceHint({
    targetLabel,
    age: ageFact.age,
    previousGuidanceHint: existing?.guidance_hint ?? null,
  });

  const payload = {
    owner_user_code: args.userCode,
    target_type: 'person',
    target_label: targetLabel,

    q_primary: existing?.q_primary ?? null,
    depth_stage: existing?.depth_stage ?? null,
    phase: existing?.phase ?? null,
    intent_band: existing?.intent_band ?? null,
    direction: existing?.direction ?? null,
    focus_layer: existing?.focus_layer ?? null,
    core_need: existing?.core_need ?? null,
    guidance_hint: guidanceHint,
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
      targetLabel,
      message: upsertErr?.message ?? String(upsertErr),
    });

    return { captured: false, reason: 'save_failed' };
  }

  const dn = displayName(targetLabel);
  const directReply =
    `うん、その前提で見ると、${dn}は${ageFact.age}歳だね。\n` +
    `今の情報は、${dn}の人物メモとして扱っておくね。`;

  console.info('[IROS/PERSON_FACT_CAPTURE][SAVED]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    userCode: args.userCode,
    targetLabel,
    targetSource: resolved.source,
    field: 'age',
    valueNumber: ageFact.age,
  });

  return {
    captured: true,
    targetLabel,
    field: 'age',
    valueText: ageFact.valueText,
    valueNumber: ageFact.age,
    directReply,
  };
}
