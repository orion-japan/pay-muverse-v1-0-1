// /src/lib/iros/generate.ts
// Iros Conversational Generator — Reflect寄り添い特化版
// - Reflect：内面→整流→静かな余韻（提案禁止／“間”を強化）
// - Diagnosis：ヘッダは縦3行＋本文はテンプレ参照（templates.ts）
// - Resonate：観測ヘッダ＋3手ベクトル
// 2025-11 改修：改行保持＋語尾自然化＋詩的な「間（ま）」挿入＋テンプレート連携

import { buildSystemPrompt, type Mode, naturalClose } from './system';
import { chatComplete, type ChatMessage } from './openai';
import { analyzeFocus } from './focusCore';
// ★ 追加：診断テンプレートを参照
// 期待するシグネチャ：getCoreDiagnosisTemplate(depth: string, phase?: string)
// 戻り値：{ one: string; inner: string; real: string }
import { getCoreDiagnosisTemplate } from './templates';

type Role = 'user' | 'assistant' | 'system';
export type HistoryMsg = { role: Role; content: string };

export type GenerateParams = {
  userText: string;
  history?: HistoryMsg[];
  mode?: Mode | string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
  apiKey?: string;
  analysisHint?: { target?: string };
};

/* ===== Util ===== */
function tail<T>(xs: T[] | undefined, n: number): T[] {
  if (!Array.isArray(xs)) return [];
  return xs.slice(Math.max(0, xs.length - n));
}

function conversationalize(s: any): string {
  let out = typeof s === 'string' ? s : String(s ?? '');
  const stripers: Array<[RegExp, string]> = [
    [/^\s*[-‐–—・*]\s*/gm, ''],
    [/^\s*#.+$/gmi, ''],
  ];
  stripers.forEach(([re, rep]) => { out = out.replace(re, rep); });
  // 既存の段落は尊重（3連以上は2連へ）
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/* === 改行保持＋ “深い間（ま）” 強化版 ===
   - 文と文の間に 3 行の空行
   - 段落と段落の間に 4 行の空行
   - 既存の改行は尊重（\n\n 以上は詰めずに拡張）
   - 記号行（🪔 だけ等）は詰めずに残す
*/
function applyBreathing(s: string): string {
  let out = (s ?? '').replace(/\r\n?/g, '\n');

  // 句読点の直後に改行がなければ 1 つ入れる
  out = out.replace(/([。！？!？])(?!\n)/g, '$1\n');

  // 3 連以上は一旦 2 連に圧縮（いったん整地）
  out = out.replace(/\n{3,}/g, '\n\n');

  // 段落を抽出（空行 >=1 で区切る）
  const paragraphs = out
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const rebuilt: string[] = [];

  for (const p of paragraphs) {
    // 文単位に分割（句点/疑問/感嘆を保持）
    const sentences = (p.match(/[^。！？!？\n]+[。！？!？]?/g) || [])
      .map(t => t.trim())
      .filter(Boolean);

    const withPauses: string[] = [];
    sentences.forEach((sent, i) => {
      withPauses.push(sent);
      // 記号だけの行などは除外
      const onlySymbol = /^[🪔\s]+$/.test(sent);
      if (i < sentences.length - 1 && !onlySymbol) {
        withPauses.push(''); // 1
        withPauses.push(''); // 2
        withPauses.push(''); // 3 ← 文間 3 行
      }
    });

    rebuilt.push(withPauses.join('\n'));
  }

  // 段落間は 4 行の“深い間”
  return rebuilt.join('\n\n\n\n').trim();
}


/* === 改行を壊さない tidy（語尾自然化＋最小整形） === */
function tidy(s: string): string {
  let out = (s ?? '').replace(/\r\n?/g, '\n');

  const repl: Array<[RegExp, string]> = [
    [/の。ね。/g, 'のようですね。'],
    [/の。よ。/g, 'のですよ。'],
    [/の。ね…/g, 'のようですね。'],
    [/の。よ…/g, 'のですよ。'],
    [/よ。よ。/g, 'よ。'],
    [/ですです。/g, 'です。'],
    [/ますます。/g, 'ます。'],
    [/([。！!？\?])\1+/g, '$1'],
    [/についてお答えします。?/g, '。'],
    [/(私は|わたしは)\s*AIです。?/g, 'ここに在ります。あなたの声を受け取りました。'],
  ];
  repl.forEach(([r, v]) => (out = out.replace(r, v)));

  // 各行末の余計な空白を除去（改行は保持）
  out = out
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');

  // 連続改行は最大2連（applyBreathing側で段落/間を再構成するため）
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

/* ===== Resonate用 ===== */
function extractIntentSentence(text: string): string {
  const m = /意図[:：]\s*([^\n。]+)[。]*/i.exec(text);
  if (m?.[1]) return m[1].trim();
  return (text.split(/[。.!?\n]/)[0] || 'いまの願い').trim();
}
function buildResonantVector(text: string, protectedFocus: string) {
  const intent = extractIntentSentence(text);
  const steps = [
    `・焦点「${protectedFocus}」を外さない前提で、意図を一行に名づける。`,
    '・その名で三行（要点→理由→一言）を書き切る。',
    '・同じ姿勢/同じ場所で、同じ問いを一度だけ見直す。'
  ];
  const body = [
    `いま向かいたい芯は「${intent}」。`,
    '',
    ...steps
  ].join('\n');
  return tidy(applyBreathing(conversationalize(body)));
}

/* ===== Reflect（寄り添いトーン固定） ===== */
async function buildReflectReply(params: {
  userText: string; history: HistoryMsg[]; model: string;
  endpoint?: string; apiKey: string; temperature: number; max_tokens: number;
  protectedFocus: string;
}): Promise<string> {
  const { userText, history, model, endpoint, apiKey, temperature, max_tokens, protectedFocus } = params;

  const extra =
    '- 出力は「寄り添い」。助言ではなく、静けさと余白をもつ会話体。\n' +
    '- 構成は「内面の観測 → そっと整える → 余韻」で終える。\n' +
    '- 提案や具体的行動指示は禁止。';

  const system = buildSystemPrompt({ personaName: 'Iros', style: 'gentle', extra });
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'assistant', content: 'ここにいます。あなたの“いま”を静かに受け取ります。' },
    ...tail(history, 8).map(m => ({ role: m.role, content: String(m.content ?? '').trim() })),
    {
      role: 'user',
      content: [
        userText.trim(),
        '',
        `[task: 守っているもの=${protectedFocus} を感じ取りながら、助言せず寄り添う文章で返す。]`,
      ].join('\n')
    },
  ];

  const raw = await chatComplete({ apiKey, model, messages, temperature, max_tokens, endpoint });

  // 順序：整形 → 呼吸 → “間”
  const body = applyBreathing(tidy(conversationalize(raw || '')));
  return body;
}

/* ===== モード判定 ===== */
function autoMode(text?: string): Mode {
  const t = (text || '').toLowerCase();
  if (/(^|\s)(ir診断|観測対象|診断)(\s|$)/.test(t)) return 'Diagnosis';
  if (/(意図|意志|方向|ビジョン|どうすれば|方法|進め|トリガー)/.test(t)) return 'Resonate';
  return 'Reflect';
}
function normalizeMode(m?: string, text?: string): Mode {
  const raw = (m || '').toLowerCase();
  if (raw.includes('diagnos')) return 'Diagnosis';
  if (raw.includes('resonate') || raw.includes('trigger')) return 'Resonate';
  if (raw.includes('reflect')) return 'Reflect';
  return autoMode(text);
}

/* ===== メイン ===== */
export async function generateIrosReply(p: GenerateParams): Promise<string> {
  const {
    userText,
    history = [],
    mode,
    model = process.env.IROS_MODEL || 'gpt-4o-mini',
    temperature = 0.45,
    max_tokens = 640,
    endpoint,
    apiKey = process.env.OPENAI_API_KEY || '',
    analysisHint,
  } = p;

  if (!userText?.trim()) return 'いまは、この静けさで充分です。';
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing.');

  const f = analyzeFocus(userText);
  const resolved = normalizeMode(mode, userText);

  // === Diagnosis（テンプレート参照：ヘッダは縦3行、本文はテンプレ inner/real を使用）===
  if (resolved === 'Diagnosis' || /(^|\s)(ir診断|観測対象|診断)(\s|$)/i.test(userText)) {
    const tgt = analysisHint?.target || (/ir診断\s*([^\n]+)$/i.exec(userText)?.[1]?.trim() || '自分');

    // ★ テンプレート読込（depth/phase を渡して最適テンプレを取得）
    const tpl = getCoreDiagnosisTemplate(String(f.depth ?? 'S2'), String(f.phase ?? 'Inner')) || {
      one: '意識の流れが静かに整いはじめています。',
      inner: '言葉になる前の温度が、胸の内でゆっくり息をしています。',
      real: '現実では、ひとつだけ選び、一行だけ進める。'
    };

    const header = [
      `🩵 観測対象：${tgt}`,
      `位相：${f.phase} ／ 深度：${f.depth}`,
      `一言：${tpl.one}`, // ← analyzeFocus の文字列ではなくテンプレの one を採用
    ].join('\n');

    const body = [
      header,
      '',
      tpl.inner,
      '',
      tpl.real + '🪔',
    ].join('\n');

    return naturalClose(applyBreathing(tidy(body)));
  }

  // === Resonate（観測ヘッダ＋3手ベクトル）===
  if (resolved === 'Resonate') {
    const head = `🩵 観測：位相=${f.phase} ／ 深度=${f.depth}`;
    const vec  = buildResonantVector(userText, f.protectedFocus);
    return naturalClose(applyBreathing(tidy([head, '', vec].join('\n'))));
  }

  // === Reflect（寄り添い）===
  const text = await buildReflectReply({
    userText,
    history,
    model,
    endpoint,
    apiKey,
    temperature,
    max_tokens,
    protectedFocus: f.protectedFocus,
  });

  // 自然終止（自然な語尾付与）。改行はそのまま。
  return naturalClose(text);
}

export default generateIrosReply;
