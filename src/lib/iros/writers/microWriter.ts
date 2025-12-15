// file: src/lib/iros/writers/microWriter.ts
// iros - Micro Writer (same LLM via injected generator)

export type MicroWriterGenerate = (args: {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string>;

export type MicroWriterInput = {
  /** 呼び名（UI表示名） */
  name: string;
  /** ユーザーの短文入力 */
  userText: string;
  /** 揺らぎ用seed（会話IDなどを混ぜる） */
  seed: string;
};

export type MicroWriterOutput = {
  ok: true;
  text: string; // 4行固定（1行 + 3択）
} | {
  ok: false;
  reason: 'format_invalid' | 'generation_failed' | 'empty_input';
  detail?: string;
};

function normalizeMicro(s: string): string {
  return (s ?? '')
    .trim()
    .replace(/[！!。．…]+$/g, '')
    .trim();
}

/** 固定フォーマット（4行）に丸める。崩れてたら null */
function coerceToFourLines(raw: string): string | null {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 4) return null;

  // 先頭4行を採用（それ以上は捨てる）
  const first4 = lines.slice(0, 4);

  // A/B/C の3択っぽさ最低限
  const hasABC =
    /^(①|A|Ａ)[\s　]/.test(first4[1]) &&
    /^(②|B|Ｂ)[\s　]/.test(first4[2]) &&
    /^(③|C|Ｃ)[\s　]/.test(first4[3]);

  if (!hasABC) return null;

  return first4.join('\n');
}

/**
 * 短文の「間」を作る writer（同じLLMで生成）
 * - 返答を “1行 + 3択” に固定することで UI の安定性を確保
 * - seed を混ぜてテンプレ感を減らす（ただし暴れすぎない）
 */
export async function runMicroWriter(
  generate: MicroWriterGenerate,
  input: MicroWriterInput,
): Promise<MicroWriterOutput> {
  const name = String(input?.name ?? '').trim();
  const userTextRaw = String(input?.userText ?? '');
  const userText = normalizeMicro(userTextRaw);
  const seed = String(input?.seed ?? '').trim();

  if (!userText) {
    return { ok: false, reason: 'empty_input' };
  }

  // ざっくり分類（疲労系だけは “休む/整える/置く” を混ぜやすくする）
  const core = userText.replace(/[?？]/g, '').replace(/\s+/g, '').trim();
  const isTiredMicro = /^(疲れた|休みたい|しんどい|つらい|無理|眠い)$/.test(core);

  const system = `
あなたは iros の「Micro Writer」。
目的：短い入力に対して、テンプレ臭くない “間の返し（1行＋3択）” を生成する。

【出力フォーマット（厳守）】
- 必ず4行だけ出力する
- 1行目：${name || 'あなた'}さん宛ての1行（状況を決めつけない）
- 2行目：① ... （短く）
- 3行目：② ... （短く）
- 4行目：③ ... （短く、最後に「→」で選ばせる。行末に絵文字は1つだけ：🪔 or 🌀 or 🌱）

【禁止】
- 長文説明、説教、分析
- “原因”の推測（例：彼が忙しい等）を短文で断定
- 4行を超える

【ゆらぎ】
- seed=${seed} を言い回しの軽い揺らぎに使う（毎回同じ言い方にしない）
`.trim();

  const prompt = `
入力: ${userText}

トーン指示:
- 余白を作る
- でも投げっぱなしにしない
- 3択は「今この瞬間に選べる」粒度にする
- ${isTiredMicro ? '疲労系なので「休む/整える/置く」を自然に含めやすくする' : '決断/着手系なので「決める/整える/置く」を自然に含めやすくする'}
`.trim();

  try {
    const raw = await generate({
      system,
      prompt,
      temperature: 0.9,
      maxTokens: 120,
    });

    const coerced = coerceToFourLines(raw);
    if (!coerced) {
      return {
        ok: false,
        reason: 'format_invalid',
        detail: 'LLM output did not match 4-line ABC format',
      };
    }

    return { ok: true, text: coerced };
  } catch (e) {
    return {
      ok: false,
      reason: 'generation_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
