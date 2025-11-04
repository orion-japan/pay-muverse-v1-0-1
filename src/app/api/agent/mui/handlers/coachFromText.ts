// Navigator版 coach_from_text：A=自分 / B=相手。Qコード推定→レポート出力→Phase1(無料)CTA付き

// ---- 型（プロジェクトの型に合わせて最低限）----
type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

type MuiBodyLocal = {
  text?: string;
  stage?: number | 'opening';
  payjpToken?: string;
  perspective?: 'AisSelf' | 'BisSelf'; // 既定: A=自分/B=相手
};

// ---- 小ヘルパ ----
function computeRelation(_phase: string) {
  return { label: 'neutral' as const };
}

function looksGeneric(s: string) {
  const ng = [
    'なんでも',
    'どんな相談でも',
    'お待ちしています',
    'こんにちは',
    '詳しく教えて',
    '考えてみましょう',
    'どうしますか？',
    'まずは落ち着いて',
  ];
  return ng.some((w) => s.includes(w));
}

/** 入力から6〜12文字の引用候補を抽出（A/B行や見出し除外） */
function pickQuoteFragment(input: string) {
  const raw = String(input || '')
    .replace(/^【#\d+】/gm, '')
    .replace(/^[AB] /gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = raw
    .split(/[。!?！？]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    const t = p.replace(/[「」『』（）()【】]/g, '').trim();
    if (t.length >= 8) {
      const start = Math.max(0, Math.floor(t.length / 4) - 2);
      return t.slice(start, start + Math.min(12, Math.max(6, t.length - start)));
    }
  }
  return raw.slice(0, 10);
}

/** A/B テキスト抽出 */
function splitBySpeaker(s: string) {
  const A: string[] = [],
    B: string[] = [];
  for (const ln of String(s || '').split(/\r?\n/)) {
    if (/^A[ ：:]/.test(ln)) A.push(ln.replace(/^A[ ：:]\s*/, ''));
    else if (/^B[ ：:]/.test(ln)) B.push(ln.replace(/^B[ ：:]\s*/, ''));
  }
  return { A: A.join('\n').trim(), B: B.join('\n').trim() };
}

/** 超軽量 Q分類（ヒューリスティック） */
function classifyQ(text: string): QCode {
  const t = String(text || '');
  if (/[？?]/.test(t) || /どう(す|したら)|なに|何|なぜ|理由/.test(t)) return 'Q2';
  if (/約束|決めよう|ルール|守る|条件|合意/.test(t)) return 'Q4';
  if (/なら|してみよう|しよう|かも|それとも|案|提案/.test(t)) return 'Q3';
  if (/ありがとう|ごめん|またね|落ち着|安心/.test(t)) return 'Q5';
  return 'Q1';
}

// ===== ここからメイン =====
export async function handleCoachFromText(
  userCode: string,
  conversation_code: string,
  raw: MuiBodyLocal,
  callOpenAI: (p: any) => Promise<any>,
  model: string,
  temperature: number,
  top_p: number,
  frequency_penalty: number,
  presence_penalty: number,
  sbService: () => any,
  chargeIfNeeded: (o: any) => Promise<any>,
  inferPhase: (t: string) => string,
  estimateSelfAcceptance: (t: string) => any,
) {
  const userText = (typeof raw.text === 'string' && raw.text.trim()) || '';
  if (!userText) return { status: 400, body: { error: 'empty_text' } };

  // 観点：既定は「A=自分 / B=相手」
  const pv = raw.perspective || 'AisSelf';

  // 引用候補 & A/B Q推定
  const quote = pickQuoteFragment(userText);
  const { A: aText, B: bText } = splitBySpeaker(userText);
  const qA = classifyQ(aText);
  const qB = classifyQ(bText);
  const qBySpeaker = { A: qA, B: qB };

  // —— System Prompt（レポート方式＋Phase1(無料)を明示）——
  const SYS_COACH = `
あなたは恋愛相談AI「Mui」のナビゲータです。A=自分（相談者）、B=相手（対象）として読み解きます。
少しの共感のあと、いまの会話から **相手の状態を仮スキャン** し、続けて「レポート形式」で整理してから次フェーズへ案内します。

【出力仕様（厳守/日本語）】
- 4〜7行、やさしく具体。A/Bという記号は本文に出さない（必要なら「自分」「相手」と書く）。絵文字は最後に1つまで（🌱/💫/✨等）。
- 冒頭1行：入力から **6〜12文字** を「」で引用/言い換えし、気持ちを受け止める（候補はassistantが与える）。
- その後は **箇条書きのレポート** で以下の順に1行ずつ、各行は短く：
  ・状況：事実の要点（時系列/すれ違いのポイントを1つ）
  ・気持ち：自分と相手の感情をそれぞれ一言（推測は断定しない）
  ・自分：いまの自分の立場/望みを1行で要約
  ・相手：相手の状態の仮スキャン（例：防衛的、言語化が苦手、期待ギャップ 等）
  ・解決（Phase1/無料）：**今はスキャンだけなので、まず短い分析（無料）で状況を整えましょう** と明記し、何を分析するか1点だけ提示
- 最後に **誘導質問** を1つだけ：  
  「まずは **Phase1：分析（無料）** を進めますか？ それとも **Phase2：事実整理** / **Phase3：選択肢** / **Phase4：合意文** から始めますか？💫」
- 「なんでも相談してね／詳しく教えて」等の凡庸表現は禁止。
`.trim();

  // —— OpenAI 呼び出し（補助情報としてQと引用候補を渡す）——
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYS_COACH },
      {
        role: 'system',
        content: `補助情報: AのQ=${qA}, BのQ=${qB}, 引用候補="${quote}", 視点=${pv}`,
      },
      { role: 'user', content: userText },
    ],
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
  };

  const ai = await callOpenAI(payload);
  if (!ai?.ok) {
    return {
      status: ai?.status ?? 502,
      body: { error: 'Upstream error', detail: ai?.detail ?? '' },
    };
  }

  // 再生成ガード：空/凡庸/引用なし → 温度上げて1回だけ再試行
  let reply: string = String(ai.data?.choices?.[0]?.message?.content ?? '').trim();
  if (!reply || looksGeneric(reply) || !/[「」]/.test(reply)) {
    const payload2 = { ...payload, temperature: Math.max(0.9, temperature) };
    const ai2 = await callOpenAI(payload2);
    reply = String(ai2?.data?.choices?.[0]?.message?.content || reply).trim();
  }

  // —— 課金（停止中は free）——
  const bill: any = await chargeIfNeeded({
    userCode,
    stage: raw.stage,
    payjpToken: raw.payjpToken,
    meta: { agent: 'mui', model, mode: 'coach_from_text', navigator: true, perspective: pv },
  });
  if (!bill?.ok) {
    return { status: bill?.status ?? 402, body: { error: bill?.error ?? 'charge_failed' } };
  }

  // —— 保存 ——
  const sb = sbService();
  const now = new Date().toISOString();

  await sb.from('mu_turns').insert({
    conv_id: conversation_code,
    user_code: userCode,
    role: 'user',
    content: userText,
    meta: { source_type: 'coach_from_text', perspective: pv },
    used_credits: 0,
    source_app: 'mu',
    created_at: now,
  } as any);

  const phase = inferPhase(userText);
  const self = estimateSelfAcceptance(userText);
  const relation = computeRelation(phase);

  // 返信保存（メタに qBySpeaker と actions を載せておく）
  const actions = [
    { code: 'start_phase1', label: 'Phase1：分析（無料）' },
    { code: 'phase2', label: 'Phase2：事実整理' },
    { code: 'phase3', label: 'Phase3：選択肢づくり' },
    { code: 'phase4', label: 'Phase4：合意フレーズ' },
  ];

  await sb.from('mu_turns').insert({
    conv_id: conversation_code,
    user_code: userCode,
    role: 'assistant',
    content: reply,
    meta: {
      resonanceState: { phase, self, relation, currentQ: null, nextQ: null },
      used_knowledge: [],
      agent: 'mui',
      model,
      source_type: 'coach_from_text',
      perspective: pv,
      navigator: true,
      qBySpeaker,
      actions,
    } as any,
    used_credits: 1,
    source_app: 'mu',
    created_at: now,
  } as any);

  if (process.env.NODE_ENV !== 'production') {
    console.log('[mui/coach_from_text:report]', {
      conv: conversation_code,
      Q: 'Q2',
      pv,
      qBySpeaker,
      preview: reply.slice(0, 80),
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      conversation_code,
      reply,
      // 開幕は方向づけ。UIでは actions を使ってPhase1へ誘導
      q: { code: 'Q2', stage: 'S1' },
      meta: { phase, self, relation, qBySpeaker },
      credit_balance: bill?.balance ?? null,
      mode: 'coach_from_text',
      actions, // ← フロントでボタン表示に使う
    },
  };
}
