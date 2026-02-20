import { NextResponse } from 'next/server';

// ===== 可変：OpenAI 等を使うならセット =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 失敗時・キー無し時のフォールバック整形
function fallbackFormat(src: string): string {
  // 太陽ノイズ等の軽補正
  const s = src
    .replace(/濫/g, '☀')
    .replace(/おはよ一/g, 'おはよー')
    .replace(/言っる/g, '言ってる')
    .replace(/会えそな/g, '会えな')
    .replace(/あぁあ+/g, 'あぁ')
    .replace(/クンょい/g, '') // 典型ノイズ
    .replace(/\s*;\s*/g, '');

  // 行ベースで A/B を付与
  const lines = s
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  // 章ヘッダ「【#n】」はそのまま残す
  const out: string[] = [];
  let lastSpeaker: 'A' | 'B' | null = null;

  for (const raw of lines) {
    if (/^【#\d+】$/.test(raw)) {
      out.push(raw);
      continue;
    }

    // 既に A/B が付いていたら尊重
    if (/^[AB][：:\s]/.test(raw)) {
      out.push(raw.replace(/^([AB])[：:]/, '$1'));
      lastSpeaker = raw[0] as 'A' | 'B';
      continue;
    }

    // ヒューリスティック：相手問いかけ/自分返答らしさ
    const isQuestion = /[？?]$/.test(raw) || /(なに|何|どう|どこ|いつ|なぜ|なんで)/.test(raw);
    let speaker: 'A' | 'B';

    if (lastSpeaker == null) {
      // 開始：挨拶「おはよう/こんにちは」があれば A
      speaker = /^おは|^こん|^元気|^いやさぁ|^え、?あ、?/.test(raw) ? 'A' : 'B';
    } else {
      // 交互前提。ただし疑問→応答の並びは反転補正
      if (isQuestion && lastSpeaker === 'B') speaker = 'A';
      else if (isQuestion && lastSpeaker === 'A') speaker = 'B';
      else speaker = lastSpeaker === 'A' ? 'B' : 'A';
    }

    // 句読点の荒れを軽修正（文意は変えない）
    let t = raw
      .replace(/\s*([。！？…、，,.!?])\s*/g, '$1')
      .replace(/([ぁ-んァ-ヶ一-龥ー])\s+([ぁ-んァ-ヶ一-龥ー])/g, '$1$2')
      .replace(/([。！？])\s+/g, '$1')
      .replace(/(事|です|なの|なんだ|ん|てる)。(じゃ|けど|が|し)/g, '$1$2')
      .replace(/(てる|てん)(ん)?。じゃない/g, '$1$2じゃない');

    // 「…と言うか/というか」で宙づりの時は軽く補完
    if (/言うか$/.test(t)) t += '、なんだろ？';

    out.push(
      `${speaker}${t.startsWith('A') || t.startsWith('B') ? '' : ''}${t.startsWith('A') || t.startsWith('B') ? '' : ' '}${t}`
        .replace(/\s{2,}/g, ' ')
        .replace(/^([AB])\s+/, '$1'),
    );
    lastSpeaker = speaker;
  }

  // 「A A…」の重複プレフィクスを念のため除去
  return out.map((line) => line.replace(/^([AB])\1+/, '$1')).join('\n');
}

// OpenAI 呼び出し（任意・簡易）
async function formatWithLLM(text: string): Promise<string> {
  const sys = `あなたは日本語テキスト整形器。以下を厳守：
- 要約・削除・意訳禁止（語順も極力保持）
- A=話者1（自分/右/緑）、B=話者2（相手/左/白）として各行に付与
- 位置/色の情報が無い箇所は会話の交互性と文の性質（疑問→応答など）で推定
- 記号ノイズや「濫」は ☀ に、誤認（おはよ一→おはよー、言っる→言ってる等）は軽く補正
- 句読点の過不足を自然な範囲で補う（「…と言うか」で終われば「、なんだろ？」）
- 出力は「A…」「B…」のみ（ヘッダ【#1】等は保持）、説明や余計な文は一切付けない`;

  const user = `原文：\n${text}\n---\n整形結果（A/B付きの行テキストのみ）：`;

  // OpenAI v1 Chat Completions 例（fetch直叩き）
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5-mini', // 手元のモデルに合わせて変更
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const out = data.choices?.[0]?.message?.content ?? '';
  return out.trim();
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== 'string') return new NextResponse('bad request', { status: 400 });

    // LLM が使えれば LLM、無ければフォールバック
    let formatted: string;
    if (OPENAI_API_KEY) {
      try {
        formatted = await formatWithLLM(text);
      } catch {
        formatted = fallbackFormat(text);
      }
    } else {
      formatted = fallbackFormat(text);
    }

    return new NextResponse(formatted, { status: 200 });
  } catch (e: any) {
    return new NextResponse(`error: ${e?.message ?? 'unknown'}`, { status: 500 });
  }
}
