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
  mirror_flow_trigger?: string;
  user_position?: string;
  flow_direction?: string;
  hidden_need?: string;
  blind_spot?: string;
  likely_next_move?: string;
  next_question?: string;
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
        : parsed?.display_text && typeof parsed.display_text === 'object'
          ? Object.entries(parsed.display_text)
              .map(([key, value]) => `【${key}】` + '\n' + String(value ?? '').trim())
              .join('\n\n')
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
            mirror_flow_trigger:
              typeof parsed.seed.mirror_flow_trigger === 'string'
                ? parsed.seed.mirror_flow_trigger
                : undefined,
            user_position:
              typeof parsed.seed.user_position === 'string'
                ? parsed.seed.user_position
                : undefined,
            flow_direction:
              typeof parsed.seed.flow_direction === 'string'
                ? parsed.seed.flow_direction
                : undefined,
            hidden_need:
              typeof parsed.seed.hidden_need === 'string'
                ? parsed.seed.hidden_need
                : undefined,
            blind_spot:
              typeof parsed.seed.blind_spot === 'string'
                ? parsed.seed.blind_spot
                : undefined,
            likely_next_move:
              typeof parsed.seed.likely_next_move === 'string'
                ? parsed.seed.likely_next_move
                : undefined,
            next_question:
              typeof parsed.seed.next_question === 'string'
                ? parsed.seed.next_question
                : undefined,
            user_name_candidate:
              typeof parsed.seed.user_name_candidate === 'string'
                ? parsed.seed.user_name_candidate
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
  diagnosisSeedJson: DiagnosisSeed | null;
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
      diagnosis_seed_json: params.diagnosisSeedJson,
    });
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] log skipped:', e?.message || e);
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

    const { data: latest, error: latestErr } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
      .eq('user_code', userCode)
      .eq('source', 'mu_first')
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) {
      console.warn('[mu-first-diagnosis] restore latest failed:', latestErr.message);
      return json({ ok: false, error: 'restore_failed' }, 500);
    }

    if (!latest?.diagnosis_text) {
      return json({
        ok: true,
        diagnosis: null,
        followup_messages: [],
        followup_remaining: 3,
        user_name_candidate: null,
      });
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

    const seed =
      latest.diagnosis_seed_json &&
      typeof latest.diagnosis_seed_json === 'object' &&
      !Array.isArray(latest.diagnosis_seed_json)
        ? (latest.diagnosis_seed_json as DiagnosisSeed)
        : null;

    const dbRemaining =
      userRow && typeof userRow.first_followup_credit_count === 'number'
        ? userRow.first_followup_credit_count
        : null;

    return json({
      ok: true,
      diagnosis: latest.diagnosis_text,
      followup_messages: followupMessages,
      followup_remaining:
        dbRemaining === null ? Math.max(0, 3 - Math.floor(followupMessages.length / 2)) : dbRemaining,
      user_name_candidate: seed?.user_name_candidate || null,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] restore fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
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
    };

    const imageDataUrl = normalizeDataUrl(body.image_data_url);
    if (!imageDataUrl) {
      return json({ ok: false, error: 'invalid_image' }, 400);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json({ ok: false, error: 'missing_openai_api_key' }, 500);
    }

    const creditConsumed = await consumeScreenshotCredit(userCode);
    if (creditConsumed === false) {
      return json({ ok: false, error: 'no_screenshot_credit' }, 402);
    }

    const model = process.env.MU_FIRST_DIAGNOSIS_MODEL || 'gpt-5-mini';

    const note =
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 500)
        : '';

    const system = [
      'あなたはMuの初回スクリーンショット診断を行います。',
      '本線IROSの完全実行ではなく、画像から読み取れる範囲だけで、初回版のミラーフロー診断として読んでください。',
      'LINE/SNSの会話画像では、原則として右側の吹き出しをユーザー本人、左側の吹き出しを相手として読んでください。',
      'ただし、画面上の配置が不明確な場合は断定せず、「見えている範囲では」と表現してください。',
      '既読、未読、返信間隔、スタンプ、絵文字、文量、語尾、敬語/タメ口、話題の継続、相手が質問しているか、会話を閉じているかを読み取ってください。',
      '画像から確認できないことは推測で断定しないでください。',
      '相手の状態だけでなく、相手の反応に対してユーザーが取った立ち位置、その立ち位置が次に作る流れを読んでください。',
      '内部では、MIRROR、POSITION、CONTINUITY、INTENTION、S/R/C/I/T 的な読み方に加えて、ミラーフローとして trigger / user_position / flow_direction / hidden_need / blind_spot / likely_next_move / next_question を抽出してください。ただし、display_text には trigger、user_position、flow_direction、hidden_need、blind_spot、likely_next_move、next_question などの内部キー名を絶対に出さず、自然な日本語の共鳴診断として表現してください。',
      '右側=ユーザー、左側=相手というPOSITIONをSeedに必ず残してください。不明な場合は不明と残してください。',
      '相手の個人情報、年齢、職業、顔、属性などは推定しないでください。',
      '出力は必ずJSONのみ。Markdownや説明文を前後に付けないでください。',
      'JSONは display_text と seed を持つオブジェクトにしてください。display_text はユーザー表示用、seed は内部保存用です。display_text に内部Seed名や英語キー名を出してはいけません。',
      'display_text の見出しは必ず「内容要約」「あなたの立ち位置」「相手の反応」「共鳴診断」「ついやってしまうこと」「次に見たいところ」の6つにしてください。「共鳴診断」では、相手の反応に対してユーザーがどの位置を取り、その結果どんな流れが生まれているかを自然な文章で説明してください。見えている事実の説明だけで終わらせず、最後に必ず「この人は〇〇しやすい」というユーザー側の反応パターンを1文入れてください。内部キー名は出さないでください。「ついやってしまうこと」では、単なる注意ではなく、ユーザーがなぜその動きをしてしまうのかまで読んでください。',
      'display_text の「次に見たいところ」では、行動アドバイスで終わらせず、ユーザーが次にMuへ聞きたくなる問いを必ず入れてください。「相手が安心して近づいているサインを見ますか？それとも、あなたがついやってしまう整え方を見ますか？」のように、相手の断定ではなくサインとして表現してください。',
      '返信案、送信文、文例、例文は、初回診断では出さないでください。',
      'display_text は全体で950文字以内。ただし「共鳴診断」と「ついやってしまうこと」は、それぞれ2〜4文で、なぜそう読めるのかが伝わるように少し厚めに書いてください。特に「共鳴診断」は、事実説明ではなく、ユーザーの無意識の立ち位置が見える文章にしてください。',
      'seed は、旧互換として mirror, position, user_reaction, partner_signal, i_layer, timing, risk を持ち、さらにミラーフロー用として mirror_flow_trigger, user_position, flow_direction, hidden_need, blind_spot, likely_next_move, next_question, user_name_candidate, writer_directives を持つJSONにしてください。',
      'seed.partner_signal では相手の好意を断定しないでください。seed.likely_next_move では、ユーザーが次に無意識にやりやすい動きを短く入れてください。「相手の負担を軽く見ている」ではなく「相手の負担を軽くしようとして先に整えすぎる」のように、ユーザーの反応点として表現してください。seed.next_question では、3回ミニ相談につながる問いを入れてください。',
      'スクショ内で右側のユーザー名、プロフィール名、送信者名などからユーザー本人の名前らしき文字列が読める場合だけ、seed.user_name_candidate に入れてください。不明なら空文字にしてください。相手名を入れないでください。',
      'seed.writer_directives には「Mu文体で返す」「説明調にしない」「見出しや箇条書きを多用しない」「返信案は頼まれた時だけ出す」「相手の気持ちは断定しない」を入れてください。',
    ].join('\n');

    const userText = [
      'このスクリーンショットから、初回診断として読めることを返してください。',
      'ユーザーに見せる診断文 display_text と、診断後ミニ相談で使う内部Seed seed を同時に作ってください。',
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
      console.error('[mu-first-diagnosis] LLM error:', detail.slice(0, 500));
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
    const diagnosis = parsedDiagnosis.displayText;

    if (!diagnosis) {
      return json({ ok: false, error: 'empty_diagnosis' }, 502);
    }

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
      user_name_candidate: parsedDiagnosis.seed?.user_name_candidate || null,
      credit_consumed: creditConsumed,
      model,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

