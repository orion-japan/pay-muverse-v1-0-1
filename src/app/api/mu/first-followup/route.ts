import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  normalizeAuthz,
  SERVICE_ROLE,
  SUPABASE_URL,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QUESTION_MAP: Record<string, string> = {
  '1': 'この相手はどう思っていますか？',
  '2': '私はどう返せばいいですか？',
  '3': '今は待つべきですか？',
  '4': '返信文を作ってください。',
  '5': '既読無視されたらどうすればいいですか？',
};

type LatestDiagnosis = {
  id: string;
  diagnosis_text: string | null;
  used_at: string | null;
};

function normalizeQuestion(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';

  const normalized = raw.replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0),
  );

  return QUESTION_MAP[normalized] ?? raw;
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
    },
    { status },
  );
}

export async function POST(req: NextRequest) {
  try {
    const authzRaw = await verifyFirebaseAndAuthorize(req);
    const authz = normalizeAuthz(authzRaw);
    const userCode = authz.user?.user_code;

    if (authz.error || !userCode) {
      return jsonError(401, 'unauthorized', '認証が必要です。');
    }

    const body = await req.json().catch(() => ({}));
    const question = normalizeQuestion(body?.message);

    if (!question) {
      return jsonError(400, 'missing_message', '質問を入力してください。');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return jsonError(500, 'missing_openai_api_key', 'OPENAI_API_KEY が未設定です。');
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: {
        persistSession: false,
      },
    });

    const { data: consumed, error: consumeErr } = await supabaseAdmin.rpc(
      'consume_first_followup_credit',
      {
        p_user_code: userCode,
      },
    );

    if (consumeErr) {
      console.warn('[mu-first-followup] consume_first_followup_credit failed:', consumeErr.message);
      return jsonError(500, 'credit_consume_failed', 'ミニ相談回数の確認に失敗しました。');
    }

    if (!consumed) {
      return jsonError(402, 'no_first_followup_credit', '診断後の相談回数が残っていません。');
    }

    const { data: latestDiagnosisRaw, error: diagnosisErr } = await supabaseAdmin
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, used_at')
      .eq('user_code', userCode)
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (diagnosisErr) {
      console.warn('[mu-first-followup] latest diagnosis fetch failed:', diagnosisErr.message);
      return jsonError(500, 'diagnosis_fetch_failed', '診断結果の取得に失敗しました。');
    }

    const latestDiagnosis = latestDiagnosisRaw as LatestDiagnosis | null;

    if (!latestDiagnosis?.diagnosis_text) {
      return jsonError(404, 'missing_diagnosis', '先にスクショ診断を行ってください。');
    }

    const history = Array.isArray(body?.history)
      ? body.history
          .slice(-6)
          .map((item: any) => ({
            role: item?.role === 'assistant' ? 'assistant' : 'user',
            content: String(item?.content || '').slice(0, 1000),
          }))
          .filter((item: any) => item.content)
      : [];

    const system = [
      'あなたはMuの初回スクリーンショット診断後のミニ相談に答えます。',
      '一般論ではなく、必ず直近のスクショ診断結果を土台にして答えてください。',
      'LINE/SNSの会話では、原則として右側の吹き出しをユーザー本人、左側の吹き出しを相手として扱います。',
      'ただし診断結果や画像から確認できないことは断定しないでください。',
      '相手の状態、ユーザーの本音、いま取るべき行動を分けて、やさしく具体的に答えてください。',
      '返信文を求められた場合は、そのまま送れる短い文例を出してください。',
      '不安をあおらず、相手を決めつけず、可能性として表現してください。',
      '出力は日本語。全体で500文字以内。',
    ].join('\n');

    const messages = [
      {
        role: 'system',
        content: system,
      },
      {
        role: 'user',
        content: [
          '【直近のスクショ診断結果】',
          latestDiagnosis.diagnosis_text,
          '',
          '【ユーザーの追加質問】',
          question,
        ].join('\n'),
      },
      ...history,
    ];

    const model = process.env.MU_FIRST_FOLLOWUP_MODEL || 'gpt-5-mini';

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
      }),
    });

    const openaiJson = await openaiRes.json().catch(() => ({}));

    if (!openaiRes.ok) {
      console.error('[mu-first-followup] OpenAI error:', openaiJson);
      return jsonError(500, 'llm_failed', 'Muの追加相談に失敗しました。');
    }

    const answer =
      openaiJson?.choices?.[0]?.message?.content?.trim() ||
      'すみません。うまく言葉にできませんでした。もう一度聞いてください。';

    const { error: logErr } = await supabaseAdmin
      .from('mu_first_followup_logs')
      .insert({
        user_code: userCode,
        diagnosis_log_id: latestDiagnosis.id,
        question,
        answer,
        source: 'mu_first_followup',
        credit_used: 1,
      });

    if (logErr) {
      console.warn('[mu-first-followup] log insert skipped:', logErr.message);
    }

    return NextResponse.json({
      ok: true,
      question,
      answer,
      diagnosis_log_id: latestDiagnosis.id,
    });
  } catch (e: any) {
    console.error('[mu-first-followup] fatal:', e);
    return jsonError(500, 'server_error', e?.message || 'server_error');
  }
}
