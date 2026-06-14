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

type DiagnosisSeed = {
  mirror?: string;
  position?: string;
  user_reaction?: string;
  partner_signal?: string;
  i_layer?: string;
  timing?: string;
  risk?: string;
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

async function getMuScreenshotDisplayName(userCode: string): Promise<string> {
  const { data, error } = await sb
    .from('users')
    .select('click_username')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;

  return String(data?.click_username || 'あなた').trim() || 'あなた';
}

function normalizeDiagnosisDisplayTextForUser(text: string, displayName: string): string {
  const rawName = String(displayName || 'あなた').trim() || 'あなた';
  const name =
    rawName === 'あなた' || /(?:さん|様|くん|君|ちゃん)$/.test(rawName)
      ? rawName
      : rawName + 'さん';

  return String(text || '')
    .replace(/右（ユーザー）/g, `右（${name}）`)
    .replace(/右\(ユーザー\)/g, `右（${name}）`)
    .replace(/ユーザー側/g, `${name}側`)
    .replace(/ユーザー本人/g, `${name}本人`)
    .replace(/ユーザーは/g, `${name}は`)
    .replace(/ユーザーが/g, `${name}が`)
    .replace(/ユーザーの/g, `${name}の`)
    .replace(/ユーザーに/g, `${name}に`)
    .replace(/ユーザーを/g, `${name}を`)
    .replace(/ユーザーへ/g, `${name}へ`)
    .replace(/ユーザー/g, name)
    .replace(/短時問/g, '短時間');
}
function safeParseDiagnosis(raw: string): {
  displayText: string;
  seed: DiagnosisSeed | null;
} {
  const fallback = {
    displayText: raw,
    seed: null,
  };

  try {
    const trimmed = raw.trim();
    const parsed = JSON.parse(trimmed);

    const displayText =
      typeof parsed?.display_text === 'string' && parsed.display_text.trim()
        ? parsed.display_text.trim()
        : raw;

    const seed =
      parsed?.seed && typeof parsed.seed === 'object' && !Array.isArray(parsed.seed)
        ? {
            mirror:
              typeof parsed.seed.mirror === 'string' ? parsed.seed.mirror : undefined,
            position:
              typeof parsed.seed.position === 'string' ? parsed.seed.position : undefined,
            user_reaction:
              typeof parsed.seed.user_reaction === 'string'
                ? parsed.seed.user_reaction
                : undefined,
            partner_signal:
              typeof parsed.seed.partner_signal === 'string'
                ? parsed.seed.partner_signal
                : undefined,
            i_layer:
              typeof parsed.seed.i_layer === 'string' ? parsed.seed.i_layer : undefined,
            timing:
              typeof parsed.seed.timing === 'string' ? parsed.seed.timing : undefined,
            risk:
              typeof parsed.seed.risk === 'string' ? parsed.seed.risk : undefined,
            why_this_screenshot:
              typeof parsed.seed.why_this_screenshot === 'string'
                ? parsed.seed.why_this_screenshot
                : undefined,
            user_inner_reaction:
              typeof parsed.seed.user_inner_reaction === 'string'
                ? parsed.seed.user_inner_reaction
                : undefined,
            evidence_points: Array.isArray(parsed.seed.evidence_points)
              ? parsed.seed.evidence_points
                  .filter((item: unknown) => typeof item === 'string')
                  .slice(0, 8)
              : undefined,
            uncertain_points: Array.isArray(parsed.seed.uncertain_points)
              ? parsed.seed.uncertain_points
                  .filter((item: unknown) => typeof item === 'string')
                  .slice(0, 8)
              : undefined,
            writer_directives: Array.isArray(parsed.seed.writer_directives)
              ? [
                  ...parsed.seed.writer_directives
                    .filter((item: unknown) => typeof item === 'string')
                    .slice(0, 12),
                  'Mu文体で返す',
                  '説明調にしない',
                  '見出しや箇条書きを多用しない',
                  '返信案は頼まれた時だけ出す',
                  '相手の気持ちは断定しない',
                ]
              : [
                  'Mu文体で返す',
                  '説明調にしない',
                  '見出しや箇条書きを多用しない',
                  '返信案は頼まれた時だけ出す',
                  '相手の気持ちは断定しない',
                ],
          }
        : null;

    return {
      displayText,
      seed,
    };
  } catch {
    return fallback;
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

const MU_SCREENSHOT_ALLOWED_USER_TYPES = ['premium', 'master', 'partner', 'admin'];
const MU_SCREENSHOT_CREDIT_COST = 5;

async function getMuScreenshotUserType(userCode: string): Promise<string> {
  const { data, error } = await sb
    .from('users')
    .select('click_type')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  return String(data?.click_type || 'other').toLowerCase();
}

function canUseMuScreenshotDiagnosis(userType: string): boolean {
  return MU_SCREENSHOT_ALLOWED_USER_TYPES.includes(String(userType || '').toLowerCase());
}

async function consumeMuScreenshotSofiaCredit(userCode: string): Promise<boolean | null> {
  try {
    const { data, error } = await sb.rpc('consume_mu_screenshot_sofia_credit', {
      p_user_code: userCode,
      p_amount: MU_SCREENSHOT_CREDIT_COST,
    });

    if (error) throw error;
    return Boolean(data);
  } catch (e: any) {
    console.warn('[mu-screenshot-diagnosis] consume_mu_screenshot_sofia_credit skipped:', e?.message || e);
    return null;
  }
}

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
  conversationId: string | null;
  diagnosisText: string;
  diagnosisSeedJson: DiagnosisSeed | null;
}) {
  try {
    const { data, error } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .insert({
        user_code: params.userCode,
        model: params.model,
        source: params.source,
        media_code: params.mediaCode,
        conversation_id: params.conversationId,
        credit_used: MU_SCREENSHOT_CREDIT_COST,
        diagnosis_text: params.diagnosisText,
        diagnosis_seed_json: params.diagnosisSeedJson,
      })
      .select('id')
      .single();

    if (error) throw error;
    return String(data?.id || '');
  } catch (e: any) {
    console.warn('[mu-screenshot-diagnosis] log skipped:', e?.message || e);
    return '';
  }
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
      note?: string;
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
    if (!canUseMuScreenshotDiagnosis(userType)) {
      return json({ ok: false, error: 'screenshot_diagnosis_plan_required' }, 403);
    }

    const creditConsumed = await consumeMuScreenshotSofiaCredit(userCode);
    if (creditConsumed === false) {
      return json({ ok: false, error: 'no_mu_screenshot_credit' }, 402);
    }

    if (creditConsumed === null) {
      return json({ ok: false, error: 'credit_consume_failed' }, 500);
    }

    const model = process.env.MU_SCREENSHOT_DIAGNOSIS_MODEL || 'gpt-5-mini';

    const note =
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 500)
        : '';

    const system = [
      'あなたはMu本線チャット内のスクリーンショット診断を行います。',
      '関係の読み解きとして、画像から読み取れる範囲だけを使い、会話の要約ではなく、関係の位置・反応の意味・継続している関係構造を中心に診断してください。表示文には、根拠の説明と関係の流れだけを書いてください。判断保留や断定しない材料はseed側に残してください。',
      'LINE/SNSの会話画像では、原則として右側の吹き出しを本人、左側の吹き出しを相手として読んでください。',
      'ただし、画面上の配置が不明確な場合は断定せず、「見えている範囲では」と表現してください。',
      '既読、未読、返信間隔、スタンプ、絵文字、文量、語尾、敬語/タメ口、話題の継続、相手が質問しているか、会話を閉じているかを読み取ってください。',
      '画像から確認できないことは推測で断定しないでください。',
      '相手の状態だけでなく、ユーザー側が何を確認しているように見えるかもseed側に残してください。',
      '内部では、MIRROR、POSITION、CONTINUITY、INTENTIONなどの構造読みを使ってください。ただし、display_textにはMIRROR、POSITION、CONTINUITY、INTENTION、S/R/C/I/Tなどの内部タグ名をそのまま出さず、自然な日本語に変換してください。',
      '右側=ユーザー、左側=相手というPOSITIONをSeedに必ず残してください。不明な場合は不明と残してください。',
      '相手の個人情報、年齢、職業、顔、属性などは推定しないでください。',
      '出力は必ずJSONのみ。Markdownや説明文を前後に付けないでください。',
      'JSONは display_text と seed を持つオブジェクトにしてください。display_textでは箇条書き、番号付きリスト、行頭の「-」を使わず、短い段落の文章で書いてください。',
      'display_text の見出しは必ず「内容要約」「関係の読み解き」の2つだけにしてください。表示見出しはこの2つ以外を出さないでください。関係の読み解きの本文では、内部タグ名を列挙せず、関係の位置、反応の意味、継続しているものを自然文で書いてください。見えている事実を順番に説明するだけで終わらせず、このスクショで起きている関係構造の中心を一文で掴み、そのあとに、なぜそう読めるのかを短く書いてください。',
      'display_text では「次の一歩」「次の一手」「返信案」「どう返すか」を出さないでください。それらはユーザーが求めた時だけ本線Muで返してください。',
      '返信案、送信文、文例、例文は、本線スクショ診断では、頼まれない限り出さないでください。',
      'display_text は全体で900文字以内。内容要約は最大3行までにし、関係の読み解きを本文の中心にしてください。関係の読み解きは、観察説明ではなく『このやり取りは何が返ってきている場面なのか』『右側の人は何を確かめているのか』『関係の中で何が継続しているのか』を中心にしてください。判断保留にする材料は表示せず内部Seedに残してください。',
      'seed は、mirror, position, user_reaction, partner_signal, i_layer, timing, risk, why_this_screenshot, user_inner_reaction, evidence_points, uncertain_points, writer_directives を持つJSONにしてください。why_this_screenshotには、このスクショを診断したくなった入口を短く入れてください。user_inner_reactionには、ユーザー側が何を確かめたかったように見えるかを断定せずに入れてください。evidence_pointsには画像内の根拠を配列で入れ、uncertain_pointsには断定しない点を配列で入れてください。',
      'seed.partner_signal では相手の好意を断定しないでください。display_textでも、相手が何かを求めている、期待している、依存している、と断定しないでください。見えている範囲では、感謝、報告、確認、反応として表現してください。',
      'seed.writer_directives には「Mu文体で返す」「説明調にしない」「見出しや箇条書きを多用しない」「返信案は頼まれた時だけ出す」「相手の気持ちは断定しない」「なんでわかるの？ではevidence_pointsとuser_inner_reactionを使ってやさしく説明する」を入れてください。',
    ].join('\n');

    const userText = [
      'このスクリーンショットから、本線スクショ診断として読めることを返してください。',
      'ユーザーに見せる診断文 display_text と、本線Muチャットで継続参照する内部Seed seed を同時に作ってください。',
      note ? `補足メモ：${note}` : '',
    ]
      .filter(Boolean)
      .join('\n');

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

    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => '');
      console.error('[mu-screenshot-diagnosis] LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const data = await llmRes.json().catch(() => ({}));
    const rawDiagnosis =
      data?.choices?.[0]?.message?.content?.toString?.() ??
      data?.choices?.[0]?.message?.content ??
      '';

    if (!rawDiagnosis) {
      return json({ ok: false, error: 'empty_diagnosis' }, 502);
    }

    const parsedDiagnosis = safeParseDiagnosis(String(rawDiagnosis));
    const displayName = await getMuScreenshotDisplayName(userCode);
    const diagnosis = normalizeDiagnosisDisplayTextForUser(parsedDiagnosis.displayText, displayName);

    if (!diagnosis) {
      return json({ ok: false, error: 'empty_diagnosis' }, 502);
    }

    const diagnosisLogId = await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_chat',
      mediaCode: body.media_code || null,
      conversationId: body.conversation_id || body.conversationId || null,
      diagnosisText: diagnosis,
      diagnosisSeedJson: parsedDiagnosis.seed,
    });

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      diagnosis_seed: parsedDiagnosis.seed,
      diagnosis_log_id: diagnosisLogId || null,
      source: body.source || 'mu_chat',
      credit_consumed: creditConsumed ? MU_SCREENSHOT_CREDIT_COST : null,
      model,
    });
  } catch (e: any) {
    console.error('[mu-screenshot-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}


export async function GET(req: NextRequest) {
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

    const url = new URL(req.url);
    const conversationId = url.searchParams.get('conversation_id') || url.searchParams.get('conversationId');

    if (!conversationId) {
      return json({ ok: false, error: 'missing_conversation_id' }, 400);
    }

    const { data, error } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .select('id, conversation_id, diagnosis_text, diagnosis_seed_json, created_at')
      .eq('user_code', userCode)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) {
      console.warn('[mu-screenshot-diagnosis] GET failed:', error.message);
      return json({ ok: false, error: 'fetch_failed' }, 500);
    }

    return json({
      ok: true,
      user_code: userCode,
      conversation_id: conversationId,
      items: data || [],
    });
  } catch (e: any) {
    console.error('[mu-screenshot-diagnosis] GET fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}


























