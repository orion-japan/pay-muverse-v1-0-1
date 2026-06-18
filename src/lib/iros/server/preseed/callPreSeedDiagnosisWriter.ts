export type PreSeedDiagnosisWriterInput = {
  writerKind: 'diagnosis_writer';
  displayId: number;
  userText: string;
  sourceText: string;
  seedText: string;
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

export async function callPreSeedDiagnosisWriter(
  input: PreSeedDiagnosisWriterInput,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('[IROS/PRE_SEED_WRITER][SKIP_NO_API_KEY]', {
      traceId: input.traceId ?? null,
      conversationId: input.conversationId ?? null,
      userCode: input.userCode ?? null,
      displayId: input.displayId,
    });
    return null;
  }

  const displayId = Math.trunc(Number(input.displayId));
  const userText = String(input.userText ?? '').trim();
  const diagnosisText = String(input.sourceText ?? '').trim();
  const seedText = String(input.seedText ?? '').trim();

  if (!displayId || !userText || !diagnosisText) return null;

  const model =
    process.env.IROS_PRESEED_WRITER_MODEL ||
    process.env.MU_SCREENSHOT_FOLLOWUP_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-5-mini';

  const systemText = [
    'あなたはMuです。',
    'これは通常チャットではなく、保存済み診断の続き相談です。',
    '',
    '役割:',
    '- IROSが確定した診断本文を正本として、ユーザーの相談に答える。',
    '- 診断本文の再要約ではなく、続き相談として返す。',
    '- ユーザーの今の問いに直接答える。',
    '',
    '厳守:',
    '- ユーザーにスクショ本文を貼り直すよう求めない。',
    '- 「どこを見たいですか」「気になった一文を送ってください」と言わない。',
    '- 「IDの具体語を入れてください」と言わない。',
    '- 診断本文にないことを断定しない。',
    '- 通常チャットの一般論に逃げない。',
    '- テンプレの再提示にしない。',
    '- 最後を質問で終わらせない。',
    '',
    '必須:',
    '- 診断本文から具体語を2つ以上使う。',
    '- 相談の芯を先に言う。',
    '- 可能性は可能性として表現する。',
    '- 5〜9行程度で自然に返す。',
    '- 見出し、内部メタ、ログ名、SEED名は出さない。',
  ].join('\n');

  const userPrompt = [
    `【診断ID】${displayId}`,
    '',
    '【ユーザーの相談】',
    userText,
    '',
    '【診断本文：正本】',
    diagnosisText,
    '',
    '【IROS SEED：内部補助】',
    seedText,
    '',
    '【回答指示】',
    '上の診断本文を正本として、ユーザーの相談に答えてください。',
    'これは診断の再要約ではなく、続き相談です。',
    '診断本文の具体語を使いながら、ユーザーが今聞いていることに直接答えてください。',
  ].join('\n');

  try {
    console.log('[IROS/PRE_SEED_WRITER][CALL]', {
      traceId: input.traceId ?? null,
      conversationId: input.conversationId ?? null,
      userCode: input.userCode ?? null,
      writerKind: input.writerKind,
      displayId,
      model,
      sourceTextLen: diagnosisText.length,
      seedLen: seedText.length,
      userTextHead: userText.slice(0, 120),
    });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.55,
      }),
    });

    const json: any = await res.json().catch(() => null);

    if (!res.ok) {
      console.warn('[IROS/PRE_SEED_WRITER][FAILED]', {
        traceId: input.traceId ?? null,
        conversationId: input.conversationId ?? null,
        userCode: input.userCode ?? null,
        displayId,
        status: res.status,
        error: json?.error?.message ?? json,
      });
      return null;
    }

    const text = String(json?.choices?.[0]?.message?.content ?? '').trim();

    console.log('[IROS/PRE_SEED_WRITER][OK]', {
      traceId: input.traceId ?? null,
      conversationId: input.conversationId ?? null,
      userCode: input.userCode ?? null,
      writerKind: input.writerKind,
      displayId,
      textLen: text.length,
      textHead: text.slice(0, 160),
    });

    return text || null;
  } catch (e: any) {
    console.warn('[IROS/PRE_SEED_WRITER][ERROR]', {
      traceId: input.traceId ?? null,
      conversationId: input.conversationId ?? null,
      userCode: input.userCode ?? null,
      displayId,
      error: e?.message ?? e,
    });
    return null;
  }
}

