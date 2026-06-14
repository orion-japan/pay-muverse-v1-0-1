// file: src/lib/iros/writers/microWriter.ts
// iros - Micro Writer (short reply only; no menu / no ABC)

export type MicroWriterGenerate = (args: {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;

  // ✅ 監査/追跡用（chatComplete に渡す）
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;

  // ✅ Policy: allowLLM（microGenerate 側の SKIP_POLICY に渡す）
  // - “存在する boolean だけ” を尊重するため、null/undefined を許可
  allowLLM_final?: boolean | null;

  // ✅ HistoryDigest v1（任意：渡ってきたら microGenerate 側で注入する）
  historyDigestV1?: unknown;
}) => Promise<string>;

export type MicroWriterInput = {
  /** 呼び名（UI表示名） */
  name: string;
  /** ユーザーの短文入力 */
  userText: string;
  /** 揺らぎ用seed（会話IDなどを混ぜる） */
  seed: string;

  // ✅ runMicroWriter → generate に引き継ぐ
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;

  // ✅ Policy: allowLLM（上流で確定した boolean をそのまま流す）
  allowLLM_final?: boolean | null;

  // ✅ HistoryDigest v1（任意：microGenerate に引き継ぐ）
  historyDigestV1?: unknown;
};

export type MicroWriterOutput =
  | { ok: true; text: string } // 1〜2行の短い返し
  | {
      ok: false;
      reason: 'format_invalid' | 'generation_failed' | 'empty_input';
      detail?: string;
    };

function normalizeMicroInput(s: string): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * MicroWriter に渡ってくる userText に、内部指示（「意味づけはしない」「次は2つだけ」等）が混ざることがある。
 * それを取り除いて、ユーザーの“生文”だけを取り出す。
 */
function extractUserUtterance(raw: string): string {
  const s = normalizeMicroInput(raw);
  if (!s) return '';

  // 1) まず最初の行だけで十分（Microは短文前提）
  const firstLine = s.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return '';

  // 2) 典型の内部指示を含む場合は、そこ以降を切る
  //   例: 「そうしましょう 意味づけはしない。 次は2つだけ： ...」
  const cutMarks = [
    '意味づけはしない',
    '次は2つだけ',
    '次は２つだけ',
    '・連想を',
    '・浮かんだ場面',
    '連想を3語',
    '浮かんだ場面を1つ',
  ];

  let out = firstLine;
  for (const m of cutMarks) {
    const idx = out.indexOf(m);
    if (idx >= 0) out = out.slice(0, idx).trim();
  }

  // 3) 句読点の後ろにくっついた余計なスペースを軽く整える
  out = out.replace(/\s+/g, ' ').trim();

  // 4) 末尾の記号を軽く落として短文化（過剰な終端記号だけ）
  out = out.replace(/[！!。．…]+$/g, '').trim();

  return out;
}

/**
 * Micro出力で許可する絵文字
 * - 🪔 は許可（最大1個）
 * - その他の絵文字は除去
 */
function sanitizeMicroEmoji(raw: string): string {
  const s = String(raw ?? '');

  const PLACEHOLDER = '__IROS_LAMP__';
  const escaped = s.replace(/🪔/g, PLACEHOLDER);

  // 絵文字っぽい文字（Extended_Pictographic）を除去
  const removed = escaped.replace(/\p{Extended_Pictographic}/gu, '');

  // 🪔を戻す
  const restored = removed.replace(new RegExp(PLACEHOLDER, 'g'), '🪔');

  // 🪔が複数あれば先頭1個だけ残す
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
 * LLM出力の「ラベル」を剥がす保険。
 * - 「連想:」「場面:」のようなテンプレを返してきた場合でも、短文として読める形に直す。
 */
function stripMicroLabels(s: string): string {
  const text = String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return '';

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (lines.length === 0) return '';

  const unlabel = (l: string) =>
    l
      .replace(/^連想\s*[:：]\s*/u, '')
      .replace(/^場面\s*[:：]\s*/u, '')
      .trim();

  const a = unlabel(lines[0]);
  const b = lines[1] ? unlabel(lines[1]) : '';

  // 両方あるなら「。」「\n」で繋ぐ（短文のまま）
  if (a && b) return `${a}\n${b}`;
  return (a || b).trim();
}

/**
 * LLM出力を「1〜2行」に丸める。
 * - "\\n" を実改行に復元
 * - Markdown hard break を普通の改行に寄せる
 * - 空行除去
 * - 3行以上なら先頭2行
 * - “メニュー/選択肢”っぽい形は拒否
 */
function coerceToTwoLines(raw: string): string | null {
  const normalize = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/[ \t]{2,}\n/g, '\n')
      .trim();

  const text = normalize(raw);
  if (!text) return null;

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  const first2 = lines.slice(0, 2);

  // “メニュー/選択肢”っぽい行頭を弾く
  const looksLikeMenu = first2.some((l) => /^(①|②|③|A[\s　]|B[\s　]|C[\s　]|・|-|\*|\d+\.)/.test(l));
  if (looksLikeMenu) return null;

  const joined = first2.join('\n');

  // UIで“短文”に見える範囲の上限
  const hardMax = 180;
  const clipped = joined.length > hardMax ? joined.slice(0, hardMax).trim() : joined;

  return clipped;
}

/**
 * スクショ/画像の催促を止める保険。
 * - 無料導線や端末差で画像添付できないユーザーがいるため、Microでは追加画像を求めない。
 * - 既存履歴・similarFlowSeed に「スクショ追加」系の文が混ざっても、最終出力で安全な短文に戻す。
 */
function sanitizeScreenshotPrompt(raw: string, name: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const hasMediaWord = /(スクショ|スクリーンショット|画像|写真|添付)/u.test(text);
  const hasRequestLike =
    /(送って|送る|送れ|貼って|貼る|添付|アップロード|追加|見せて|見せる|足りる|表示内容|もう一枚|もう1枚|ください|くれ)/u.test(text);

  if (hasMediaWord && hasRequestLike) {
    const prefix = name ? `${name}、` : '';
    return `${prefix}いま見えている範囲で進めます。足りないところは、言葉で一つだけ補えば大丈夫です。`;
  }

  return text;
}

export async function runMicroWriter(
  generate: MicroWriterGenerate,
  input: MicroWriterInput,
): Promise<MicroWriterOutput> {
  const name = String(input?.name ?? '').trim();
  const seed = String(input?.seed ?? '').trim();

  const traceId = input?.traceId ?? null;
  const conversationId = input?.conversationId ?? null;
  const userCode = input?.userCode ?? null;

  // ✅ allowLLM_final を “そのまま” 流す（存在する boolean だけが意味を持つ）
  const allowLLM_final =
    typeof (input as any)?.allowLLM_final === 'boolean' ? ((input as any).allowLLM_final as boolean) : null;

  // ✅ ここが最重要：内部指示（例：@NEXT_HINT / @I_LINE など）が userText に混入しても、Micro Writer の入力は“生文”のみになるように除去する。
  const userText = extractUserUtterance(input?.userText ?? '');

  if (!userText) {
    return { ok: false, reason: 'empty_input' };
  }

  // ざっくり分類：疲労系は「ブレを減らす」ために温度を下げる（文体の“整える”を別ロジックで強制しているわけではない）
  const core = userText.replace(/[?？]/g, '').replace(/\s+/g, '').trim();
  const isTiredMicro = /^(疲れた|休みたい|しんどい|つらい|無理|眠い)$/.test(core);

  // ✅ ACK系だけ「最後に1問」を許す（それ以外は質問0固定）
  const allowOneQuestion = /^(うん|うんうん|はい|そう|なるほど|ok|おけ|了解)$/.test(core.toLowerCase());

  const systemPrompt: string = `
あなたは iros の「Micro Writer」。
// NOTE: micro の「前に進む」は“軽い促し”までを含む。質問は原則0、入れても最大1つ（最後に短く）という制約で事故を防ぐ。
目的：短い入力に対して、“会話が前に進む短文”を1〜2行で返す。（問いは原則0。許す場合も最大1つで最後に短く）
判断・分析・説教・テンプレ応援をしない。余白を残す。

【出力ルール（厳守）】
- 出力は1〜2行のみ（3行以上は禁止）
- 選択肢（①②③/A/B/C/箇条書き/メニュー）を出さない
- ラベル（「連想:」「場面:」などの項目出し）をしない
- 質問は${allowOneQuestion ? '最大1つ（最後に短く）' : '0（禁止）'}
- 絵文字は 🪔 のみ可（最大1個）

【スクショ催促禁止（厳守）】
- スクショ、スクリーンショット、画像、写真、添付、アップロードを求めない
- 「スクショを送って」「画像を貼って」「もう一枚」「表示内容で足りる？」のような確認も禁止
- スクショ診断の文脈があっても、追加画像を催促しない
- 足りない場合は、画像ではなく「言葉で一つだけ補えば大丈夫」という方向にする
【テンプレ禁止（厳守）】
- 「了解」「わかった」「承知」「OK」だけで終えない
- 「大丈夫」「素晴らしい」「いいですね」「ワクワク」「きっと」などの応援テンプレを使わない
- 「〜してみると」「〜かもしれない」「と思います」などの hedging を多用しない
- 一般論・講義・長い共感はしない

【入力依存（必須）】
- 入力の語を1つだけ自然に混ぜる（引用符は不要）
- 返答は“次の一歩の形”がうっすら見える程度で止める

【ゆらぎ】
- seed=${seed} は言い回しの軽い揺らぎに使う（毎回同じ言い方に固定しない）
`.trim();

  const prompt: string = `
入力: ${userText}
呼び名: ${name || 'user'}
疲労系: ${isTiredMicro ? 'yes' : 'no'}

上のルールで、短い返答だけを生成して。
`.trim();

  let raw = '';
  try {
    raw = await generate({
      system: systemPrompt,
      prompt, // ✅ ここはこのファイルで作ってる prompt をそのまま渡す
      temperature: isTiredMicro ? 0.2 : 0.6, // ✅ temp変数は無いので直接
      maxTokens: 420,

      // ✅ 監査/追跡用（chatComplete に渡す）
      traceId,
      conversationId,
      userCode,

      // ✅ allowLLM（microGenerate 側で SKIP_POLICY を効かせる）
      allowLLM_final,

      // ✅ HistoryDigest v1（任意：microGenerate 側で注入する）
      historyDigestV1: (input as any).historyDigestV1 ?? null,
    });
  } catch (e: any) {
    return { ok: false, reason: 'generation_failed', detail: String(e?.message ?? e) };
  }

  const two = coerceToTwoLines(raw);
  if (!two) return { ok: false, reason: 'format_invalid' };

  // ✅ 「連想/場面」テンプレを返された場合の保険で剥がす
  const stripped = stripMicroLabels(two);

  const cleanedEmoji = sanitizeMicroEmoji(stripped);
  const finalText = sanitizeScreenshotPrompt(cleanedEmoji, name).trim();

  if (!finalText) return { ok: false, reason: 'format_invalid' };

  return { ok: true, text: finalText };
}
