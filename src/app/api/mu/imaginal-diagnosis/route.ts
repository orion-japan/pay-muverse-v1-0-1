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

type ImaginalDiagnosisSeed = {
  version: 'imaginal_diagnosis_seed_v2';
  pre_seed: ImaginalPreSeed;
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

  const futureBase = normalizeFutureBase(continued.future_base);
  const futureLabel = normalizeFutureLabel(continued.future_label, futureBase);
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
  const facts = preSeed.image_observation.visible_facts.join(' / ');
  const attention = preSeed.attention_point;

  const e_turn =
    base === 'creation' ? 'e4'
    : base === 'comparison' ? 'e3'
    : base === 'destruction' ? 'e2'
    : 'e1';

  const yure =
    base === 'destruction' ? 'high'
    : base === 'anxiety' || base === 'comparison' ? 'middle'
    : 'low';

  const margin =
    base === 'creation' ? 'medium'
    : base === 'unknown' ? 'small'
    : 'small';

  return {
    e_turn,
    polarity: base === 'creation' ? 'pos' : base === 'unknown' ? 'mixed' : 'neg',
    yure,
    margin,
    state_summary: [
      `思い続けている未来は「${preSeed.continued_future_seed.copy_seed}」です。`,
      `場面としては「${preSeed.continued_future_seed.future_scene}」を先に見ています。`,
      `そのため今は、${attention}に反応が集まりやすい状態です。`,
      facts ? `見えている事実は ${facts} です。` : '',
    ].filter(Boolean).join(' '),
    state_hold_reason: preSeed.continued_future_seed.direction_reason,
  };
}

function inferWishedFutureTransfer(preSeed: ImaginalPreSeed): WishedFutureTransferSeed {
  const wished = preSeed.wished_future_seed.wished_future;
  const wishedScene = preSeed.wished_future_seed.wished_future_scene;
  const continuedCopy = preSeed.continued_future_seed.copy_seed;
  const base = preSeed.continued_future_seed.future_base;

  const wordShift =
    base === 'comparison'
      ? `反応で価値を測る言葉から、「${wishedScene}」を先に置く言葉へ変える`
      : base === 'destruction'
        ? `壊れる前に閉じる言葉から、「${wishedScene}」を守る一言へ変える`
        : base === 'creation'
          ? `すでに出ている創造の言葉を、「${wishedScene}」に向かう一文へ絞る`
          : `不安を確かめる言葉から、「${wishedScene}」を先に置く言葉へ変える`;

  const actionShift =
    base === 'comparison'
      ? '見比べて確かめ続ける行動を減らし、小さく置く・届ける・進める行動に変える'
      : base === 'destruction'
        ? '先に断ち切る行動ではなく、境界線を持って一度だけ伝え、自分の場へ戻る行動に変える'
        : base === 'creation'
          ? '思いつきを保存するだけでなく、今日ひとつ公開・送信・実行する'
          : '反応を待ち続ける行動から、一度だけ未来を置いて自分の時間へ戻る行動に変える';

  return {
    wished_future_direction: wished,
    transfer_direction: `「${continuedCopy}」を見続ける位置から、「${wishedScene}」を先に置く位置へ移る`,
    required_word_shift: wordShift,
    required_action_shift: actionShift,
    changed_future: `言葉と行動が変わることで、「${wishedScene}」という未来が現実に近づきます。`,
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

async function buildStructuralDiagnosisSeedFromLlm(params: {
  apiKey: string;
  model: string;
  sourceSeed: ImaginalDiagnosisSeed;
}): Promise<Record<string, unknown>> {
  const { apiKey, model, sourceSeed } = params;

  const system = [
    'あなたはMuverseのイマジナル診断Seedを、構造Seedへ変換する専門器です。',
    '入力には画像由来の観測や具体語が含まれる場合がありますが、出力には絶対に残さないでください。',
    '出力に、スクショ内の文字、相手名、時刻、既読、未読、通話、No answer、Missed、ミーティング、電話、掛け直し、本文引用などを書いてはいけません。',
    '出力するのは、未来の方向、フローの状態、移管の状態だけです。',
    '未来の方向は、出来事説明ではなく「このまま続いた先に見ている未来」にしてください。',
    '願っている未来は、相手を動かす未来ではなく、ユーザーが置きたい未来の方向にしてください。',
    'flow_state_seed は、今の反応の状態を、抽象化して書いてください。',
    'transfer_state_seed は、どの未来からどの未来へ移管するかを書いてください。',
    '出力はJSONのみです。',
    'JSONは version, scope, future_direction_seed, flow_state_seed, transfer_state_seed, writer_directives を持ってください。',
    'version は imaginal_diagnosis_seed_v3、scope は future_direction_flow_transfer です。',
    'future_direction_seed は continued_future_direction, continued_future_label, future_base, wished_future_direction, direction_gap, imaginal_copy_seed, direction_reason を持ってください。',
    'flow_state_seed は e_turn, polarity, yure, margin, current_state, state_hold_reason を持ってください。',
    'transfer_state_seed は transfer_from, transfer_to, word_shift, action_shift, field_shift を持ってください。',
    'imaginal_copy_seed は必ず「不安の未来」「破壊の未来」「比較の未来」「創造の未来」のいずれかで閉じてください。',
    '良い例: このまま安心を外側に預け、私だけ待つ側に残される不安の未来。',
    '悪い例: 既読だけが残り、No answerが続く不安の未来。これはスクショ内容が残っています。',
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
            '以下のSeedを、スクショ内容を完全に落とした構造Seedへ変換してください。',
            JSON.stringify(sourceSeed, null, 2),
          ].join('\n\n'),
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[mu-imaginal-diagnosis] structural seed LLM error:', detail.slice(0, 500));
    throw new Error('structural_seed_failed');
  }

  const data = await res.json().catch(() => ({}));
  const raw = extractAssistantContent(data);
  const parsed = safeParseJsonObject(raw);

  const futureRaw = parsed.future_direction_seed && typeof parsed.future_direction_seed === 'object'
    ? parsed.future_direction_seed as Record<string, unknown>
    : {};
  const flowRaw = parsed.flow_state_seed && typeof parsed.flow_state_seed === 'object'
    ? parsed.flow_state_seed as Record<string, unknown>
    : {};
  const transferRaw = parsed.transfer_state_seed && typeof parsed.transfer_state_seed === 'object'
    ? parsed.transfer_state_seed as Record<string, unknown>
    : {};

  const futureBase = normalizeFutureBase(futureRaw.future_base);
  const futureLabel = normalizeFutureLabel(futureRaw.continued_future_label, futureBase);
  const continuedFuture = cleanString(
    futureRaw.continued_future_direction,
    'このまま安心を外側に預け、私だけ待つ側に残される'
  );
  const wishedFuture = cleanString(
    futureRaw.wished_future_direction,
    '外側の反応に左右されず、関係の場が戻る未来を先に置ける'
  );
  const copySeed = normalizeCopySeed(futureRaw.imaginal_copy_seed, continuedFuture, futureLabel);

  return {
    version: 'imaginal_diagnosis_seed_v3',
    scope: 'future_direction_flow_transfer',
    future_direction_seed: {
      continued_future_direction: continuedFuture,
      continued_future_label: futureLabel,
      future_base: futureBase,
      wished_future_direction: wishedFuture,
      direction_gap: cleanString(
        futureRaw.direction_gap,
        '願っている未来へ向かいたいのに、思い続けている未来が先に立ち上がっている'
      ),
      imaginal_copy_seed: copySeed,
      direction_reason: cleanString(
        futureRaw.direction_reason,
        '安心の基準が外側の反応へ寄っているため'
      ),
    },
    flow_state_seed: {
      e_turn: normalizeEnum(flowRaw.e_turn, ['e1', 'e2', 'e3', 'e4', 'e5'] as const, 'e1'),
      polarity: normalizeEnum(flowRaw.polarity, ['pos', 'neg', 'mixed'] as const, futureBase === 'creation' ? 'pos' : 'neg'),
      yure: normalizeEnum(flowRaw.yure, ['low', 'middle', 'high'] as const, futureBase === 'destruction' ? 'high' : 'middle'),
      margin: normalizeEnum(flowRaw.margin, ['none', 'small', 'medium', 'large'] as const, 'small'),
      current_state: cleanString(
        flowRaw.current_state,
        `「${copySeed}」を先に見ているため、安心の基準が外側へ寄り、内側の余白が狭くなっている状態`
      ),
      state_hold_reason: cleanString(
        flowRaw.state_hold_reason,
        '未来の方向が変わらない限り、言葉と行動が確認へ戻りやすいため'
      ),
    },
    transfer_state_seed: {
      transfer_from: cleanString(transferRaw.transfer_from, copySeed),
      transfer_to: cleanString(transferRaw.transfer_to, wishedFuture),
      word_shift: cleanString(
        transferRaw.word_shift,
        `「${copySeed}」を確かめる言葉から、「${wishedFuture}」を先に置く言葉へ移す`
      ),
      action_shift: cleanString(
        transferRaw.action_shift,
        '外側の反応を追い続ける行動から、一度置いて自分の場へ戻る行動へ移す'
      ),
      field_shift: cleanString(
        transferRaw.field_shift,
        '待つことで安心を得る場から、未来を先に置いて安心を戻す場へ移る'
      ),
    },
    writer_directives: [
      '画像内容を説明しない',
      'スクショ内の文字、既読、通話、時刻、相手名などを正本にしない',
      '未来の方向を正本にする',
      'フローの状態を正本にする',
      '移管の状態を正本にする',
      '相手の気持ちは断定しない',
      '診断文は5項目で返す',
    ],
  };
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

    const diagnosisSeed: ImaginalDiagnosisSeed = {
      version: 'imaginal_diagnosis_seed_v2',
      pre_seed: preSeed,
      continued_future_flow_seed: continuedFutureFlowSeed,
      wished_future_transfer_seed: wishedFutureTransferSeed,
      writer_directives: [
        'Mu文体で返す',
        '画像を見直さない',
        'PreSeedとFlow結果だけを正本にする',
        'copy_seedをイマジナルコピーの正本にする',
        'wished_future_sceneを願っている未来の正本にする',
        'future_sceneを思い続けている未来の正本にする',
        '相手の気持ちは断定しない',
        '相手の具体的なセリフを指定しない',
        '画像にない場所・姿勢・生活状況を足さない',
        '確認の未来、受け取りの未来、境界線の未来、混在の未来、不明の未来を表示しない',
        '診断文は5項目で返す',
      ],
    };


    const structuralDiagnosisSeed = await buildStructuralDiagnosisSeedFromLlm({ apiKey, model, sourceSeed: diagnosisSeed });

    const writerSystem = [
      'あなたはMuverseの新イマジナル診断のWriterです。',
      '渡されたSeedだけを正本にしてください。画像を見直さないでください。スクショ内容を説明しないでください。',
      '診断文は、必ず次の5項目で書いてください。',
      '① イマジナルコピー',
      '② 願っている未来',
      '③ 思い続けている未来',
      '④ くり返す出来事や起こりえる出来事',
      '⑤ 未来を変える言葉と行動',
      '① イマジナルコピーは future_direction_seed.imaginal_copy_seed を正本にしてください。',
      '② 願っている未来は future_direction_seed.wished_future_direction を正本にしてください。相手のセリフや相手を動かす文にしないでください。',
      '③ 思い続けている未来は future_direction_seed.continued_future_direction と future_direction_seed.imaginal_copy_seed を正本にしてください。',
      '④ くり返す出来事は flow_state_seed.current_state と flow_state_seed.state_hold_reason から、続きやすい流れを書いてください。スクショ説明に戻らないでください。4文以内にしてください。',
      '⑤ 未来を変える言葉と行動は transfer_state_seed.word_shift と transfer_state_seed.action_shift と transfer_state_seed.field_shift から書いてください。返信マニュアルにしないでください。',
      '「確認の未来」「受け取りの未来」「境界線の未来」「混在の未来」「不明の未来」は表示しないでください。',
      '相手の気持ち、相手の未来、相手の人格を断定しないでください。',
      '誰にでも当てはまる抽象語だけで終わらせないでください。',
      '「既読の向こうで、私が先に進む瞬間」のような、未来分類で閉じていないコピーは禁止です。',
      '出力はJSONのみ。diagnosis にユーザー表示用診断文を入れてください。',
      '診断文の最後には必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」を入れてください。',
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
              JSON.stringify(structuralDiagnosisSeed, null, 2),
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
        diagnosisSeedJson: structuralDiagnosisSeed as any,
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
      diagnosis_seed: structuralDiagnosisSeed,
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


