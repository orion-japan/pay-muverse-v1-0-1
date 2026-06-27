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
  '1': '今のイマジナルコピーを、もう少し詳しく見てください',
  '2': '願っている未来と、見続けている未来のズレを見てください',
  '3': '言葉や行動に、どんな反応が出ていますか？',
  '4': '不安・比較・破壊・創造のどれが強く出ていますか？',
  '5': '今日できる小さな一歩を見てください',
};

type LatestDiagnosis = {
  id: string;
  diagnosis_text: string | null;
  diagnosis_seed_json: unknown | null;
  used_at: string | null;
};

function normalizeQuestion(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
  return QUESTION_MAP[normalized] ?? raw;
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const authzRaw = await verifyFirebaseAndAuthorize(req);
    const authz = normalizeAuthz(authzRaw);
    const userCode = authz.user?.user_code;

    if (authz.error || !userCode) return jsonError(401, 'unauthorized', '認証が必要です。');

    const body = await req.json().catch(() => ({}));
    const question = normalizeQuestion(body?.message);
    if (!question) return jsonError(400, 'missing_message', '質問を入力してください。');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return jsonError(500, 'missing_openai_api_key', 'OPENAI_API_KEY が未設定です。');

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const { data: consumed, error: consumeErr } = await supabaseAdmin.rpc('consume_first_followup_credit', {
      p_user_code: userCode,
    });

    if (consumeErr) return jsonError(500, 'credit_consume_failed', 'ミニ相談回数の確認に失敗しました。');
    if (!consumed) return jsonError(402, 'no_first_followup_credit', '診断後の相談回数が残っていません。');

    const { data: latestDiagnosisRaw, error: diagnosisErr } = await supabaseAdmin
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
      .eq('user_code', userCode)
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (diagnosisErr) return jsonError(500, 'diagnosis_fetch_failed', '診断結果の取得に失敗しました。');

    const latestDiagnosis = latestDiagnosisRaw as LatestDiagnosis | null;
    if (!latestDiagnosis?.diagnosis_text) return jsonError(404, 'missing_diagnosis', '先にイマジナル診断を行ってください。');

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
      'あなたはMuです。初回イマジナル診断後のミニ相談に答えます。',
      '診断Seedを正本として扱う IROS mini Writer として返答してください。',
      '表示診断文を要約して返すだけは禁止です。',
      'Seed内の imaginal_copy / visible_wish / seen_future / word_reaction / action_reaction / dominant_field / creative_direction / today_step / image_type を優先して読んでください。',
      '1番は、イマジナルコピーを中心に深めてください。',
      '2番は、願いと見続けている未来のズレを見てください。',
      '3番は、言葉と行動に出ている反応を見てください。',
      '4番は、不安・比較・破壊・創造のどれが強いかを自然な言葉で見てください。理論名だけで終わらせないでください。',
      '5番は、今日できる小さな一歩だけを具体的にしてください。大きな行動にしないでください。',
      'ユーザーが選んだ質問だけに答えてください。',
      '相手の気持ちや未来は断定しないでください。画像や診断から確認できないことは「見えている範囲では」と表現してください。',
      '不安をあおらないでください。',
      '返信文や送る文章は、ユーザーが明確に求めた場合だけ出してください。',
      '魂、使命、覚醒、波動、宿命、前世、高次元、宇宙からのメッセージ、あなたは〇〇タイプです、必ず、絶対、は禁止です。',
      '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
      '短く、やわらかく、でも浅くしない。2〜4段落。全体で420文字以内。日本語のみ。',
    ].join('\n');

    const diagnosisSeedText = latestDiagnosis.diagnosis_seed_json
      ? JSON.stringify(latestDiagnosis.diagnosis_seed_json, null, 2)
      : 'なし';

    const messages = [
      { role: 'system', content: system },
      ...history,
      {
        role: 'user',
        content: [
          '【診断Seed】',
          diagnosisSeedText,
          '',
          '【表示診断文】',
          latestDiagnosis.diagnosis_text,
          '',
          '【今回の質問】',
          question,
          '',
          'この質問だけに答えてください。過去の相談履歴の質問に戻らないでください。',
        ].join('\n'),
      },
    ];

    const model = process.env.MU_FIRST_FOLLOWUP_MODEL || 'gpt-5-mini';
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
    });

    const openaiJson = await openaiRes.json().catch(() => ({}));
    if (!openaiRes.ok) return jsonError(500, 'llm_failed', 'Muの追加相談に失敗しました。');

    const answer = openaiJson?.choices?.[0]?.message?.content?.trim() || 'すみません。うまく言葉にできませんでした。もう一度聞いてください。';

    const { error: logErr } = await supabaseAdmin.from('mu_first_followup_logs').insert({
      user_code: userCode,
      diagnosis_log_id: latestDiagnosis.id,
      question,
      answer,
      source: 'mu_first_followup',
      credit_used: 1,
    });

    if (logErr) console.warn('[mu-first-followup] log insert skipped:', logErr.message);

    return NextResponse.json({ ok: true, question, answer, diagnosis_log_id: latestDiagnosis.id });
  } catch (e: any) {
    console.error('[mu-first-followup] fatal:', e);
    return jsonError(500, 'server_error', e?.message || 'server_error');
  }
}
