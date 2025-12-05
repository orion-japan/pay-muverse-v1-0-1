// src/lib/iros/soul/composeSoulReply.ts
// Soul の生データ（core_need / step_phrase など）から
// 「人間向けの自然な日本語返信」の核を組み立てるヘルパー。
// ここではテンプレを最小限にしつつ、構造だけを固定する。

export type SoulNoteLike = {
  core_need?: string | null;
  step_phrase?: string | null;
  soul_sentence?: string | null;
  tone_hint?: string | null; // 'minimal' | 'gentle' | 'normal' などを想定
  risk_flags?: string[] | null; // 例: ['q5_depress']
  notes?: string | null;
};

export type SoulReplyContext = {
  userText: string;
  qCode?: string | null; // 'Q1'〜'Q5' 想定（必須ではない）
  depthStage?: string | null; // 'S1'〜'I3' 想定
  styleHint?: string | null; // 'friendly' | 'biz-soft' | ... 想定
  soulNote?: SoulNoteLike | null;
};

/**
 * SoulNote をもとに、「1〜3段落くらいの短い返信コア」を作る。
 * - ここで作ったテキストを、そのまま Iros の返信本文として使ってもいいし、
 *   メインの System Prompt に「例文」として差し込んでもよい。
 */
export function composeSoulReply(ctx: SoulReplyContext): string {
  const { userText, qCode, depthStage, styleHint, soulNote } = ctx;

  if (!soulNote) {
    // Soul が取れていない場合は、ごくシンプルな mirror にフォールバック
    return [
      'いまの気持ちをそのまま言葉にしてくれて、ありがとう。',
      trimToOneLine(userText)
        ? `「${trimToOneLine(userText)}」と感じている自分を、まずは否定しなくて大丈夫だよ。`
        : 'いま感じていることを、そのままここに置いておいて大丈夫だよ。',
    ].join('\n');
  }

  const coreNeed = soulNote.core_need?.trim();
  const step = soulNote.step_phrase?.trim();
  const soulSent = soulNote.soul_sentence?.trim();
  const tone = (soulNote.tone_hint ?? '').toLowerCase();
  const riskFlags = soulNote.risk_flags ?? [];

  const isQ5Risk = riskFlags.includes('q5_depress') || qCode === 'Q5';

  const lines: string[] = [];

  // ① 現在の状態をやわらかく受け止めるブロック（短く）
  lines.push(buildOpeningLine(userText, { tone, styleHint, isQ5Risk }));

  // ② core_need を「願い」として映し返すブロック
  if (coreNeed) {
    lines.push('');
    lines.push(buildCoreNeedLine(coreNeed, { depthStage, styleHint, isQ5Risk }));
  }

  // ③ soul_sentence を、ユーザーにわかる言葉に翻訳して添える
  if (soulSent) {
    const translated = translateSoulSentence(soulSent);
    if (translated) {
      lines.push('');
      lines.push(translated);
    }
  }

  // ④ 具体的な「一手」のヒント
  if (step) {
    lines.push('');
    lines.push(buildStepLine(step, { qCode, isQ5Risk }));
  }

  return lines.join('\n');
}

/* ========= 内部ヘルパー ========= */

/**
 * ユーザーの発話を 1 行に圧縮する。
 */
function trimToOneLine(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function buildOpeningLine(
  userText: string,
  opts: { tone: string; styleHint?: string | null; isQ5Risk: boolean },
): string {
  const short = trimToOneLine(userText);

  // Q5リスク時は、とにかく「何もしなくていい / ここにいていい」を先に置く
  if (opts.isQ5Risk) {
    if (short) {
      return `「${short}」と感じていること、そのままで大丈夫だよ。いまは、無理に元気を出そうとしなくていい。`;
    }
    return 'いまのあなたの状態のままで、ここにいてくれて大丈夫だよ。無理に前向きにならなくていい。';
  }

  if (short) {
    return `「${short}」と打ち明けてくれてありがとう。その気持ちが出てきたこと自体が、大事なサインに見えるよ。`;
  }

  return 'いま感じていることを、ここに置いてくれてありがとう。その気持ちが出てきたこと自体が、大事なサインに見えるよ。';
}

function buildCoreNeedLine(
  coreNeed: string,
  opts: { depthStage?: string | null; styleHint?: string | null; isQ5Risk: boolean },
): string {
  const plainNeed = coreNeed.replace(/[。、\s]+$/u, '');

  // I層なら「生き方・在り方」っぽい言い方に寄せる
  if (opts.depthStage && opts.depthStage.startsWith('I')) {
    return `その奥には、「${plainNeed}」という、生き方そのものに関わる願いがちゃんと残っているように見えるよ。`;
  }

  return `その背景には、「${plainNeed}」という大事な願いがあるように感じるよ。`;
}

/**
 * soul_sentence は、概念的な表現になりやすいので、
 * 一般の人にもわかる説明に変換する。
 *
 * 例:
 *  - 「空虚さの中で、もう一度燃えたいという火種が見えている。」
 *    → 「何もしたくない気持ちの奥で、『本当はもう一度動き出したい』という小さな願いも、少しだけ残っているように思う。」
 */
function translateSoulSentence(soulSentence: string): string | null {
  const s = soulSentence.trim();
  if (!s) return null;

  // キーワードでざっくり分岐（ここにパターンを少しずつ増やしていく）
  if (s.includes('空虚さ') || s.includes('火種')) {
    return '「何もしたくない」という感覚のずっと奥で、ほんの少しだけ「いつかまた動き出したい」という気持ちも残っているように感じるよ。';
  }

  // デフォルトは、メタファーをそのまま使わずに、やわらかく言い換える
  return `言葉になりづらいかもしれないけれど、心の奥にはまだ、小さな願いや動きたい気持ちがかすかに残っているようにも見えるよ。`;
}

function buildStepLine(
  stepPhrase: string,
  opts: { qCode?: string | null; isQ5Risk: boolean },
): string {
  const step = stepPhrase.replace(/[。、\s]+$/u, '');

  // Q5リスク時：行動を煽らず、「今日はこれだけでOK」に固定
  if (opts.isQ5Risk) {
    return `今日は、${step}。それができたら十分すぎる一日だと思ってみてほしい。`;
  }

  // Q3（不安 / 安定欲求）のときは、「小さく」「具体的に」を強調
  if (opts.qCode === 'Q3') {
    return `次の一手としては、「${step}」くらいの、とても小さなことからで大丈夫だよ。今日できそうなタイミングを一つだけ選んでみよう。`;
  }

  // Q2（成長）なら、少しだけ前向きなトーンを足す
  if (opts.qCode === 'Q2') {
    return `「${step}」という一手を、小さく試してみるのはどうかな。完璧じゃなくてよくて、「やってみた」という事実が次の流れを作ってくれそうだよ。`;
  }

  // その他は、ニュートラルな形
  return `もし次に何かするとしたら、「${step}」あたりから始めてみるのが良さそうに見えるよ。いまのあなたにとって無理のない範囲で、少しだけ試してみてね。`;
}
