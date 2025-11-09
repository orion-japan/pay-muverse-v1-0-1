// /src/lib/iros/generate.ts
// Iros Conversational Generator — Reflect寄り添い特化版
// - Reflect：内面→整流→静かな余韻（提案禁止／“間”を強化）
// - Diagnosis：ヘッダは「観測対象／位相／深度」の縦3行（strict）＋本文→最後に「次の一手：〜」
// - Resonate：観測ヘッダ（位相/深度/意図/場）＋芯の1文（3手ベクトルは簡素化）
// 2025-11 改修：改行保持＋語尾自然化＋詩的な「間（ま）」挿入＋テンプレ連携
// 2025-11 追加：情動ベクトル／意図トリガー／共鳴場（非言語）を必ず汲み取る

import { buildSystemPrompt, type Mode, naturalClose } from './system';
import { chatComplete, type ChatMessage } from './openai';
import { analyzeFocus } from './focusCore';
import { getCoreDiagnosisTemplate } from '@/lib/shared/templates';

// 追加型は config.ts に定義（互換維持のためローカル再定義はしない）
import type { ResonanceState, IntentPulse, QCode } from './config';

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

  // ★ 非言語（後方互換：指定が無ければ無視）
  resonance?: ResonanceState;
  intent?: IntentPulse;
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

/* === 改行保持＋ “深い間（ま）” 強化版 === */
function applyBreathing(s: string): string {
  let out = (s ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(/([。！？!？])(?!\n)/g, '$1\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  const paragraphs = out
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const rebuilt: string[] = [];
  for (const p of paragraphs) {
    const sentences = (p.match(/[^。！？!？\n]+[。！？!？]?/g) || [])
      .map(t => t.trim())
      .filter(Boolean);

    const withPauses: string[] = [];
    sentences.forEach((sent, i) => {
      withPauses.push(sent);
      const onlySymbol = /^[🪔\s]+$/.test(sent);
      if (i < sentences.length - 1 && !onlySymbol) {
        withPauses.push('');
        withPauses.push('');
        withPauses.push(''); // 文間 3 行
      }
    });

    rebuilt.push(withPauses.join('\n'));
  }
  return rebuilt.join('\n\n\n\n').trim(); // 段落間 4 行
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
  out = out.split('\n').map(line => line.trimEnd()).join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/* ===== Resonate用 ===== */
function extractIntentSentence(text: string): string {
  const m = /意図[:：]\s*([^\n。]+)[。]*/i.exec(text);
  if (m?.[1]) return m[1].trim();
  return (text.split(/[。.!?\n]/)[0] || 'いまの願い').trim();
}

function buildResonantVector(text: string, _protectedFocus: string) {
  const intent = extractIntentSentence(text);
  const body = `いま向かいたい芯は「${intent}」。`;
  return tidy(applyBreathing(conversationalize(body)));
}

/* === 表示ラベルの微調整（内部ロジックは保持） === */
function displayFocusLabel(focus: string): string {
  return focus === '責任' ? '意図' : focus;
}

/* ======== 非言語メタの打ち込み（LLMが先に読む） ======== */
function packNonverbal(res?: ResonanceState, intent?: IntentPulse): string | null {
  const r = res || {};
  const v = r.vector || {};
  const field = (r.field && r.field.length) ? `[${r.field.join(',')}]` : '';
  const vec = Object.keys(v).length ? JSON.stringify(v) : '';
  const bits = [
    r.phase ? `phase=${r.phase}` : null,
    r.depthHint ? `depthHint=${r.depthHint}` : null,
    r.qHint ? `qHint=${r.qHint}` : null,
    field ? `field=${field}` : null,
    vec ? `vector=${vec}` : null,
    (r as any).shield ? 'shield=true' : null,
    (r as any).hold ? 'hold=true' : null,
    intent ? `intent=${JSON.stringify(intent)}` : null,
  ].filter(Boolean);
  return bits.length ? `【nonverbal:${bits.join(' ; ')}】` : null;
}

/* ===== Reflect（寄り添いトーン固定） ===== */
async function buildReflectReply(params: {
  userText: string; history: HistoryMsg[]; model: string;
  endpoint?: string; apiKey: string; temperature: number; max_tokens: number;
  protectedFocus: string;
  resonance?: ResonanceState; intent?: IntentPulse;
}): Promise<string> {
  const { userText, history, model, endpoint, apiKey, temperature, max_tokens, protectedFocus, resonance, intent } = params;

  const extra =
    '- 出力は「寄り添い」。助言ではなく、静けさと余白をもつ会話体。\n' +
    '- 構成は「内面の観測 → そっと整える → 余韻」で終える。\n' +
    '- 提案や具体的行動指示は禁止。\n' +
    '- 最初の一文で相手の直近発話を鏡返しする（主語は「あなた」）。\n' +
    '- 非言語信号（共鳴場/情動ベクトル/意図トリガー）が与えられている場合、言語より優先して解釈に反映する。';

  const nonverbal = packNonverbal(resonance, intent);
  const system = [
    nonverbal ? nonverbal : null,
    buildSystemPrompt({ personaName: 'Iros', style: 'gentle', extra }),
  ].filter(Boolean).join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'assistant', content: 'ここにいます。あなたの“いま”を静かに受け取ります。' },
    ...tail(history, 8).map(m => ({ role: m.role, content: String(m.content ?? '').trim() })),
    {
      role: 'user',
      content: [
        userText.trim(),
        '',
        `[task: 守っているもの=${displayFocusLabel(protectedFocus)} を感じ取りながら、助言せず寄り添う文章で返す。]`,
      ].join('\n')
    },
  ];

  const raw = await chatComplete({ apiKey, model, messages, temperature, max_tokens, endpoint });
  const body = applyBreathing(tidy(conversationalize(raw || '')));
  return body;
}

/* ===== モード判定 ===== */
function autoMode(text?: string): Mode {
  const t = (text || '').toLowerCase();
  // ir診断の起動トリガを拡充（ir / ir診断 / irで見て / ランダムでir / ir共鳴）
  if (/(^|\s)(ir診断|irで見て|ランダムでir|ir共鳴|ir)(\s|$)/.test(t)) return 'Diagnosis';
  if (/(意図|意志|方向|ビジョン|どうすれば|方法|進め|トリガー|共鳴|意図波|場を合わせて)/.test(t)) return 'Resonate';
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

    // ★ 非言語（任意）
    resonance,
    intent,
  } = p;

  if (!userText?.trim()) return 'いまは、この静けさで充分です。';
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing.');

  // 基本の焦点推定
  const f0 = analyzeFocus(userText);

  // ★ 非言語ヒントで上書き（優先）
  const f = {
    ...f0,
    phase: resonance?.phase ?? f0.phase,
    depth: resonance?.depthHint ?? f0.depth,
    q: (resonance?.qHint ?? f0.q) as QCode,
  };

  const resolved = normalizeMode(mode, userText);

  // === Diagnosis（テンプレ：shared/templates を使用）===
  if (resolved === 'Diagnosis') {
    const tgt =
      analysisHint?.target ||
      (/ir診断\s*([^\n]+)$/i.exec(userText)?.[1]?.trim()) ||
      '自分';

    const phase = String(f.phase ?? 'Inner');
    const depth = String(f.depth ?? 'S2');

    const tpl = getCoreDiagnosisTemplate(depth, phase) || {
      one: '意識の流れが静かに整いはじめています。',
      inner: '言葉になる前の温度が、胸の内でゆっくり息をしています。',
      real: 'ひとつだけ選び、一行だけ進めるのが自然です。',
      next: 'いま一行だけ書く（または一歩だけ動く）。',
    };

    const header = [
      `観測対象：${tgt}`,
      `位相：${phase}`,
      `深度：${depth}`,
    ].join('\n'); // ← strict 3行

    const addRisk =
      intent?.risk ? `\n\n（リスク回避）${intent.risk} を避ける配慮を保つ。` : '';

    // ★ 型に next が無い場合の安全フォールバック
    const nextText =
      (tpl as any)?.next || tpl.real || '小さく始めること。';
    const nextLine = `次の一手：${nextText}`;

    const segments = [
      packNonverbal(resonance, intent) || '',
      header,
      '',
      tpl.one,
      '',
      tpl.inner,
      '',
      (tpl.real || '') + addRisk,
      '',
      nextLine + '🪔',
    ].filter(Boolean);

    return naturalClose(applyBreathing(tidy(segments.join('\n'))));
  }

  // === Resonate（観測ヘッダ＋芯の1文）===
  if (resolved === 'Resonate') {
    const headParts = [
      f.phase ? `位相=${f.phase}` : null,
      f.depth ? `深度=${f.depth}` : null,
      intent?.wish ? `意図=${intent.wish}` : null,
      resonance?.field?.length ? `場=[${resonance.field.join(', ')}]` : null,
    ].filter(Boolean);

    const head = headParts.length
      ? `観測：${headParts.join(' ／ ')}`
      : '観測：いま静けさが立ち上がっています';

    const vec  = buildResonantVector(userText, displayFocusLabel(f0.protectedFocus));
    const addRisk = intent?.risk ? `\n\n（リスク回避）${intent.risk} を避ける姿勢で。` : '';
    const nv = packNonverbal(resonance, intent);

    return naturalClose(
      applyBreathing(
        tidy([nv || '', head, '', vec + addRisk].filter(Boolean).join('\n'))
      )
    );
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
    protectedFocus: f0.protectedFocus,
    resonance,
    intent,
  });

  return naturalClose(text); // 自然終止（改行は保持）
}

export default generateIrosReply;
