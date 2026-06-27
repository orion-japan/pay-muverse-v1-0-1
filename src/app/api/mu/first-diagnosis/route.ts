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
import {
  enforceImaginalCopyFromIntention,
  type ImaginalIntentionLayer,
} from '@/lib/iros/imaginal/imaginalCopySeed';
import {
  applyImaginalFlowSeed,
  type ImaginalFlowSeedLike,
} from '@/lib/iros/imaginal/imaginalFlowSeed';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type ImaginalDiagnosisSeed = ImaginalFlowSeedLike & {
  kind?: 'imaginal_first';
  imaginal_copy?: string;
  visible_wish?: string;
  seen_future?: string;
  word_reaction?: string;
  action_reaction?: string;
  intention_layer?: ImaginalIntentionLayer;
  dominant_field?: 'anxiety' | 'comparison' | 'destruction' | 'creation' | 'unknown';
  creative_direction?: string;
  today_step?: string;
  image_type?:
    | 'line_or_dm'
    | 'email'
    | 'memo'
    | 'todo'
    | 'post_draft'
    | 'book_page'
    | 'application_page'
    | 'other';
  evidence_points?: string[];
  uncertain_points?: string[];
  user_name_candidate?: string;
  writer_directives?: string[];
};

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

function cleanString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const s = value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join('、');
    return s || undefined;
  }

  const s = String(value ?? '').trim();
  return s || undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length ? items : undefined;
}

function normalizeDominantField(value: unknown): ImaginalDiagnosisSeed['dominant_field'] {
  const v = String(value ?? '').trim();
  if (v === 'anxiety' || v === 'comparison' || v === 'destruction' || v === 'creation') return v;
  return 'unknown';
}

function normalizeImageType(value: unknown): ImaginalDiagnosisSeed['image_type'] {
  const v = String(value ?? '').trim();
  if (
    v === 'line_or_dm' ||
    v === 'email' ||
    v === 'memo' ||
    v === 'todo' ||
    v === 'post_draft' ||
    v === 'book_page' ||
    v === 'application_page' ||
    v === 'other'
  ) {
    return v;
  }
  return 'other';
}

function normalizeIntentionLayer(value: unknown): ImaginalIntentionLayer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const layer: ImaginalIntentionLayer = {
    received_meaning: cleanString(v.received_meaning ?? v.receivedMeaning),
    seen_future: cleanString(v.seen_future ?? v.seenFuture),
    hidden_intention: cleanString(v.hidden_intention ?? v.hiddenIntention),
    future_distortion: cleanString(v.future_distortion ?? v.futureDistortion),
  };

  return Object.values(layer).some(Boolean) ? layer : undefined;
}

function normalizeDiagnosisScope(value: unknown): ImaginalDiagnosisSeed['diagnosis_scope'] | undefined {
  return String(value ?? '').trim() === 'current_imaginal' ? 'current_imaginal' : undefined;
}

function normalizeFlowPriority(value: unknown): true | undefined {
  return value === true || String(value ?? '').trim() === 'true' ? true : undefined;
}

function buildDisplayText(seed: ImaginalDiagnosisSeed, fallback: string): string {
  const copy = cleanString(seed.imaginal_copy);
  if (!copy) return fallback;

  return [
    'あなたのイマジナルコピー',
    copy,
    '',
    'いま見えている願い',
    cleanString(seed.visible_wish) || 'いまの画像から見える範囲で、あなたが向かいたい方向を読んでいます。',
    '',
    '見続けている未来',
    cleanString(seed.seen_future) || '願いとは別に、先に見てしまっている未来を読んでいます。',
    '',
    '言葉に出ている反応',
    cleanString(seed.word_reaction) || '言葉の出方に出ている反応を、見えている範囲で映します。',
    '',
    '行動に出ている反応',
    cleanString(seed.action_reaction) || '行動の止まり方や動き方に出ている反応を見ます。',
    '',
    '創造の方向',
    cleanString(seed.creative_direction) || '今は、見続けている未来を少しずつ創造の方向へ戻すことです。',
    '',
    '今日の小さな一歩',
    cleanString(seed.today_step) || '今日できる小さな一歩を、無理のない形でひとつ選んでください。',
    '',
    'これは、画像をきっかけに見えた「今現在のイマジナル」です。',
  ].join('\n');
}

function safeParseDiagnosis(raw: string): {
  displayText: string;
  seed: ImaginalDiagnosisSeed | null;
} {
  const fallback = { displayText: raw, seed: null };

  try {
    const parsed = JSON.parse(raw.trim());
    const seedRaw = parsed?.seed && typeof parsed.seed === 'object' && !Array.isArray(parsed.seed)
      ? parsed.seed
      : parsed;

    const seed: ImaginalDiagnosisSeed = {
      kind: 'imaginal_first',
      imaginal_copy: cleanString(seedRaw?.imaginal_copy ?? seedRaw?.imaginalCopy),
      visible_wish: cleanString(seedRaw?.visible_wish ?? seedRaw?.visibleWish),
      seen_future: cleanString(seedRaw?.seen_future ?? seedRaw?.seenFuture),
      word_reaction: cleanString(seedRaw?.word_reaction ?? seedRaw?.wordReaction),
      action_reaction: cleanString(seedRaw?.action_reaction ?? seedRaw?.actionReaction),
      intention_layer: normalizeIntentionLayer(seedRaw?.intention_layer ?? seedRaw?.intentionLayer),
      diagnosis_scope: normalizeDiagnosisScope(seedRaw?.diagnosis_scope ?? seedRaw?.diagnosisScope),
      flow_priority: normalizeFlowPriority(seedRaw?.flow_priority ?? seedRaw?.flowPriority),
      image_seed: seedRaw?.image_seed ?? seedRaw?.imageSeed,
      current_flow_input_seed: seedRaw?.current_flow_input_seed ?? seedRaw?.currentFlowInputSeed,
      second_flow_input_seed: seedRaw?.second_flow_input_seed ?? seedRaw?.secondFlowInputSeed,
      dominant_field: normalizeDominantField(seedRaw?.dominant_field ?? seedRaw?.dominantField),
      creative_direction: cleanString(seedRaw?.creative_direction ?? seedRaw?.creativeDirection),
      today_step: cleanString(seedRaw?.today_step ?? seedRaw?.todayStep),
      image_type: normalizeImageType(seedRaw?.image_type ?? seedRaw?.imageType),
      evidence_points: cleanStringArray(seedRaw?.evidence_points ?? seedRaw?.evidencePoints),
      uncertain_points: cleanStringArray(seedRaw?.uncertain_points ?? seedRaw?.uncertainPoints),
      user_name_candidate: cleanString(seedRaw?.user_name_candidate ?? seedRaw?.userNameCandidate) || '',
      writer_directives: [
        'Mu文体で返す',
        '説明調にしない',
        '相手の気持ちは断定しない',
        '画像は補助として扱う',
        '正本は今現在のフローと状態移管に置く',
        '画像から読み取れないことは言い切らない',
        'イマジナルコピーを正本として扱う',
        '創造の方向へ戻す',
      ],
    };

    Object.assign(seed, applyImaginalFlowSeed(seed));

    const enforcedSeed = enforceImaginalCopyFromIntention(seed);
    seed.imaginal_copy = enforcedSeed.imaginal_copy;
    seed.seen_future = enforcedSeed.seen_future;
    seed.intention_layer = enforcedSeed.intention_layer;

    const displayText = buildDisplayText(seed, raw);

    return { displayText, seed };
  } catch {
    return fallback;
  }
}

function normalizeWriterDisplayText(value: unknown, fallback: string): string {
  const text = cleanString(value);
  const base = text || fallback;
  const note = 'これは、画像をきっかけに見えた「今現在のイマジナル」です。';
  const withoutNote = base.replace(/これは、画像をきっかけに見えた「今現在のイマジナル」です。\s*/gu, '').trim();
  return [withoutNote, note].filter(Boolean).join('\n\n').trim();
}

async function writeDiagnosisFromSeed(params: {
  apiKey: string;
  model: string;
  seed: ImaginalDiagnosisSeed | null;
  fallback: string;
}): Promise<string> {
  const { apiKey, model, seed, fallback } = params;
  if (!seed?.imaginal_flow_seed) return normalizeWriterDisplayText(fallback, fallback);

  const writerModel = process.env.MU_FIRST_DIAGNOSIS_WRITER_MODEL || model;
  const writerSystem = [
    'あなたはMuverseの初回イマジナル診断のWriterです。',
    '前段の画像観測とフロー判定Seedだけを正本にして、ユーザー表示用の診断文を書いてください。',
    '画像を新しく読み直さないでください。意味を追加せず、渡されたSeedから自然な日本語にしてください。',
    '注意書きは必ず一番最後に置いてください。',
    '最後の1行は必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」にしてください。',
    '「画像の内容そのものではなく、いま立ち上がっているフローをもとに見ています。」は出さないでください。',
    '相手の気持ち、未来、運命、人格を断定しないでください。',
    '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
    '出力はJSONのみ。display_text だけを持つオブジェクトにしてください。',
    'display_textには内部キー名、currentFlow、secondFlow、Seed、JSONという言葉を出さないでください。',
    '構成は、1.あなたのイマジナルコピー 2.いま見えている願い 3.見続けている未来 4.言葉に出ている反応 5.行動に出ている反応 6.創造の方向 7.今日の小さな一歩 8.注意書き。',
    '全体で900文字以内。',
  ].join('\n');

  const writerUser = [
    '以下のSeedを正本にして、初回イマジナル診断の表示文だけを作ってください。',
    JSON.stringify(seed, null, 2),
  ].join('\n');

  try {
    const writerRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: writerModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: writerSystem },
          { role: 'user', content: writerUser },
        ],
      }),
    });

    if (!writerRes.ok) {
      const detail = await writerRes.text().catch(() => '');
      console.warn('[mu-first-diagnosis] writer skipped:', detail.slice(0, 500));
      return normalizeWriterDisplayText(fallback, fallback);
    }

    const data = await writerRes.json().catch(() => ({}));
    const raw = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
    if (!raw) return normalizeWriterDisplayText(fallback, fallback);

    const parsed = JSON.parse(String(raw).trim());
    return normalizeWriterDisplayText(parsed?.display_text ?? parsed?.displayText, fallback);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] writer fatal skipped:', e?.message || e);
    return normalizeWriterDisplayText(fallback, fallback);
  }
}

async function uidToUserCode(uid: string): Promise<string | null> {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const q = await sb.from(c.table).select(c.codeCol).eq(c.uidCol, uid).maybeSingle();
    if (!q.error && q.data && q.data[c.codeCol]) return String(q.data[c.codeCol]);
  }

  return null;
}

async function consumeScreenshotCredit(userCode: string): Promise<boolean | null> {
  try {
    const { data, error } = await sb.rpc('consume_screenshot_credit', {
      p_user_code: userCode,
    });
    if (error) throw error;
    return Boolean(data);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] consume_screenshot_credit skipped:', e?.message || e);
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

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
  diagnosisText: string;
  diagnosisSeedJson: ImaginalDiagnosisSeed | null;
}) {
  try {
    const displayId = await getNextScreenshotDiagnosisDisplayId(params.userCode);
    await sb.from('mu_screenshot_diagnosis_logs').insert({
      user_code: params.userCode,
      model: params.model,
      source: params.source,
      media_code: params.mediaCode,
      display_id: displayId,
      credit_used: 1,
      diagnosis_text: params.diagnosisText,
      diagnosis_seed_json: {
        ...(params.diagnosisSeedJson ?? {}),
        kind: 'imaginal_first',
        diagnosis_scope: 'current_imaginal',
        flow_priority: true,
      },
    });
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] log skipped:', e?.message || e);
  }
}

async function resolveUserCode(req: NextRequest): Promise<{ ok: true; userCode: string } | { ok: false; response: NextResponse }> {
  const authz = await verifyFirebaseAndAuthorize(req);
  if (!authz.ok) return { ok: false, response: json({ ok: false, error: authz.error ?? 'unauthorized' }, 401) };

  const { user } = normalizeAuthz(authz);
  let userCode = user?.user_code ?? null;
  if (!userCode && authz.uid) userCode = await uidToUserCode(authz.uid);
  if (!userCode) return { ok: false, response: json({ ok: false, error: 'no_user_code' }, 401) };

  return { ok: true, userCode };
}

export async function GET(req: NextRequest) {
  try {
    const resolved = await resolveUserCode(req);
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const { data: latest, error: latestErr } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
      .eq('user_code', userCode)
      .eq('source', 'mu_first')
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) return json({ ok: false, error: 'restore_failed' }, 500);

    if (!latest?.diagnosis_text) {
      return json({ ok: true, diagnosis: null, followup_messages: [], followup_remaining: 3, user_name_candidate: null });
    }

    const { data: userRow } = await sb
      .from('users')
      .select('first_followup_credit_count')
      .eq('user_code', userCode)
      .maybeSingle();

    const { data: followups } = await sb
      .from('mu_first_followup_logs')
      .select('question, answer, created_at')
      .eq('user_code', userCode)
      .eq('diagnosis_log_id', latest.id)
      .order('created_at', { ascending: true })
      .limit(3);

    const followupMessages = Array.isArray(followups)
      ? followups.flatMap((item: any) => [
          { role: 'user', content: String(item.question || '') },
          { role: 'assistant', content: String(item.answer || '') },
        ]).filter((item: any) => item.content)
      : [];

    const seed = latest.diagnosis_seed_json && typeof latest.diagnosis_seed_json === 'object' && !Array.isArray(latest.diagnosis_seed_json)
      ? (latest.diagnosis_seed_json as ImaginalDiagnosisSeed)
      : null;

    const dbRemaining = userRow && typeof userRow.first_followup_credit_count === 'number'
      ? userRow.first_followup_credit_count
      : null;

    return json({
      ok: true,
      diagnosis: latest.diagnosis_text,
      diagnosis_seed: seed,
      followup_messages: followupMessages,
      followup_remaining: dbRemaining === null ? Math.max(0, 3 - Math.floor(followupMessages.length / 2)) : dbRemaining,
      user_name_candidate: seed?.user_name_candidate || null,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] restore fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const resolved = await resolveUserCode(req);
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const body = (await req.json().catch(() => ({}))) as {
      image_data_url?: string;
      note?: string;
      source?: string;
      media_code?: string | null;
    };

    const imageDataUrl = normalizeDataUrl(body.image_data_url);
    if (!imageDataUrl) return json({ ok: false, error: 'invalid_image' }, 400);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const creditConsumed = await consumeScreenshotCredit(userCode);
    if (creditConsumed === false) return json({ ok: false, error: 'no_screenshot_credit' }, 402);

    const model = process.env.MU_FIRST_DIAGNOSIS_MODEL || 'gpt-5-mini';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : '';

    const system = [
      'あなたはMuverseの初回イマジナル診断を行うMuです。',
      'これは一次観測です。画像から image_seed / current_flow_input_seed / second_flow_input_seed / intention_layer を作ることが主目的です。',
      '最終表示文は後段Writerが、コードで作られた imaginal_flow_seed を正本にして作ります。',
      'これは画像診断ではなく、画像を入口にした「今現在のイマジナル」の状態観測です。',
      '画像は補助入力です。正本は、ユーザーがその画像を選び、今ここに出した時点で立ち上がっているフローです。',
      '画像の表面内容とフロー解釈が食い違う場合は、フロー解釈を優先してください。ただし、人格・運命・恒常的な未来として断定しないでください。',
      'currentFlow は、今この画像を出した時点の現在状態として読んでください。secondFlow は、そこから移管しようとしている状態として読んでください。',
      'ユーザーが送った画像を見て、相手の気持ちや未来を断定するのではなく、ユーザーがいま見続けている未来の方向を読み取ってください。',
      '画像はLINEやDMとは限りません。メモ、ToDo、投稿文、告知文、メール、予定表、講座画面、Mu BOOKのページ、その他の気になる画面も対象です。',
      'OCR事前分類や会話スクショ判定は行いません。画像から読める範囲で、なぜその画面が気になっているのかを見ます。',
      'まず image_seed に、画像の表面観測、見える言葉、見える行動、緊張点、ユーザーが反応している一点を入れてください。',
      '次に current_flow_input_seed と second_flow_input_seed を作ってください。e_turn は e1/e2/e3/e4/e5、depthStage は S1〜T3、polarity は pos/neg だけを使ってください。',
      'current_flow_input_seed は「今この画像を出した時点の現在状態」、second_flow_input_seed は「そこから移管しようとしている状態」です。',
      '必ず最初に「あなたのイマジナルコピー」として、その人だけの短いコピーを1つ生成してください。',
      'イマジナルコピーは、状況の要約ではありません。画像に写っている出来事をそのまま短く言い換えるだけのコピーは禁止です。',
      'イマジナルコピーは、表面の願いではなく、その人が先に置いてしまっている未来を映してください。',
      '生成前に内部で、1.表面の出来事 2.この画像を出した現在状態 3.そこから移管しようとしている状態 4.その出来事を何の意味として受け取っているか 5.その人が先に見ている未来、の順に深めてください。',
      'imaginal_copy は必ず intention_layer.seen_future から生成してください。S層の状況説明、F層の感情説明、R層の関係説明、C層の行動説明をコピーにしてはいけません。',
      'intention_layer には received_meaning, seen_future, hidden_intention, future_distortion を入れてください。',
      'コピーには、会いたい・伝えたい・すれ違う・不安・寂しいなどの表面語をそのまま並べないでください。表面語を使う場合は、必ず一段深い構造に変換してください。',
      '良い例: 「返事待ちのベンチに、長居しすぎる未来」「相手の通知欄に、自分の時間まで置いてくる未来」「会えない事実で、自分の価値を測る未来」。',
      '悪い例: 「会いたいのに、伝えられずすれ違う未来」「不安なのに、言えない未来」「確認の空白に、予定の主導権を握っている」。これは浅い状況要約なので避けてください。',
      '文字数は18〜42文字程度。短くてもよいですが、普通の恋愛診断・性格診断・状況要約に見えるコピーは禁止です。',
      'display_text は仮文でかまいません。最終表示文は後段Writerが作ります。',
      '相手の気持ちは断定しない。画像から読み取れないことは言い切らない。スピリチュアルな断定をしない。',
      '魂、使命、覚醒、波動、宿命、前世、高次元、宇宙からのメッセージ、あなたは〇〇タイプです、必ず変わります、絶対に叶います、相手はあなたを好きです、相手は本気ではありません、は禁止です。',
      '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
      '出力はJSONのみ。Markdownや説明文を前後に付けないでください。',
      'JSONは display_text と seed を持つオブジェクトにしてください。',
      'seedには kind, diagnosis_scope, flow_priority, image_seed, current_flow_input_seed, second_flow_input_seed, imaginal_copy, visible_wish, seen_future, word_reaction, action_reaction, intention_layer, dominant_field, creative_direction, today_step, image_type, evidence_points, uncertain_points, user_name_candidate, writer_directives を入れてください。',
      'diagnosis_scope は current_imaginal、flow_priority は true にしてください。dominant_fieldは anxiety / comparison / destruction / creation / unknown のいずれか。image_typeは line_or_dm / email / memo / todo / post_draft / book_page / application_page / other のいずれか。',
    ].join('\n');

    const userText = [
      'この画像から、初回イマジナル診断の一次観測Seedを作ってください。',
      '画像は補助として扱い、この画像を出した時点の currentFlow と、そこから移管しようとしている secondFlow を必ずSeedにしてください。',
      'ユーザーに見せる診断文 display_text は仮文でよいです。本線Muへ引き継ぐ内部Seed seed を重視してください。',
      note ? `補足メモ：${note}` : '',
    ].filter(Boolean).join('\n');

    const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => '');
      console.error('[mu-first-diagnosis] LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const data = await llmRes.json().catch(() => ({}));
    const rawDiagnosis = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
    if (!rawDiagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    const parsedDiagnosis = safeParseDiagnosis(String(rawDiagnosis));
    const diagnosis = await writeDiagnosisFromSeed({
      apiKey,
      model,
      seed: parsedDiagnosis.seed,
      fallback: parsedDiagnosis.displayText,
    });
    if (!diagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_first',
      mediaCode: body.media_code || null,
      diagnosisText: diagnosis,
      diagnosisSeedJson: parsedDiagnosis.seed,
    });

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      diagnosis_seed: parsedDiagnosis.seed,
      user_name_candidate: parsedDiagnosis.seed?.user_name_candidate || null,
      credit_consumed: creditConsumed,
      model,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
