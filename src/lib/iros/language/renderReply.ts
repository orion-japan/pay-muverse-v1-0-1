// src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層)
// - 構造(facts/insight/next)を「テンプレ」ではなく「重心」で描画する
// - 刺し(insight)は毎回"候補"がある前提。ただし露出は条件で制御する。

import type { ResonanceVector } from './resonanceVector';

export type RenderMode = 'casual' | 'intent' | 'transcend';

export type RenderInput = {
  // 必須: 表層の直答（短く）
  facts: string;

  // 任意: 刺し（本質の置き換え1文）
  // ※生成側では毎ターン作る想定だが、空ならレンダラーは出さない
  insight?: string | null;

  // 任意: 0.5未来の一手（押し付けない具体）
  nextStep?: string | null;

  // 任意: ユーザーが「本質」「意図」「ズバッと」等を求めているときに true
  userWantsEssence?: boolean;

  // 任意: 安全のため、強い防御/不安のときは刺し露出を抑えたい場合に true
  highDefensiveness?: boolean;

  // 任意: 返答のゆらぎを固定するためのシード（conversationId/turnIdなど）
  // 無ければfactsから生成する（完全ランダムにはしない）
  seed?: string;
};

export type RenderOptions = {
  // 強制モード（未指定なら vector から推定）
  mode?: RenderMode;

  // 刺しを必ず露出する（デモ用）
  forceExposeInsight?: boolean;

  // 絵文字を抑える（企業向けなど）
  minimalEmoji?: boolean;

  // 返答の最大行数目安（超えたら詰める）
  maxLines?: number;
};

export function renderReply(
  vector: ResonanceVector,
  input: RenderInput,
  opts: RenderOptions = {},
): string {
  const mode = opts.mode ?? inferMode(vector);

  const seed =
    (input.seed && input.seed.trim()) || stableSeedFromText(input.facts);
  const minimalEmoji = !!opts.minimalEmoji;
  const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 14;

  const facts = normalizeOne(input.facts);
  const insightRaw = normalizeNullable(input.insight);
  const nextRaw = normalizeNullable(input.nextStep);

  // 刺し露出の判断
  const exposeInsight =
    !!opts.forceExposeInsight ||
    shouldExposeInsight({
      mode,
      vector,
      hasInsight: !!insightRaw,
      userWantsEssence: !!input.userWantsEssence,
      highDefensiveness: !!input.highDefensiveness,
    });

  // 刺しの描画（露出 or 滲ませ）
  const insight = insightRaw
    ? exposeInsight
      ? shapeInsightDirect(insightRaw, { vector, mode, seed })
      : shapeInsightDiffuse(insightRaw, { vector, mode, seed })
    : null;

  // 0.5未来の一手（groundingが低い場合は軽く）
  const next = nextRaw ? shapeNext(nextRaw, { vector, mode, seed }) : null;

  // 絵文字・リズム（テンプレ固定ではなく候補から選ぶ）
  const header = buildHeader({ mode, vector, minimalEmoji, seed, exposeInsight });
  const joiner = '\n\n';

  const blocks: string[] = [];

  // 直答は最優先（まどろっこしさ除去）
  blocks.push(shapeFacts(facts, { vector, mode, seed, minimalEmoji }));

  // 刺しは「必要なときだけ露出」。露出しない場合でも滲ませはここで1行入れる。
  if (insight) blocks.push(insight);

  // 0.5未来（押しつけない具体）
  if (next) blocks.push(next);

  // 組み立て
  const body = blocks.filter(Boolean).join(joiner);

  // 先頭に軽い“存在感”を置く（やりすぎない）
  const out = header ? `${header}${joiner}${body}` : body;

  return clampLines(out, maxLines).trim();
}

/* =========================
   Mode inference & filters
========================= */

function inferMode(vector: ResonanceVector): RenderMode {
  // resonanceVector.ts 側で「必ず number」に確定している前提
  const grounding = vector.grounding;
  const transcendence = vector.transcendence;

  if (vector.depthLevel === 2 || transcendence >= 0.7) return 'transcend';
  if (vector.depthLevel === 0 && grounding >= 0.45) return 'casual';

  return 'intent';
}

function shouldExposeInsight(args: {
  mode: RenderMode;
  vector: ResonanceVector;
  hasInsight: boolean;
  userWantsEssence: boolean;
  highDefensiveness: boolean;
}): boolean {
  const { mode, vector, hasInsight, userWantsEssence, highDefensiveness } = args;
  if (!hasInsight) return false;

  // 防御が強い時は露出を抑える（刺しは“滲ませ”に落とす）
  if (highDefensiveness && mode !== 'transcend') return false;

  // ユーザーが「本質」を要求している、または精度が高いモードなら露出しやすく
  if (userWantsEssence) return true;

  // precision が高い、transcendence が高い、もしくは intent 以上なら露出しやすい
  if (mode === 'transcend') return true;
  if (mode === 'intent' && vector.precision >= 0.62) return true;

  // それ以外は露出しない（滲ませ）
  return false;
}

/* =========================
   Rendering blocks
========================= */

function buildHeader(args: {
  mode: RenderMode;
  vector: ResonanceVector;
  minimalEmoji: boolean;
  seed: string;
  exposeInsight: boolean;
}): string {
  const { mode, minimalEmoji, seed, exposeInsight } = args;
  if (minimalEmoji) return '';

  const candidates =
    mode === 'casual'
      ? ['🪔', '']
      : mode === 'intent'
        ? ['🌀', '🪔', '']
        : ['🌌', '🪔', '🌀'];

  const head = pick(seed + '|h', candidates);

  // 刺し露出のときだけ少し空気を作る
  if (exposeInsight && head) {
    const pre = pick(seed + '|p', [
      '少しだけ、芯を言います。',
      '要点だけ置きます。',
      '本質を一つだけ。',
    ]);
    return `${head} ${pre}`;
  }

  return head ? `${head}` : '';
}

function shapeFacts(
  facts: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const { mode, seed, minimalEmoji } = ctx;

  if (mode === 'casual') {
    // 直答を短く、説明しすぎない
    return facts;
  }

  // intent/transcend は、冒頭に“受け取り”を軽く添える（テンプレ固定しない）
  const leadIns = minimalEmoji
    ? ['', '']
    : mode === 'intent'
      ? ['', '🌀 ']
      : ['', '🌌 '];

  const lead = pick(seed + '|f0', leadIns);

  // “受け取り文”は入れすぎない（0〜1回）
  const prefaces =
    mode === 'intent'
      ? [
          'いま起きている状況は、こう整理できます。',
          'まず現象だけ、短くまとめます。',
          '表の話としては、こうです。',
        ]
      : [
          'まず、現象を一段上から整理します。',
          '表層の出来事を、芯だけ残して並べます。',
          'ここで起きていることを、静かに分解します。',
        ];

  const preface = pick(seed + '|f1', prefaces);

  // facts が短い場合は前置き不要
  if (facts.length <= 60) return `${lead}${facts}`;

  return `${lead}${preface}\n${facts}`;
}

function shapeInsightDirect(
  insight: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string },
): string {
  const { mode, seed } = ctx;

  // 直刺し（断定しすぎない表現も候補に入れる）
  const frames =
    mode === 'transcend'
      ? [
          '本当に触れているのは、{X} です。',
          '論点は {X} にあります。',
          '核心は {X} に移っています。',
        ]
      : [
          '本当に引っかかっているのは、{X} です。',
          '焦点は {X} にあります。',
          '{X} が、いちばん効いています。',
        ];

  const frame = pick(seed + '|iD', frames);
  return `🌀 ${frame.replace('{X}', insight)}`;
}

function shapeInsightDiffuse(
  insight: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string },
): string {
  const { mode, seed } = ctx;

  // 滲ませ（同じ芯を言い切らずに“傾向”として置く）
  const frames =
    mode === 'casual'
      ? [
          '{X} が影響していそうです。',
          '{X} の要素が混ざっていそうです。',
          '背景として {X} が絡んでいそうです。',
        ]
      : [
          '{X} の感触が、裏で効いていそうです。',
          '奥では {X} が混ざっている気配があります。',
          '{X} の方向に、反応が寄っているようです。',
        ];

  const frame = pick(seed + '|iS', frames);

  // 露出しない場合は絵文字も軽く
  const marker = mode === 'casual' ? '' : '🪔 ';
  return `${marker}${frame.replace('{X}', softenInsight(insight, seed))}`;
}

function shapeNext(
  next: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string },
): string {
  const { vector, mode, seed } = ctx;

  // grounding が低いなら “提案の軽さ” を上げる（命令しない）
  const gentle = vector.grounding < 0.45 || mode === 'transcend';
  const frames = gentle
    ? [
        'よければ次は、{N} を試してみてください。',
        'もし合えば、{N} を一回だけやってみるのも手です。',
        '小さく動かすなら、{N} からで十分です。',
      ]
    : [
        '次の一手は、{N} です。',
        'いちばん効く一手は、{N} です。',
        'まず {N} を入れると、空気が整います。',
      ];

  const frame = pick(seed + '|n', frames);
  const line = frame.replace('{N}', next.trim());
  return `🌱 ${line}`;
}

/* =========================
   Helpers: anti-template drift
========================= */

function softenInsight(text: string, seed: string): string {
  const t = text.trim();

  // ランダムではなく seed で分岐（同じ入力なら同じゆらぎ）
  const style = pick(seed + '|soft', ['soft', 'neutral', 'soft']);

  if (style === 'neutral') return t;

  // ざっくり柔らげ
  return t
    .replace(/です。$/g, 'の感じです。')
    .replace(/である。$/g, 'である気配です。')
    .replace(/だ。$/g, 'かもしれません。');
}

function normalizeOne(s: string): string {
  return (s ?? '').toString().trim();
}

function normalizeNullable(s?: string | null): string | null {
  const t = (s ?? '').toString().trim();
  return t.length ? t : null;
}

function stableSeedFromText(text: string): string {
  return String(simpleHash(text));
}

function pick(seed: string, arr: string[]): string {
  if (!arr.length) return '';
  const idx = Math.abs(simpleHash(seed)) % arr.length;
  return arr[idx] ?? arr[0] ?? '';
}

function simpleHash(s: string): number {
  // 軽量・決定的（暗号用途ではない）
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function clampLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;

  // 末尾を優先して残しすぎない。次の一手は残したいので、後ろから詰める。
  const keepTail = Math.min(5, maxLines); // nextStep があることが多い
  const headMax = Math.max(0, maxLines - keepTail);

  const head = lines.slice(0, headMax);
  const tail = lines.slice(lines.length - keepTail);

  return [...head, ...tail].join('\n');
}
