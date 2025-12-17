// file: src/lib/iros/writers/microWriter.ts
// iros - Micro Writer (short reply only; no menu / no ABC)

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

  // Unicode絵文字（おおむね）を拾う：Extended_Pictographic
  // ※ 🪔 は許可するので、いったん🪔だけプレースホルダ退避
  const PLACEHOLDER = '__IROS_LAMP__';
  const escaped = s.replace(/🪔/g, PLACEHOLDER);

  // 絵文字っぽい文字を除去
  const removed = escaped.replace(/\p{Extended_Pictographic}/gu, '');

  // 🪔を戻す
  const restored = removed.replace(new RegExp(PLACEHOLDER, 'g'), '🪔');

  // 🪔が複数あれば先頭1個だけ残す
  const firstIdx = restored.indexOf('🪔');
  if (firstIdx === -1) return restored;

  const before = restored.slice(0, firstIdx + 2); // 🪔はサロゲートなので+2
  const after = restored.slice(firstIdx + 2).replace(/🪔/g, '');
  return (before + after).replace(/\s+$/g, '').trimEnd();
}

/**
 * LLM出力を「1〜2行」に丸める。
 * - 空行除去
 * - 3行以上なら先頭2行だけ採用
 * - 極端な長文は軽く切る（安全弁）
 */
function coerceToTwoLines(raw: string): string | null {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  const first2 = lines.slice(0, 2);

  // “メニュー/選択肢”っぽい行頭を弾く（くどさ防止）
  const looksLikeMenu = first2.some((l) =>
    /^(①|②|③|A[\s　]|B[\s　]|C[\s　]|・|-|\*|\d+\.)/.test(l),
  );
  if (looksLikeMenu) return null;

  // 2行を超える長さになりがちなときの安全弁（目安）
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

  if (!userText) {
    return { ok: false, reason: 'empty_input' };
  }

  // ざっくり分類（疲労系だけは“休む/整える”に寄せやすくする）
  const core = userText.replace(/[?？]/g, '').replace(/\s+/g, '').trim();
  const isTiredMicro = /^(疲れた|休みたい|しんどい|つらい|無理|眠い)$/.test(core);

  const system = `
あなたは iros の「Micro Writer」。
目的：短い入力に対して、“くどくない短文（1〜2行）”で返す。
この応答は深い分析や制御ロジックの代替ではなく、会話の「間」を作る。

【出力ルール（厳守）】
- 出力は1〜2行のみ（3行以上は禁止）
- 断定しない（状況/原因の決めつけ禁止）
- 説明・一般論・指南・分析は禁止
- 選択肢（①②③/A/B/C/箇条書き/メニュー）を出さない
- 質問は最大1つまで（必要なら最後に短く）
- 絵文字は使ってよい（🪔は可）。ただし最大1個まで（それ以外は使わない）

【ゆらぎ】
- seed=${seed} を言い回しの軽い揺らぎに使う（毎回同じ言い方にしない）
`.trim();

  const prompt = `
入力: ${userText}

トーン指示:
- 余白を作る（短く）
- でも投げっぱなしにしない
- ${isTiredMicro ? '疲労系なので「休む/整える」に自然に寄せてよい' : '決断/着手系なら「今の一点」を静かに受け止める'}
`.trim();

  try {
    const raw = await generate({
      system,
      prompt,
      // 短文を崩さず、固定化もしすぎない
      temperature: 0.7,
      maxTokens: 90,
    });

    const coerced = coerceToTwoLines(raw);
    if (!coerced) {
      return {
        ok: false,
        reason: 'format_invalid',
        detail: 'LLM output did not match 1-2 line no-menu format',
      };
    }

    // ✅ 🪔だけ許可（最大1個）
    const sanitized = sanitizeMicroEmoji(coerced);

    return { ok: true, text: sanitized };
  } catch (e) {
    return {
      ok: false,
      reason: 'generation_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
