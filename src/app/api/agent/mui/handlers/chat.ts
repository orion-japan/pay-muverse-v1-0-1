// 依存を最小化した通常チャットハンドラ

type ChatRole = 'system' | 'user' | 'assistant';
type Msg = { role: ChatRole; content: string };

type MuiBodyLocal = {
  vars?: any;
  stage?: number | 'opening';
  payjpToken?: string;
};

function getLastUserText(messages?: Msg[] | null) {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

function computeRelation(_phase: string) {
  return { label: 'neutral' as const };
}

export async function handleChat(
  userCode: string,
  conversation_code: string,
  raw: MuiBodyLocal,
  callOpenAI: (p: any) => Promise<any>,
  model: string,
  temperature: number,
  top_p: number,
  frequency_penalty: number,
  presence_penalty: number,
  retrieveKnowledge: (a: any, limit: number, query: string, cfg: any) => Promise<any>,
  nextQFrom: (q: string, phase: string) => string | null,
  inferPhase: (t: string) => string,
  estimateSelfAcceptance: (t: string) => any,
  chargeIfNeeded: (o: any) => Promise<any>,
  use_kb: boolean,
  kb_limit: number,
  messages: Msg[],
  source_type: string,
  sbService: () => any,
) {
  const lastUser = getLastUserText(messages);
  const phase = inferPhase(lastUser);
  const self = estimateSelfAcceptance(lastUser);
  const relation = computeRelation(phase);
  const currentQ = (raw.vars as any)?.analysis?.qcodes?.[0]?.code ?? null;
  const nextQ = currentQ ? nextQFrom(currentQ, phase) : null;

  const seed = Math.abs(
    [...`${userCode}:${conversation_code}`].reduce(
      (a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0,
      0,
    ),
  );
  const kb = use_kb
    ? await retrieveKnowledge(
        (raw.vars as any)?.analysis ?? { qcodes: [], layers: [], keywords: [] },
        kb_limit,
        lastUser,
        { epsilon: 0.3, noiseAmp: 0.15, seed },
      ).catch(() => [])
    : [];

  const kbBlock = Array.isArray(kb)
    ? kb
        .slice(0, kb_limit)
        .map((k: any, i: number) => {
          const t = String(k?.title ?? `K${i + 1}`);
          const c = String(k?.content ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 900);
          return `- (${i + 1}) ${t}\n  ${c}`;
        })
        .join('\n')
    : '';

  const STYLE = `
## Style
- 過度に断定せず、短めの段落で分かりやすく。
- 絵文字は多用せず1つまで。
- 色・共鳴のメタは最後に1行だけ添える（例: [Q:Q2 / Inner / harmony]).`.trim();

  const SYS = [
    'あなたは恋愛スクショ相談「Mui」の会話パートナーです。短く温かく、実用的に返答します。',
    '不要な引用や前置きは避ける。',
    STYLE,
    use_kb && kbBlock ? '### Knowledge Base\n' + kbBlock : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = {
    model,
    messages: [{ role: 'system', content: SYS }, ...messages],
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
  };

  const ai = await callOpenAI(payload);
  if (!ai?.ok)
    return {
      status: ai?.status ?? 502,
      body: { error: 'Upstream error', detail: ai?.detail ?? '' },
    };
  const reply: string = ai.data?.choices?.[0]?.message?.content ?? '';

  const bill: any = await chargeIfNeeded({
    userCode,
    stage: raw.stage,
    payjpToken: raw.payjpToken,
    meta: { agent: 'mui', model },
  });
  if (!bill?.ok)
    return { status: bill?.status ?? 402, body: { error: bill?.error ?? 'charge_failed' } };

  const sb = sbService();
  const now = new Date().toISOString();
  if (lastUser) {
    await sb.from('mu_turns').insert({
      conv_id: conversation_code,
      user_code: userCode,
      role: 'user',
      content: lastUser,
      meta: { source_type },
      used_credits: 0,
      source_app: 'mu',
      created_at: now,
    } as any);
  }

  await sb.from('mu_turns').insert({
    conv_id: conversation_code,
    user_code: userCode,
    role: 'assistant',
    content: reply,
    meta: {
      resonanceState: { phase, self, relation, currentQ, nextQ },
      used_knowledge: Array.isArray(kb)
        ? kb.map((k: any, i: number) => ({ id: k.id, key: `K${i + 1}`, title: k.title }))
        : [],
      agent: 'mui',
      model,
      source_type,
    } as any,
    used_credits: 1,
    source_app: 'mu',
    created_at: now,
  } as any);

  const qOut = (currentQ ?? nextQ ?? 'Q2') as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  return {
    status: 200,
    body: {
      ok: true,
      conversation_code,
      reply,
      q: { code: qOut, stage: 'S1' },
      meta: { phase, self, relation },
      credit_balance: bill?.balance ?? null,
    },
  };
}
