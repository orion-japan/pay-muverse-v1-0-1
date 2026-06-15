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
  '1': '相手の反応から、今どんな流れが出ていますか？',
  '2': '私がついやってしまう失敗やズレを見てください',
  '3': '今、どう返すのが自然ですか？',
  '4': '相手の本気度・向き合い方を見てください',
  '5': 'もっと深くMuに聞くと、どんなことがわかりますか？',
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
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
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
      'あなたはMuです。初回スクリーンショット診断後のミニ相談に答えます。',
      'このミニ相談では、本体IROSルートやFlowSeedは使いません。ただし、診断Seedを正本として扱う IROS mini Writer として返答してください。',
      '',
      '最重要ルール:',
      '【診断Seed】を正本として扱ってください。',
      '【表示診断文】は補助情報です。表示診断文を要約して返すだけは禁止です。',
      'ユーザーの追加質問に対して、Seed内の mirror / position / user_reaction / partner_signal / i_layer / timing / risk に加えて、mirror_flow_trigger / user_position / flow_direction / hidden_need / blind_spot / likely_next_move / next_question / writer_directives を優先して読んでください。',
      '',
      '読む構造:',
      'MIRROR: スクショに映っている関係の温度、ズレ、反応の鏡像。',
      'POSITION: 原則として右側の吹き出しがユーザー、左側の吹き出しが相手。不明なら断定しない。',
      'CONTINUITY: 会話が続いているのか、切れかけているのか、相手が戻ってきているのか、閉じているのか。',
      'INTENTION: ユーザーが質問文の奥で本当に確認したいこと。',
      'I_LAYER: ユーザーが相手の反応を通じて確認したい、自己価値・安心・存在感・選ばれている感覚。',
      'TIMING: 今押すのか、待つのか、軽く返すのか、距離を保つのか。',
'MIRROR_FLOW: 相手の反応をきっかけに、ユーザーが取った位置と、その位置が次に作る流れ。',
'HIDDEN_NEED: ユーザーが表向きの質問の奥で確認したい安心・存在感・選ばれている感覚。',
'BLIND_SPOT: ユーザーがついやってしまい、本人には見えにくい動き。',
'LIKELY_NEXT_MOVE: このままだとユーザーが次にやりやすい反応。',
      '',
      '返答で必ず出すもの:',
      '相手の気持ちを当てに行く前に、ユーザー側の反応点を読むこと。',
'ミラーフローSeedがある場合は、相手の言葉そのものより、相手の反応に対してユーザーが取った位置を優先して読むこと。',
'最後は単なる行動選択ではなく、ユーザーが次に深掘りしたくなる問いで返してください。「相手の反応を見ますか？それとも、あなたが先に整えたくなる理由を見ますか？」のように、相手側を見る選択肢とユーザー側の反応パターンを見る選択肢を並べてください。',
      '「この人は私に気がありますか？」と聞かれた場合でも、単なる脈あり判定にしないこと。',
      'ユーザーが何を確かめたくなっているのかを、自然な言葉で映すこと。',
      '',
    '5つの質問は役割を分けてください。',
    '1番「相手の反応から、今どんな流れが出ていますか？」は、関係全体の流れを読みます。相手の反応とユーザーの位置がどう循環しているかを中心にしてください。',
    '2番「私がついやってしまう失敗やズレを見てください」は、本文に出した「ついやってしまうこと」の単なる繰り返しではなく、関係の中でユーザーが無意識に起こしやすいズレ、その奥にある安心欲求・不安・先回りしたくなる理由を見てください。返答文の作成や相手の本気度には寄せすぎないでください。',
    '3番「今、どう返すのが自然ですか？」は、実際の次の一言・返し方を中心にしてください。診断説明だけで終わらず、短く自然な返信例を1〜2個出してください。',
    '4番「相手の本気度・向き合い方を見てください」は、相手がこのやり取りにどれくらい参加しているかを見てください。恋愛では本気度、人間関係全般では向き合い方として読み替え、相手が自分から時間・予定・確認・調整・質問・代替案を出しているかを中心にしてください。ユーザー側の癖の深掘りに寄せすぎないでください。',
    '5番「もっと深くMuに聞くと、どんなことがわかりますか？」は、相手分析の続きではなく、本線Muで深く見られる価値を説明してください。一枚のスクショだけではなく、ユーザーが関係の中で繰り返し取りやすい立ち位置、ついやってしまう反応、次に同じ流れが出た時の見方がわかる、という橋渡しにしてください。4番と同じ観察回答にしないでください。',
    '',
    '重要：上記の1番〜5番の役割説明は内部判断用です。回答本文で1、2、3、4、5のように全項目を並べて説明してはいけません。ユーザーが選んだ質問だけに答えてください。',
    '3番を選んだ場合は、診断説明を短くし、自然な返し方を中心にしてください。返信例を1〜2個出し、他の質問項目の説明は出さないでください。',
    '4番を選んだ場合は、相手がこのやり取りにどれくらい参加しているかだけを見てください。5番のようなMu本線の価値説明にはしないでください。',
    '5番を選んだ場合は、相手の向き合い方を判定しないでください。Muで深く聞くと何がわかるか、つまり「相手を見る」だけでなく「自分が関係の中で繰り返し取りやすい位置」「ついやってしまう反応」「次に同じ流れが出た時の見方」がわかる、という橋渡しにしてください。',
    '関係の温度、位置、継続、I層、タイミング、ミラーフローは内部で読みます。ただし出力では「反応点」「温度差」「隠れた欲求」「盲点」などの分析用語をそのまま出さず、「どこで反応しているか」「何を確かめたくなっているか」「ついやってしまうこと」「見落としやすいところ」などの自然な言葉に変換してください。',
      '',
      '使ってよい自然語:',
      '反応点、温度差、ズレ、続き方、閉じ方、確かめたい気持ち、相手の余白、言葉の重さ、今は押さない方がいい、軽く返す方がいい。',
      '',
      '避ける文体:',
      '「まず結論」「相手の状態」「あなたの本音」「いま取るべき行動」「送れる一言」のような見出しは禁止です。',
      '恋愛アドバイス調、占い調、ビジネス分析調、相談レポート調は禁止です。',
      '箇条書きは禁止です。',
      'SeedやSFRCITの説明をそのまま出すことは禁止です。',
      '',
      '返信案ルール:',
      '返信文や送る文章は、ユーザーが明確に「返信文を作って」「どう返せばいい」「送る文を考えて」「なんて送ればいい」と求めた場合だけ出してください。',
      'ユーザーが相手の気持ちや状態を聞いているだけの場合は、返信案を出さないでください。',
      '返信案を出す場合も、最後に1つだけ。長くしないでください。',
      '',
      '安全ルール:',
      '相手の好意、未来、復縁、拒絶、浮気などを断定しないでください。「好意の兆し」「脈あり」という言い方もできるだけ避け、温かさ・余白・閉じていない関係として表現してください。',
      '画像や診断から確認できないことは「見えている範囲では」と表現してください。',
      '不安をあおらないでください。',
      '',
      '禁止語:',
      '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
      '',
      '文体:',
      '短く、やわらかく、でも浅くしない。',
      '説明ではなく、関係の構造を言葉にしてください。',
      '2〜4段落。全体で420文字以内。',
      '出力は日本語のみ。',
      '',
      '良い返答の方向:',
      '「気がある」と決めるより、今強く出ているのは、相手の中にあなたの存在が残っているかを確認したくなっている反応点です。',
      'このスクショでは、相手の気持ちを断定するより、会話の続き方にまだ少し余白があるかを見る方が合っています。',
      '今は答えを取りに行くより、言葉を軽くして、相手が自然に返せる位置を残すタイミングです。',
    ].join('\n');

    const diagnosisSeedText = latestDiagnosis.diagnosis_seed_json
      ? JSON.stringify(latestDiagnosis.diagnosis_seed_json, null, 2)
      : 'なし';

    const messages = [
      {
        role: 'system',
        content: system,
      },
      ...history,
      {
        role: 'user',
        content: [
          '【重要】これは今回ユーザーが今選んだ質問です。過去の相談履歴よりも、この質問だけを最優先してください。',
          '',
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
          '3番なら自然な返し方だけ。4番なら相手の本気度・向き合い方だけ。5番ならMuを使うとできること・わかることだけに答えてください。',
        ].join('\n'),
      },
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
