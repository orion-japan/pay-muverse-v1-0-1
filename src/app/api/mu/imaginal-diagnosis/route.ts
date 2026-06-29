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

function normalizeDiagnosisText(value: unknown, seed: any): string {
  const raw = cleanString(value);

  const future = seed?.future_direction_seed && typeof seed.future_direction_seed === 'object'
    ? seed.future_direction_seed
    : {};
  const flow = seed?.flow_state_seed && typeof seed.flow_state_seed === 'object'
    ? seed.flow_state_seed
    : {};
  const transfer = seed?.transfer_state_seed && typeof seed.transfer_state_seed === 'object'
    ? seed.transfer_state_seed
    : {};

  const fallback = [
    'Muのイマジナル診断',
    '',
    'イマジナルコピー',
    cleanString(future.imaginal_copy_seed, '願う未来へ進みたいのに、不安の未来を見ている'),
    '',
    '願っている未来',
    cleanString(future.wished_future_direction, '自分の時間と安心を自分の側へ戻せる未来'),
    '',
    '思い続けている未来',
    cleanString(future.continued_future_direction, '安心の基準を外側に預けたまま進む不安の未来'),
    '',
    'くり返す出来事や起こりえる出来事',
    cleanString(flow.current_state, '外側の変化を基準にして、自分の余白が狭くなりやすい状態が続きます。'),
    '',
    '未来を変える言葉と行動',
    [
      cleanString(transfer.word_shift, '外側を確かめる言葉から、自分の場を戻す言葉へ移す。'),
      cleanString(transfer.action_shift, '外側を追う行動から、自分の時間を先に守る行動へ移す。'),
      cleanString(transfer.field_shift, '外側待ちの場から、自分の未来を先に置く場へ移る。'),
    ].join('\n'),
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

    const directStructuralSeedSystem = [
      'あなたはMuverseの新イマジナル診断のSeed生成器です。',
      '画像は入口としてだけ扱います。画像の説明、スクショの中身、文字、時刻、相手名、既読、未読、通話、電話、折り返し、No answer、Missed、ミーティング、返信、連絡、一報、待ち続ける、反応の欠如をSeedに残してはいけません。',
      '画像から、表面的な出来事ではなく、ユーザーの中で立ち上がっている未来の方向、フローの状態、移管の状態だけをSeed化してください。',
      '相手の気持ち、相手の未来、相手の人格は断定しないでください。',
      '診断文は書かないでください。出力はJSONのみです。',
      'JSONは version, scope, future_direction_seed, flow_state_seed, transfer_state_seed, writer_directives を持ってください。',
      'version は imaginal_diagnosis_seed_v3、scope は future_direction_flow_transfer です。',
      'future_direction_seed は continued_future_direction, continued_future_label, future_base, wished_future_direction, direction_gap, imaginal_copy_seed, direction_reason を持ってください。',
      'continued_future_label は「不安の未来」「破壊の未来」「比較の未来」「創造の未来」のいずれかです。',
      'future_base は anxiety, destruction, comparison, creation, unknown のいずれかです。',
      'imaginal_copy_seed は、思い続けている未来と願っている未来の差分を短く表す一文です。末尾は必ず「不安の未来」「破壊の未来」「比較の未来」「創造の未来」のいずれかにしてください。',
      'imaginal_copy_seed は分類名だけにしないでください。',
      'flow_state_seed は e_turn, polarity, yure, margin, current_state, state_hold_reason を持ってください。',
      'transfer_state_seed は transfer_from, transfer_to, word_shift, action_shift, field_shift を持ってください。',
      'current_state は、出来事説明ではなく、ユーザーのフロー状態として書いてください。',
      'transfer_from と transfer_to は、どの未来からどの未来へ移るかを書いてください。',
      'word_shift は、どんな言葉へ移すかを書いてください。',
      'action_shift は、どんな行動へ移すかを書いてください。',
      'field_shift は、どんな場へ移すかを書いてください。',
      '表示してはいけない未来名: 確認の未来、受け取りの未来、境界線の未来、混在の未来、不明の未来。',
    ].join('\n');

    const directSeedRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: directStructuralSeedSystem },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'この画像を入口にして、診断文ではなく structuralDiagnosisSeed JSON だけを作ってください。画像内容の説明やスクショ内の具体語はSeedに残さないでください。',
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

    if (!directSeedRes.ok) {
      const detail = await directSeedRes.text().catch(() => '');
      console.error('[mu-imaginal-diagnosis] direct structural seed LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const directSeedData = await directSeedRes.json().catch(() => ({}));
    const rawDirectSeed = extractAssistantContent(directSeedData);

    if (!rawDirectSeed) {
      return json({ ok: false, error: 'empty_structural_seed' }, 502);
    }

    const parsedDirectSeed = safeParseJsonObject(rawDirectSeed);

    const futureRaw = parsedDirectSeed.future_direction_seed && typeof parsedDirectSeed.future_direction_seed === 'object'
      ? parsedDirectSeed.future_direction_seed as Record<string, unknown>
      : {};
    const flowRaw = parsedDirectSeed.flow_state_seed && typeof parsedDirectSeed.flow_state_seed === 'object'
      ? parsedDirectSeed.flow_state_seed as Record<string, unknown>
      : {};
    const transferRaw = parsedDirectSeed.transfer_state_seed && typeof parsedDirectSeed.transfer_state_seed === 'object'
      ? parsedDirectSeed.transfer_state_seed as Record<string, unknown>
      : {};

    const futureBase = normalizeFutureBase(futureRaw.future_base);
    const futureLabel = normalizeFutureLabel(futureRaw.continued_future_label, futureBase);
    const continuedFuture = cleanString(
      futureRaw.continued_future_direction,
      '安心の基準を外側に預けたまま、自分の時間がほどけていく'
    );
    const wishedFuture = cleanString(
      futureRaw.wished_future_direction,
      '自分の時間と安心を自分の側へ戻せる'
    );
    let copySeed = normalizeCopySeed(futureRaw.imaginal_copy_seed, continuedFuture, futureLabel);
    const copyBody = stripFutureLabel(copySeed);
    if (!copyBody || copyBody.length < 8) {
      copySeed = normalizeCopySeed(continuedFuture, continuedFuture, futureLabel);
    }

    const structuralDiagnosisSeed = {
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
          '安心の基準が外側へ置かれ、自分の場が狭くなっているため'
        ),
      },
      flow_state_seed: {
        e_turn: normalizeEnum(flowRaw.e_turn, ['e1', 'e2', 'e3', 'e4', 'e5'] as const, 'e1'),
        polarity: normalizeEnum(flowRaw.polarity, ['pos', 'neg', 'mixed'] as const, futureBase === 'creation' ? 'pos' : 'mixed'),
        yure: normalizeEnum(flowRaw.yure, ['low', 'middle', 'high'] as const, 'middle'),
        margin: normalizeEnum(flowRaw.margin, ['none', 'small', 'medium', 'large'] as const, 'small'),
        current_state: cleanString(
          flowRaw.current_state,
          '外側の変化を基準にして、自分の余白が狭くなっている状態'
        ),
        state_hold_reason: cleanString(
          flowRaw.state_hold_reason,
          '安心の起点が自分の側ではなく、外側の変化に置かれているため'
        ),
      },
      transfer_state_seed: {
        transfer_from: cleanString(transferRaw.transfer_from, continuedFuture),
        transfer_to: cleanString(transferRaw.transfer_to, wishedFuture),
        word_shift: cleanString(
          transferRaw.word_shift,
          '外側を確かめる言葉から、自分の場を戻す言葉へ移す'
        ),
        action_shift: cleanString(
          transferRaw.action_shift,
          '外側を追う行動から、自分の時間を先に守る行動へ移す'
        ),
        field_shift: cleanString(
          transferRaw.field_shift,
          '外側待ちの場から、自分の未来を先に置く場へ移る'
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
    const diagnosis = normalizeDiagnosisText(writerJson.diagnosis, structuralDiagnosisSeed);

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


