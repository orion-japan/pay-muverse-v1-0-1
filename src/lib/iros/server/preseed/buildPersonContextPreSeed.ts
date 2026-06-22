import type { PreSeedDecision } from './types';
import { buildCognitionMap } from '../../cognition/buildCognitionMap';
import { cognitionMapToSeedText } from '../../cognition/cognitionMap';
import { buildPreSeedTcfStarter } from './preSeedTcfStarter';
import { loadPersonIntentState } from '@/lib/iros/memory/loadPersonIntent';
import { loadLatestIrDiagnosisSnapshot } from '@/lib/iros/memoryRecall';
import {
  loadRelationshipMemoriesForTurn,
  buildRelationshipMemoryNoteText,
} from '@/lib/iros/memory/relationshipMemoryRecall';
import { buildRelationId } from './universal/resolveRelation';
import { normalizePersonLabel, normalizeTargetKey } from './universal/normalize';

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function safeSlice(s: string, max = 900): string {
  const t = norm(s);
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = norm(v);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function buildAliasCandidates(targetLabel: string, targetKey: string): string[] {
  const label = normalizePersonLabel(targetLabel);
  const key = normalizeTargetKey(targetKey || targetLabel);

  const list = uniqueStrings([
    targetLabel,
    label,
    targetKey,
    key,
  ]);

  if (key === 'リナ'.toLowerCase() || label === 'リナ') {
    list.push('リナ', 'リナちゃん', 'りな', 'りなちゃん', 'Rina', 'rina');
  }

  if (key === 'みゆ' || label === 'みゆ') {
    list.push('みゆ', 'ミユ', 'Miyu', 'miyu');
  }

  return uniqueStrings(list);
}

function buildPersonIntentNote(row: any): string | null {
  if (!row) return null;

  const lines: string[] = [];

  lines.push('person_meta:');
  lines.push(`targetLabel=${row.targetLabel}`);
  lines.push(`targetType=${row.targetType}`);

  if (row.qPrimary) lines.push(`qPrimary=${row.qPrimary}`);
  if (row.depthStage) lines.push(`depthStage=${row.depthStage}`);
  if (row.phase) lines.push(`phase=${row.phase}`);
  if (row.intentBand) lines.push(`intentBand=${row.intentBand}`);
  if (row.direction) lines.push(`direction=${row.direction}`);
  if (row.focusLayer) lines.push(`focusLayer=${row.focusLayer}`);
  if (row.coreNeed) lines.push(`coreNeed=${row.coreNeed}`);
  if (row.guidanceHint) lines.push(`guidanceHint=${row.guidanceHint}`);
  if (row.tLayerHint) lines.push(`tLayerHint=${row.tLayerHint}`);

  if (typeof row.selfAcceptance === 'number') {
    lines.push(`selfAcceptance=${row.selfAcceptance}`);
  }

  if (row.updatedAt) lines.push(`updatedAt=${row.updatedAt}`);

  return lines.join('\n');
}

async function loadPersonIntentByAliases(args: {
  supabase: any;
  userCode: string;
  aliases: string[];
}): Promise<any | null> {
  const targetTypes = ['person', 'other'];

  for (const targetType of targetTypes) {
    for (const alias of args.aliases) {
      const row = await loadPersonIntentState(args.supabase, {
        ownerUserCode: args.userCode,
        targetType,
        targetLabel: alias,
      });

      if (row) return row;
    }
  }

  return null;
}

function stripInternalForVisibleReply(v: unknown): string {
  return String(v ?? '')
    .replace(/PERSON_CONTEXT_PRE_SEED[\s\S]*$/u, '')
    .replace(/latest_ir_diagnosis_context:/giu, '')
    .replace(/relationship_context:/giu, '')
    .replace(/person_meta:/giu, '')
    .replace(/この会話の中に内容が残っています。?/gu, '')
    .replace(/前に話していたのは、?/gu, '')
    .replace(/##\s*/g, '')
    .replace(/\b(DB|ログ|Pre-SEED|Memory|person_meta|targetKey|relationId|source|seed)\b/giu, '')
    .replace(/`n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function isPersonFactQuestionText(v: unknown): boolean {
  return /(何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ|子供|子ども|お子さん|息子|娘|家族構成|何人|夫|妻|旦那|奥さん|配偶者|結婚|独身|離婚|母|父|兄|姉|弟|妹|職業|仕事|会社|肩書き|立場)/u.test(String(v ?? ''));
}

function isRelationshipConsultationText(v: unknown): boolean {
  const s = String(v ?? '');
  return /(関係|恋愛|片思い|両思い|好き|気持ち|どう思|脈|距離感|不倫|浮気|三角関係|秘密の関係|恋人|元恋人|付き合|別れ|復縁|相談|見て)/u.test(s);
}

function shouldExposeRelationshipContextInPreSeed(userText: unknown): boolean {
  const isFactQuestion = isPersonFactQuestionText(userText);
  const isRelationshipConsultation = isRelationshipConsultationText(userText);
  return isRelationshipConsultation && !isFactQuestion;
}

function stripRelationshipContextFromPersonIntentNote(v: string | null): string | null {
  if (!v) return null;

  const lines = String(v).split(/\r?\n/u);
  const out: string[] = [];
  let skippingRelationshipBlock = false;

  for (const line of lines) {
    const s = String(line ?? '');

    if (/^\s*guidanceHint=.*relationship_context:/iu.test(s)) {
      const before = s.replace(/relationship_context:[\s\S]*$/iu, '').trimEnd();
      if (before && before !== 'guidanceHint=') out.push(before);
      skippingRelationshipBlock = true;
      continue;
    }

    if (/^\s*relationship_context:/iu.test(s)) {
      skippingRelationshipBlock = true;
      continue;
    }

    if (skippingRelationshipBlock) {
      if (/^\s*(relationship\.|心理的文脈|ユーザー確認済み関係性)/u.test(s)) {
        continue;
      }
      skippingRelationshipBlock = false;
    }

    if (/^\s*relationship\./iu.test(s)) continue;
    if (/^\s*心理的文脈：/u.test(s)) continue;
    if (/^\s*ユーザー確認済み関係性：/u.test(s)) continue;

    out.push(s);
  }

  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned || null;
}

function buildVisiblePersonContextReply(args: {
  targetLabel: string;
  personIntentNote: string | null;
  relationshipNoteText: string | null;
  diagnosisText: string | null;
  conversationMentionNote?: string | null;
  longTermNote?: string | null;
}): string {
  const source =
    args.personIntentNote ||
    args.relationshipNoteText ||
    args.diagnosisText ||
    '';

  const body = stripInternalForVisibleReply(source);

  if (!body) {
    return `${args.targetLabel}については、関連する人物文脈を探しましたが、今の時点で確定してまとめられる情報は多くありません。`;
  }

  const clipped = body.length > 900 ? body.slice(0, 900) + '…' : body;

  return [
    `${args.targetLabel}については、名前だけではなく、関連する人物文脈があります。`,
    '',
    '今見えている中心は、次のような流れです。',
    '',
    clipped,
    '',
    'まとめると、今は「その人の基本情報」よりも、関係の形・距離感・そこで起きている揺れを整理する段階です。'
  ].join('\n');
}
function uniqueNonEmpty(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for ( const v of values ) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clampPersonContextText(v: unknown, max = 360): string {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function rowContainsAnyAlias(row: unknown, aliases: string[]): boolean {
  const s = JSON.stringify(row ?? '');
  return aliases.some((a) => a && s.includes(a));
}

async function loadPersonMentionConversationContext(args: {
  supabase: any;
  userCode: string;
  aliases: string[];
  currentConversationId?: string | null;
}): Promise<string | null> {
  const sb = args.supabase;
  if (!sb?.from || !args.userCode || args.aliases.length === 0) return null;

  try {
    const { data: convRows, error: convErr } = await sb
      .from('iros_conversations')
      .select('id, updated_at, created_at')
      .eq('user_code', args.userCode)
      .order('updated_at', { ascending: false })
      .limit(120);

    if (convErr) {
      console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][CONV_LOOKUP_FAILED]', {
        message: convErr.message ?? String(convErr),
      });
      return null;
    }

    const conversationIds = uniqueNonEmpty((convRows ?? []).map((r: any) => r?.id));
    if (conversationIds.length === 0) return null;

    const aliasFilters = args.aliases.flatMap((a) => {
      const key = String(a ?? '').trim();
      if (!key) return [];
      return [
        `content.ilike.%${key}%`,
        `text.ilike.%${key}%`,
      ];
    });

    if (aliasFilters.length === 0) return null;

    const { data: msgRows, error: msgErr } = await sb
      .from('iros_messages')
      .select('conversation_id, role, content, text, created_at')
      .in('conversation_id', conversationIds)
      .or(aliasFilters.join(','))
      .order('created_at', { ascending: false })
      .limit(40);

    if (msgErr) {
      console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][MESSAGE_MENTION_LOOKUP_FAILED]', {
        message: msgErr.message ?? String(msgErr),
      });
      return null;
    }

    const rows = (msgRows ?? [])
      .filter((r: any) => rowContainsAnyAlias(r, args.aliases))
      .slice(0, 20)
      .reverse();

    if (rows.length === 0) return null;

    const lines: string[] = [];
    lines.push('PAST_PERSON_MENTIONS (DO NOT OUTPUT)');
    lines.push(`matchedAliases=${args.aliases.join(', ')}`);

    for (const r of rows) {
      const role = String((r as any)?.role ?? 'unknown');
      const body = clampPersonContextText((r as any)?.content ?? (r as any)?.text ?? '', 320);
      if (!body) continue;
      lines.push(`- ${role}: ${body}`);
    }

    const note = lines.join('\n').trim();
    return note.length > 0 ? note : null;
  } catch (e: any) {
    console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][MESSAGE_MENTION_ERROR]', {
      message: e?.message ?? String(e),
    });
    return null;
  }
}

async function loadPersonLongTermContext(args: {
  supabase: any;
  userCode: string;
  aliases: string[];
}): Promise<string | null> {
  const sb = args.supabase;
  if (!sb?.from || !args.userCode || args.aliases.length === 0) return null;

  const tryQuery = async (userColumn: 'user_code' | 'owner_user_code') => {
    return await sb
      .from('iros_long_term_memory')
      .select('*')
      .eq(userColumn, args.userCode)
      .limit(120);
  };

  try {
    let data: any[] | null = null;
    let error: any = null;

    const first = await tryQuery('user_code');
    data = first.data ?? null;
    error = first.error ?? null;

    if (error) {
      const second = await tryQuery('owner_user_code');
      data = second.data ?? null;
      error = second.error ?? null;
    }

    if (error) {
      console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][LONG_TERM_LOOKUP_FAILED]', {
        message: error.message ?? String(error),
      });
      return null;
    }

    const rows = (data ?? [])
      .filter((r: any) => rowContainsAnyAlias(r, args.aliases))
      .slice(0, 16);

    if (rows.length === 0) return null;

    const lines: string[] = [];
    lines.push('LONG_TERM_PERSON_CONTEXT (DO NOT OUTPUT)');
    lines.push(`matchedAliases=${args.aliases.join(', ')}`);

    for (const r of rows) {
      const body =
        (r as any)?.memory_text ??
        (r as any)?.content ??
        (r as any)?.summary ??
        (r as any)?.text ??
        JSON.stringify(r);

      const clipped = clampPersonContextText(body, 360);
      if (!clipped) continue;
      lines.push(`- ${clipped}`);
    }

    const note = lines.join('\n').trim();
    return note.length > 0 ? note : null;
  } catch (e: any) {
    console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][LONG_TERM_ERROR]', {
      message: e?.message ?? String(e),
    });
    return null;
  }
}
async function buildVisiblePersonContextReplyWithLlm(args: {
  userText: string;
  targetLabel: string;
  seedText: string;
  personIntentNote: string | null;
  relationshipNoteText: string | null;
  diagnosisText: string | null;
  conversationMentionNote?: string | null;
  longTermNote?: string | null;
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const sourceText = [
    args.personIntentNote ? `PERSON_STATE:\n${args.personIntentNote}` : '',
    args.relationshipNoteText ? `RELATIONSHIP_MEMORY:\n${args.relationshipNoteText}` : '',
    args.diagnosisText ? `DIAGNOSIS_CONTEXT:\n${args.diagnosisText}` : '',
    args.conversationMentionNote ? `CONVERSATION_MENTIONS:\n${args.conversationMentionNote}` : '',
    args.longTermNote ? `LONG_TERM_CONTEXT:\n${args.longTermNote}` : '',
  ].filter(Boolean).join('\n\n');

  if (!sourceText.trim()) return null;

  const model =
    process.env.IROS_PERSON_CONTEXT_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini';

  const system = [
    'あなたは Mu の人物文脈まとめ専用 writer です。',
    'DB文や診断seedをそのまま貼らず、自然な日本語で再構成してください。',
    '内部語は絶対に出さないでください。DB、ログ、Pre-SEED、Memory、seed、targetKey、relationId、source、diagnosis snapshot、材料、いただいた材料、この情報内、この範囲の情報、source内 などは禁止です。',
    '「名前しか分からない」「情報が足りない」と言わないでください。渡された人物文脈がある前提でまとめてください。',
    'ただし、人物文脈にない事実は足さないでください。',
    '過去文脈にある引用発言でも、今回のユーザー入力にない発言は、今回の対象人物が言った事実として書かないでください。',
    '恋愛・好意の読みでは、「あなた寄り」「一緒に過ごしたい気持ち」「距離を縮めるサイン」などの断定寄り表現を避け、「接点がやや多い」「関心が向いている可能性」「抵抗は少なそう」「そう見える」程度に弱めてください。',
    '年齢、誕生日、生年月日、子供の有無、息子・娘、家族構成などの事実質問では、人物文脈に明示されている場合だけ答えてください。',
    '質問された事実の明示がない場合は、内部情報や材料という言い方をせず、「今ここで確認できる範囲では、はっきりとは確認できません」と答えてください。',
    'children.normalized=has_children がある場合は「子供がいる」と答えてください。children.count があれば人数も答えてください。children.kind=son なら息子、daughter なら娘として答えてください。children.name があれば名前も添えてください。',
    'children.normalized=no_children がある場合は「子供はいない」と答えてください。',
    '事実質問では、性格分析や関係分析に逃げず、質問された事実にまず答えてください。',
    '年齢、病名、個人情報に近い内容は断定しすぎないでください。',
    '出力は、やさしく、読みやすく、Muらしい自然な文章にしてください。',
    '見出しは少なめ。箇条書きは3〜5点まで。',
    '最後に「いまの整理」を一文でまとめてください。',
    '禁止語：本当の自分、本当の姿、言葉になる前、静かに、寄ります、寄り添います。',
  ].join('\n');

  const isFactQuestion =
    /(何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ|子供|子ども|お子さん|息子|娘|家族構成|何人)/u.test(String(args.userText ?? ''));
  const user = [
    `ユーザー入力: ${args.userText}`,
    `対象人物: ${args.targetLabel}`,
    `質問種別: ${isFactQuestion ? 'person_fact_question' : 'person_context_summary'}`,
    '',
    isFactQuestion
      ? '以下の人物文脈を確認し、質問された事実だけに答えてください。明示情報がなければ、推測せず分からないと答えてください。'
      : '以下の人物文脈をもとに、対象人物について自然にまとめてください。',
    '',
    sourceText,
  ].join('\n');

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.45,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][LLM_FAILED]', {
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }

    const json: any = await res.json();
    const text = String(json?.choices?.[0]?.message?.content ?? '').trim();

    if (!text) return null;

    return text
      .replace(/\b(DB|ログ|Pre-SEED|Memory|person_meta|targetKey|relationId|source|seed|diagnosis snapshot)\b/giu, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (e: any) {
    console.warn('[IROS/PRE_SEED_PERSON_CONTEXT][LLM_ERROR]', {
      message: e?.message ?? String(e),
    });
    return null;
  }
}
function normalizeContextQuoteEvidenceText(input: unknown): string {
  return String(input ?? '')
    .replace(/[「」『』"'“”]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function stripUnsupportedQuotedClaimsFromContextNote(
  noteRaw: string | null | undefined,
  userTextRaw: string,
): string | null {
  const note = String(noteRaw ?? '').trim();
  const userText = String(userTextRaw ?? '');

  if (!note || !userText) return note || null;

  const userEvidence = normalizeContextQuoteEvidenceText(userText);
  const lines = note.split(/\r?\n/u);

  const kept: string[] = [];
  let keptContentLineCount = 0;

  for (const lineRaw of lines) {
    const line = String(lineRaw ?? '').trimEnd();
    const compact = line.trim();

    if (!compact) {
      kept.push(line);
      continue;
    }

    // 見出し・メタ行は残す。ただし本文行が全削除なら最後にnoteごと捨てる。
    if (
      /^(PAST_PERSON_MENTIONS|LONG_TERM_PERSON_CONTEXT|matchedAliases=)/u.test(compact)
    ) {
      kept.push(line);
      continue;
    }

    const quoted = Array.from(
      compact.matchAll(/[「『]([\s\S]{2,160}?)[」』]/gu),
    )
      .map((m) => String(m?.[1] ?? '').trim())
      .filter(Boolean);

    let hasUnsupportedQuote = false;

    for (const inner of quoted) {
      const normalizedInner = normalizeContextQuoteEvidenceText(inner);

      // 「みんな」などの短い概念ラベルは、要約語として許容。
      if (normalizedInner.length <= 4) continue;

      // 今回のユーザー入力に存在しない引用発言は、過去文脈の表面事実混入として除外。
      if (!userEvidence.includes(normalizedInner)) {
        hasUnsupportedQuote = true;
        break;
      }
    }

    if (hasUnsupportedQuote) continue;

    kept.push(line);
    keptContentLineCount += 1;
  }

  if (keptContentLineCount <= 0) return null;

  const cleaned = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned || null;
}
function buildPersonContextSeed(args: {
  userText: string;
  targetLabel: string;
  targetKey: string;
  aliases: string[];
  relationId: string | null;
  personIntentNote: string | null;
  relationshipNoteText: string | null;
  diagnosisText: string | null;
  conversationMentionNote?: string | null;
  longTermNote?: string | null;
}): string {
  const lines: string[] = [];
  const exposeRelationshipContext = shouldExposeRelationshipContextInPreSeed(args.userText);
  const personIntentNoteForSeed = exposeRelationshipContext
    ? args.personIntentNote
    : stripRelationshipContextFromPersonIntentNote(args.personIntentNote);
  const relationshipNoteTextForSeed = exposeRelationshipContext
    ? args.relationshipNoteText
    : null;

  lines.push('PERSON_CONTEXT_PRE_SEED (DO NOT OUTPUT)');
  lines.push('source=preseed_person_context');
  lines.push('turnTask=person_context_summary');
  lines.push('targetLabel=' + args.targetLabel);
  lines.push('targetKey=' + args.targetKey);
  lines.push('aliases=' + args.aliases.join(', '));
  if (args.relationId) lines.push('relationId=' + args.relationId);
  lines.push('currentUserText=' + args.userText);
  lines.push('');

  lines.push('priority:');
  lines.push('1. person_meta');
  lines.push('2. relationship_memory');
  lines.push('3. ir_diagnosis_text');
  lines.push('');

  lines.push('rules:');
  lines.push('- このターンは、人物名またはニックネームから内部 targetKey に接続し、人物メタを安全に要約する。');
  lines.push('- sourceにない事実は作らない。');
  lines.push('- 個人情報・年齢・病名に近い内容は、sourceが明確でも言い切りすぎない。');
  lines.push('- 内部語を本文に出さない。DB、ログ、Pre-SEED、Memory、person_meta、targetKey、relationId などを出さない。');
  lines.push('- 他の人物の情報を混ぜない。');
  lines.push('- 情報が薄い場合でも「名前だけ」と断定せず、分かる範囲を明示する。');
  lines.push('- 「覚えています」は verified memory truth check 以外では使わない。');
  lines.push('');

  if (personIntentNoteForSeed) {
    lines.push(personIntentNoteForSeed);
    lines.push('');
  }

  if (relationshipNoteTextForSeed) {
    lines.push('relationship_context:');
    lines.push(relationshipNoteTextForSeed);
    lines.push('');
  }

  if (!exposeRelationshipContext) {
    lines.push('relationship_context_guard:');
    lines.push('relationship_context is withheld in this turn because the current user text is not a relationship consultation.');
    lines.push('');
  }

  if (args.diagnosisText) {
    lines.push('latest_ir_diagnosis_context:');
    lines.push(safeSlice(args.diagnosisText, 1200));
    lines.push('');
  }

  lines.push('writerOutput:');
  lines.push('- まず「関連する人物文脈があります」のように自然に返す。');
  lines.push('- その後、現在地・方向・焦点・扱い方を3〜5点で要約する。');
  lines.push('- sourceが薄い場合は「確定できる情報は少ないですが」と言う。');

  return lines.join('\n');
}

export async function buildPersonContextPreSeed(args: {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  supabase?: any;
  targetLabel: string;
  targetKey: string;
  traceId?: string | null;
}): Promise<PreSeedDecision | null> {
  const targetLabel = normalizePersonLabel(args.targetLabel);
  const targetKey = normalizeTargetKey(args.targetKey || args.targetLabel);

  if (!targetLabel || !targetKey || !args.supabase?.from || !args.userCode) {
    return null;
  }

  const aliases = buildAliasCandidates(targetLabel, targetKey);
  const relationId = buildRelationId(args.userCode, targetKey);

  const personIntent = await loadPersonIntentByAliases({
    supabase: args.supabase,
    userCode: args.userCode,
    aliases,
  });

  const personIntentNote = buildPersonIntentNote(personIntent);

  const relationshipRows = relationId
    ? await loadRelationshipMemoriesForTurn({
        userCode: args.userCode,
        relationId,
        displayName: targetLabel,
        limit: 3,
      })
    : [];

  const relationshipNote = buildRelationshipMemoryNoteText({
    rows: relationshipRows,
    maxItems: 2,
  });

  let diagnosis: any = null;
  for (const alias of aliases) {
    diagnosis = await loadLatestIrDiagnosisSnapshot(
      args.supabase,
      args.userCode,
      alias
    );

    if (diagnosis) break;
  }

  const relationshipNoteText = relationshipNote.noteText || null;
  const diagnosisText = norm(
    diagnosis?.summary ??
    diagnosis?.observation ??
    diagnosis?.state ??
    ''
  );

  const exposeRelationshipContext = shouldExposeRelationshipContextInPreSeed(args.userText);

  const hasRelationshipContext =
    exposeRelationshipContext &&
    (Boolean(relationshipNoteText) ||
      /relationship_context:/iu.test(String(personIntentNote ?? '')) ||
      /relationship\.kind=/iu.test(String(personIntentNote ?? '')));

  const rawConversationMentionNote = await loadPersonMentionConversationContext({
    supabase: (args as any).supabase,
    userCode: args.userCode,
    aliases,
    currentConversationId: args.conversationId ?? null,
  });

  const rawLongTermNote = await loadPersonLongTermContext({
    supabase: (args as any).supabase,
    userCode: args.userCode,
    aliases,
  });

  const conversationMentionNote =
    stripUnsupportedQuotedClaimsFromContextNote(
      rawConversationMentionNote,
      args.userText,
    );

  const longTermNote =
    stripUnsupportedQuotedClaimsFromContextNote(
      rawLongTermNote,
      args.userText,
    );

  const hasAnySource =
    Boolean(personIntentNote) ||
    hasRelationshipContext ||
    Boolean(diagnosisText) ||
    Boolean(conversationMentionNote) ||
    Boolean(longTermNote);

  if (!hasAnySource) {
    console.log('[IROS/PRE_SEED_PERSON_CONTEXT][NO_SOURCE]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      targetLabel,
      targetKey,
      aliases,
      hasConversationMentions: Boolean(conversationMentionNote),
      hasLongTerm: Boolean(longTermNote),
    });

    return null;
  }

  const seedText = buildPersonContextSeed({
    userText: args.userText,
    targetLabel,
    targetKey,
    aliases,
    relationId,
    personIntentNote,
    relationshipNoteText,
    diagnosisText: diagnosisText || null,
    conversationMentionNote,
    longTermNote,
  });
  const cognitionMapSourceKind =
    hasRelationshipContext && !personIntentNote ? 'relationship_memory' : 'person_context';

  const cognitionMapSourceText = [
    personIntentNote ? `PERSON_STATE:\n${personIntentNote}` : '',
    hasRelationshipContext && relationshipNoteText ? `RELATIONSHIP_MEMORY:\n${relationshipNoteText}` : '',
    diagnosisText ? `IR_DIAGNOSIS:\n${diagnosisText}` : '',
    conversationMentionNote ? `CONVERSATION_MENTIONS:\n${conversationMentionNote}` : '',
    longTermNote ? `LONG_TERM_CONTEXT:\n${longTermNote}` : '',
  ].filter(Boolean).join('\n\n') || seedText;

  const cognitionMap = buildCognitionMap({
    userText: args.userText,
    targetLabel,
    targetKey,
    sourceKind: cognitionMapSourceKind,
    sourceText: cognitionMapSourceText,
    debug: {
      source: 'buildPersonContextPreSeed',
      relationId,
      hasPersonIntent: Boolean(personIntentNote),
      hasRelationship: hasRelationshipContext,
      hasDiagnosis: Boolean(diagnosisText),
      hasConversationMentions: Boolean(conversationMentionNote),
      hasLongTerm: Boolean(longTermNote),
      exposeRelationshipContext,
    },
  });

  const cognitionMapSeedText = cognitionMapToSeedText(cognitionMap);

  const tcfStarter = buildPreSeedTcfStarter({
    userText: args.userText,
    decisionKind: 'person_reference',
    sourceAuthority: hasRelationshipContext ? 'relationship_memory' : 'person_context',
    cognitionMap,
  });
  console.log('[IROS/PRE_SEED_PERSON_CONTEXT][SOURCE_DEBUG]', {
    traceId: args.traceId ?? null,
    targetLabel,
    targetKey,
    personIntentNoteHead: String(personIntentNote ?? '').slice(0, 1000),
    relationshipNoteHead: String(relationshipNoteText ?? '').slice(0, 600),
    diagnosisTextHead: String(diagnosisText ?? '').slice(0, 600),
    conversationMentionHead: String(conversationMentionNote ?? '').slice(0, 1600),
    longTermHead: String(longTermNote ?? '').slice(0, 600),
  });
  const directReply =
    (await buildVisiblePersonContextReplyWithLlm({
      userText: args.userText,
      targetLabel,
      seedText,
      personIntentNote: exposeRelationshipContext
        ? personIntentNote
        : stripRelationshipContextFromPersonIntentNote(personIntentNote),
      relationshipNoteText: exposeRelationshipContext ? relationshipNoteText : null,
      diagnosisText: diagnosisText || null,
      conversationMentionNote,
      longTermNote,
    })) ??
    buildVisiblePersonContextReply({
      targetLabel,
      personIntentNote: exposeRelationshipContext
        ? personIntentNote
        : stripRelationshipContextFromPersonIntentNote(personIntentNote),
      relationshipNoteText: exposeRelationshipContext ? relationshipNoteText : null,
      diagnosisText: diagnosisText || null,
    });

  console.log('[IROS/PRE_SEED_PERSON_CONTEXT][FOUND]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode,
    targetLabel,
    targetKey,
    aliases,
    relationId,
    hasPersonIntent: Boolean(personIntentNote),
    hasRelationship: hasRelationshipContext,
    hasDiagnosis: Boolean(diagnosisText),
    hasConversationMentions: Boolean(conversationMentionNote),
    hasLongTerm: Boolean(longTermNote),
    conversationMentionLen: String(conversationMentionNote ?? '').length,
    longTermLen: String(longTermNote ?? '').length,
    isFactQuestion: isPersonFactQuestionText(args.userText),
    exposeRelationshipContext,
    directReplyLen: directReply.length,
    seedLen: seedText.length,
  });

  return {
    kind: 'person_reference',
    confidence: personIntentNote ? 0.86 : 0.78,

    sourceAuthority: personIntentNote
      ? 'memory_state'
      : relationshipNoteText
        ? 'relationship_memory'
        : 'ir_diagnosis_text',
    sourceKind: personIntentNote
      ? 'person_intent_state'
      : relationshipNoteText
        ? 'relationship_memory'
        : 'ir_diagnosis_snapshot',
    sourceId: relationId,
    sourceText: seedText,

    route: 'normal_writer',

    seedText,
    directReply,
    writerInput: {
      kind: 'person_context_summary',
      userText: args.userText,
      seedText,
      targetLabel,
      targetKey,
      sourceKind: personIntentNote
        ? 'person_intent_state'
        : relationshipNoteText
          ? 'relationship_memory'
          : 'ir_diagnosis_snapshot',
    } as any,

    shouldBypassWriter: true,
    shouldBypassRephrase: true,
    shouldUsePreSeedWriter: false,

    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: true,
    shouldSuppressMemoryDelta: true,
    shouldSuppressIntuitionCandidate: true,
    shouldSuppressNormalResonance: true,

    shouldOpenContextThread: false,
    contextThreadCode: null,

    ctxPackPatch: {
      personContextRecall: true,
      memoryIntent: 'person_state_recall',
      memorySpace: 'person',
      sourceAuthority: personIntentNote
        ? 'person_intent_state'
        : relationshipNoteText
          ? 'relationship_memory'
          : 'ir_diagnosis_text',
      resolvedTarget: {
        status: 'resolved',
        label: targetLabel,
        targetKey,
        canonicalName: targetLabel,
        aliases,
        nicknameMatched: null,
        domain: 'person',
        confidence: 0.86,
        source: 'explicit_user_text',
      },
      resolvedRelation: relationId
        ? {
            status: 'resolved',
            relationId,
            displayName: targetLabel,
            selfLabel: 'user',
            otherLabel: targetLabel,
            targetKey,
            relationRole: 'unknown',
            confidence: 0.72,
            source: 'explicit_user_text',
          }
        : null,
      personIntentState: personIntent,
      memorySeedText: seedText,
      memoryPreSeedText: seedText,
      personContextSeedText: seedText,
      shouldSuppressSimilarFlow: true,
      similarFlowSeed: '',
      similarFlowDebug: null,
    },

    metaPatch: {
      personContextRecall: true,
      memoryIntent: 'person_state_recall',
      memorySpace: 'person',
      personIntentState: personIntent,
      memorySeedText: seedText,
      memoryPreSeedText: seedText,
      personContextSeedText: seedText,
      shouldSuppressSimilarFlow: true,
    },

    debug: {
      reason: 'person_context_preseed_connected',
      matchedPattern: 'person_name_or_nickname_summary',
      sourceTextHead: seedText.slice(0, 160),
      seedHead: seedText.slice(0, 160),
    },
  };
}






















