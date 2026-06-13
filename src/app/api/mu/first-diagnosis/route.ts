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

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
}) {
  try {
    await sb.from('mu_screenshot_diagnosis_logs').insert({
      user_code: params.userCode,
      model: params.model,
      source: params.source,
      media_code: params.mediaCode,
      credit_used: 1,
    });
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] log skipped:', e?.message || e);
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
      'IROS診断ではなく、画像から読み取れる範囲だけで、やさしく短く診断してください。',
      '断定しすぎず、相手の個人情報や顔などの属性推定は避けてください。',
      '恋愛・人間関係・感情の流れを中心に、今の状態を言葉にしてください。',
      '出力は日本語。',
      '見出しは「概況」「状態の手がかり」「Muからの一言」「次の一歩」。',
      '全体で500文字以内。',
    ].join('\n');

    const userText = [
      'このスクリーンショットから、初回診断として読めることを返してください。',
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
        temperature: 0.4,
      }),
    });

    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => '');
      console.error('[mu-first-diagnosis] LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const data = await llmRes.json().catch(() => ({}));
    const diagnosis =
      data?.choices?.[0]?.message?.content?.toString?.() ??
      data?.choices?.[0]?.message?.content ??
      '';

    if (!diagnosis) {
      return json({ ok: false, error: 'empty_diagnosis' }, 502);
    }

    await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_first',
      mediaCode: body.media_code || null,
    });

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      credit_consumed: creditConsumed,
      model,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
