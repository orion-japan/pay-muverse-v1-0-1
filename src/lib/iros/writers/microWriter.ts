// file: src/lib/iros/writers/microWriter.ts
// iros - Micro Writer (short reply only; no menu / no ABC)

export type MicroWriterGenerate = (args: {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;

  // ✅ 追加：監査/追跡用（chatComplete に渡す）
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
}) => Promise<string>;

export type MicroWriterInput = {
  /** 呼び名（UI表示名） */
  name: string;
  /** ユーザーの短文入力 */
  userText: string;
  /** 揺らぎ用seed（会話IDなどを混ぜる） */
  seed: string;

  // ✅ 追加：runMicroWriter → generate に引き継ぐ
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

export type MicroWriterOutput =
  | { ok: true; text: string } // 1〜2行の短い返し
  | {
      ok: false;
      reason: 'format_invalid' | 'generation_failed' | 'empty_input';
      detail?: string;
    };

function normalizeMicro(s: string): string {
  return String(s ?? '')
    .trim()
    .replace(/[！!。．…]+$/g, '')
    .trim();
}

/**
 * Micro出力で許可する絵文字
 * - 🪔 は許可（最大1個）
 * - その他の絵文字は除去
 */
function sanitizeMicroEmoji(raw: string): string {
  const s = String(raw ?? '');

  // ※ 🪔 は許可するので、いったん🪔だけプレースホルダ退避
  const PLACEHOLDER = '__IROS_LAMP__';
  const escaped = s.replace(/🪔/g, PLACEHOLDER);

  // 絵文字っぽい文字（Extended_Pictographic）を除去
  const removed = escaped.replace(/\p{Extended_Pictographic}/gu, '');

  // 🪔を戻す
  const restored = removed.replace(new RegExp(PLACEHOLDER, 'g'), '🪔');

  // 🪔が複数あれば先頭1個だけ残す（コードポイントで安全に）
  const chars = Array.from(restored);
  const first = chars.indexOf('🪔');
  if (first === -1) return restored.trim();

  const out = chars
    .map((c, i) => (c === '🪔' && i !== first ? '' : c))
    .join('')
    .replace(/\s+$/g, '')
    .trimEnd();

  return out.trim();
}

/**
 * LLM出力を「1〜2行」に丸める（フォーマット揺れに強くする）。
 * - "\\n"（バックスラッシュn）を実改行に復元
 * - Markdown hard break（"  \n"）を普通の改行扱いに寄せる
 * - 空行除去
 * - 3行以上なら先頭2行だけ採用
 * - 極端な長文は軽く切る（安全弁）
 * - “メニュー/選択肢”っぽい形は拒否
 */
function coerceToTwoLines(raw: string): string | null {
  const normalize = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // LLMが "\\n" をテキストとして返すケースを救う
      .replace(/\\n/g, '\n')
      // Markdown hard break（2スペ+改行）を普通の改行に寄せる
      .replace(/[ \t]{2,}\n/g, '\n')
      .trim();

  const text = normalize(raw);
  if (!text) return null;

  // 行に分解（空行は落とす）
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  // 3行以上なら先頭2行へ
  const first2 = lines.slice(0, 2);

  // “メニュー/選択肢”っぽい行頭を弾く（くどさ防止）
  const looksLikeMenu = first2.some((l) =>
    /^(①|②|③|A[\s　]|B[\s　]|C[\s　]|・|-|\*|\d+\.)/.test(l),
  );
  if (looksLikeMenu) return null;

  // 2行合計が伸びすぎるときの安全弁
  const joined = first2.join('\n');
  const hardMax = 220; // UIで“短文”に見える範囲の上限
  const clipped = joined.length > hardMax ? joined.slice(0, hardMax).trim() : joined;

  return clipped;
}

export async function runMicroWriter(
  generate: MicroWriterGenerate,
  input: MicroWriterInput,
): Promise<MicroWriterOutput> {
  const name = String(input?.name ?? '').trim();
  const userTextRaw = String(input?.userText ?? '');
  const userText = normalizeMicro(userTextRaw);
  const seed = String(input?.seed ?? '').trim();

  const traceId = input?.traceId ?? null;
  const conversationId = input?.conversationId ?? null;
  const userCode = input?.userCode ?? null;

  if (!userText) {
    return { ok: false, reason: 'empty_input' };
  }

  // ざっくり分類（疲労系だけは“休む/整える”に寄せやすくする）
  const core = userText.replace(/[?？]/g, '').replace(/\s+/g, '').trim();
  const isTiredMicro = /^(疲れた|休みたい|しんどい|つらい|無理|眠い)$/.test(core);

  const systemPrompt: string = `
あなたは iros の「Micro Writer」。
目的：短い入力に対して、“くどくない短文（1〜2行）”で返す。
この応答は「判断」ではなく、「会話の間」と「次の一歩の余白」を作る。

【出力ルール（厳守）】
- 出力は1〜2行のみ（3行以上は禁止）
- 判断しない（原因/結論/評価を作らない）
- 説明・一般論・助言・分析は禁止（長くなるのでやらない）
- 選択肢（①②③/A/B/C/箇条書き/メニュー）を出さない
- 質問は原則0（入れるなら最大1つ、短く、最後に）
- 絵文字は 🪔 のみ可（最大1個）

【テンプレ禁止（厳守）】
- 「了解」「わかった」「承知」「OK」など“受領だけ”で終えない
- 「大丈夫」「素晴らしい」「いいですね」「楽しみですね」「ワクワク」「きっと」などの応援テンプレを使わない
- 「〜してみると」「〜かもしれない」「と思います」などの hedging（逃げ）を使わない
- “定型の一言”に逃げない（入力依存の語を必ず含める）

【入力から1語拾う（必須）】
- 入力文から単語を1つだけ拾って、返答に自然に混ぜる（引用符は不要）
- その単語が短すぎる場合は、入力の勢い（語尾/熱量）を1フレーズで拾う

【sofia寄せ（短く静かに）】
- 温度は上げない（煽らない/盛らない）
- 受け止めは“軽く一回”で止める
- 刺さりは「一言」で十分。長い共感はしない

【ゆらぎ】
- seed=${seed} を言い回しの軽い揺らぎに使う（毎回同じ言い方にしない）
`.trim();

  const prompt: string = `
入力: ${userText}

トーン指示:
- 名前: ${name || 'user'}
- 疲労系: ${isTiredMicro ? 'yes' : 'no'}

上のルールで、短い返答だけを生成して。
`.trim();

  let raw = '';
  try {
    raw = await generate({
      system: systemPrompt,
      prompt,
      temperature: isTiredMicro ? 0.35 : 0.6,
      maxTokens: 140,

      // ✅ 追加：trace を generate に引き継ぐ
      traceId,
      conversationId,
      userCode,
    });
  } catch (e: any) {
    return { ok: false, reason: 'generation_failed', detail: String(e?.message ?? e) };
  }

  const two = coerceToTwoLines(raw);
  if (!two) return { ok: false, reason: 'format_invalid' };

  const cleaned = sanitizeMicroEmoji(two);
  const finalText = cleaned.trim();

  if (!finalText) return { ok: false, reason: 'format_invalid' };

  return { ok: true, text: finalText };
}
