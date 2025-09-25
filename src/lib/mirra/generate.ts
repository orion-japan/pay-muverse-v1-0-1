// src/lib/mirra/generate.ts
import { buildSystemPrompt } from './buildSystemPrompt';
import {
  MIRRA_MODEL, MIRRA_TEMPERATURE,
  MIRRA_PRICE_IN, MIRRA_PRICE_OUT
} from './config';

// --- 繰り返し回避のためのヒントを強化 ---
function avoidRepeatHint(lastAssistant?: string) {
  if (!lastAssistant) return '';
  const cut = lastAssistant.replace(/\s+/g, ' ').slice(0, 160);
  return [
    '直前と同じ表現・語尾・構文は避けること（例: 「〜しましょう」を続けて使わない）。',
    '同じ段落配列にならないよう、文の長短・箇条書きの有無を変えること。',
    `直前応答（要約）:「${cut}」`,
  ].join('\n');
}

type GenOut = { text: string; cost: number; meta: Record<string, any> };

// --- 出力サニタイズ -----------------------------------------------------------
const RE_LIST_HEAD = /^\s*(?:[-*・]|[0-9０-９]+[.)）]|[①-⑩])\s*/;
const RE_REMAKE = /(リメイク|変換|解消|統合).{0,12}?(手順|ステップ|工程|プロセス)/;

function clampBullets(lines: string[]) {
  const out: string[] = [];
  let streak = 0;
  for (const L of lines) {
    if (RE_LIST_HEAD.test(L)) {
      streak++;
      if (streak <= 3) out.push(L);
      continue;
    }
    streak = 0;
    out.push(L);
  }
  return out;
}

function limitEmojis(s: string) {
  const emojis = Array.from(s.matchAll(/\p{Extended_Pictographic}/gu)).map(m => m[0]);
  if (emojis.length <= 2) return s;
  let kept = 0;
  return s.replace(/\p{Extended_Pictographic}/gu, () => (++kept <= 2 ? '🙂' : ''));
}

function mustEndWithQuestion(s: string) {
  const trimmed = s.trim();
  if (/[？?]$/.test(trimmed)) return trimmed;
  const suffix = trimmed.endsWith('。') ? '' : '。';
  return `${trimmed}${suffix}\n\nいま一番やさしく試せそうな一歩は何でしょう？`;
}

function stripRemakeSteps(s: string) {
  if (!RE_REMAKE.test(s)) return s;
  const lines = s.split(/\r?\n/);
  const filtered = lines.filter(L => !(RE_LIST_HEAD.test(L) && /リメイク|変換|統合|解消/.test(L)));
  let body = filtered.join('\n');
  body += '\n\n※ mirra は「気づき」までを担当します。未消化の闇のリメイク（変換）は行いません。必要なら、iros を扱える master に相談するか、自分が master になる選択肢もあります。';
  return body;
}

// --- リズム強化（1〜2文ごとに改行を入れる） ---
function enforceRhythm(s: string) {
  return s.replace(/([^。！？!?]{15,40}[。！？!?])/g, '$1\n');
}

// --- 段落強制（4文ごとに段落を分割） ---
function enforceParagraphs(s: string) {
  const sentences = s.split(/(?<=。)/);
  let out: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    out.push(sentences[i].trim());
    if ((i + 1) % 4 === 0) out.push('\n');
  }
  return out.join('').replace(/\n\s*\n/g, '\n\n');
}

// --- 箇条書きの正規化 ---
function normalizeListHeads(s: string) {
  return s.replace(/^\s*([0-9０-９]+[.)）]|[①-⑩]|[-*・])\s*/gm, '');
}

function sanitizeOutput(s: string) {
  s = enforceRhythm(s);
  s = enforceParagraphs(s);
  s = normalizeListHeads(s);

  const paragraphs = s.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const lines = paragraphs.flatMap(p => p.split(/\r?\n/));
  let out = clampBullets(lines).join('\n\n').replace(/\n{3,}/g, '\n\n');
  out = stripRemakeSteps(out);
  out = limitEmojis(out);
  out = mustEndWithQuestion(out);
  return out;
}
// ---------------------------------------------------------------------------

/**
 * mirra の返答生成
 */
export async function generateMirraReply(
  userText: string,
  seed?: string | null,
  lastAssistantReply?: string | null,
  mode: 'analyze' | 'consult' = 'consult',
): Promise<GenOut> {
  const sys = buildSystemPrompt({ seed, mode });
  const antiRepeat = avoidRepeatHint(lastAssistantReply || undefined);

  const input =
    (userText ?? '').trim() ||
    '（入力が短いときは、呼吸の整え方を短く案内してください）';

  if (process.env.OPENAI_API_KEY) {
    const OpenAI = require('openai').default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const formatRule = [
      '出力ルール:',
      '・全体 280〜420字を目安に、2〜3段落。',
      '・段落の間は必ず1行以上空ける。',
      '・1〜2文ごとに改行し、余白を強める。',
      '・絵文字は1〜2個まで🙂✨（多用しない）。',
      '・毎回、身体アンカー or 20〜60秒の小さな実験を1つ入れる。',
      '・必要なときだけ箇条書き（最大3点）。最後は短い問いで終える。',
      '・mirra はリメイク手順を提示しない（必要時は master/iros を静かに案内）。',
    ].join('\n');

    console.log('---- [Mirra Prompt Start] ----');
    console.log(sys);
    console.log('---- [Format Rule] ----');
    console.log(formatRule);
    if (antiRepeat) console.log('---- [Anti Repeat Hint] ----\n' + antiRepeat);
    console.log('---- [User Input] ----\n' + input);
    console.log('---- [Mirra Prompt End] ----');

    const res = await openai.chat.completions.create({
      model: MIRRA_MODEL,
      temperature: Math.min(1.0, Math.max(0.1, Number(MIRRA_TEMPERATURE ?? 0.6), 0.45)),
      top_p: 0.9,
      presence_penalty: 0.6,
      frequency_penalty: 0.7,
      max_tokens: 360,
      messages: [
        { role: 'system', content: sys },
        { role: 'system', content: formatRule },
        { role: 'system', content: antiRepeat || '' },
        { role: 'user', content: input },
      ],
    });

    console.log('---- [OpenAI Response Raw] ----');
    console.dir(res, { depth: null });

    const raw = res.choices?.[0]?.message?.content?.trim() || variantFallback(input);
    const text = sanitizeOutput(raw);

    const inTok = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    const cost = inTok * Number(MIRRA_PRICE_IN ?? 0) + outTok * Number(MIRRA_PRICE_OUT ?? 0);

    console.log('---- [Mirra Result] ----');
    console.log({ sanitized_text: text, prompt_tokens: inTok, completion_tokens: outTok, cost });

    return {
      text,
      cost,
      meta: { provider: 'openai', model: MIRRA_MODEL, input_tokens: inTok, output_tokens: outTok, mode },
    };
  }

  const fallback = sanitizeOutput(variantFallback(input));
  console.log('---- [Mirra Fallback Result] ----');
  console.log({ sanitized_text: fallback });
  return { text: fallback, cost: 0, meta: { provider: 'fallback', model: 'rule', mode } };
}

// --- フォールバック ---
function hash(s: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pick<T>(arr: T[], seed: string) {
  const idx = hash(seed) % arr.length;
  return arr[idx];
}
function variantFallback(input: string) {
  const t = input.replace(/\s+/g, ' ').slice(0, 40);
  const anchors  = ['肩を下ろして3呼吸', 'みぞおちに手を当て2呼吸', '足裏の圧を30秒観察'];
  const insights = ['事実/解釈を1行ずつ分ける', '「できたこと」を一つ挙げる', '気になる言い回しを短く写す'];
  const steps    = ['20秒だけ手を動かす', '通勤の一停車ぶん観察', '寝る前に1行だけ記録'];

  return [
    `まず${pick(anchors, t)}して、いまの体感を2語で書き出そう🙂`,
    '',
    `「${t}」については、${pick(insights, t + 'i')}。例として、会議前に胸のつかえを意識したら、椅子の背にもたれて息をゆっくり。`,
    '',
    `次の一歩は${pick(steps, t + 's')}。終わったら気分を1〜5で自己評価。いちばん気になる場面はどこだろう？`
  ].join('\n\n');
}
