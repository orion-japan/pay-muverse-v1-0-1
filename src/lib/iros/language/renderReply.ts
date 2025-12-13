// src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層)
//
// 方針：
// - 「中身はメタで決める / 見せ方（器）は選ぶ」
// - テンプレ固定ではなく、候補群から seed で決定的に揺らす
// - ただし、挨拶/雑談/説明不要のときは短く（器: NONE）
// - “箇条書き毎回”を避け、番号/見出しは必要な時だけ

import type { ResonanceVector } from './resonanceVector';
import type { ReplyPlan, ContainerId, ReplySlotKey } from './planReply';

export type RenderMode = 'casual' | 'intent' | 'transcend';

export type RenderInput = {
  // 必須: 表層の直答（短く）
  facts: string;

  // 任意: 刺し（本質の置き換え1文）
  insight?: string | null;

  // 任意: 0.5未来の一手（押し付けない具体）
  nextStep?: string | null;

  // 任意: ユーザーが「本質」「意図」「ズバッと」等を求めているときに true
  userWantsEssence?: boolean;

  // 任意: 安全のため、強い防御/不安のときは刺し露出を抑えたい場合に true
  highDefensiveness?: boolean;

  // 任意: 返答のゆらぎを固定するためのシード（conversationId/turnIdなど）
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

  // 器を選び、スロットを組み立てる
  const plan = buildPlan({
    vector,
    mode,
    seed,
    minimalEmoji,
    facts,
    insight,
    next,
    userWantsEssence: !!input.userWantsEssence,
    highDefensiveness: !!input.highDefensiveness,
    exposeInsight,
  });

  const out = renderFromPlan(plan, { mode, vector, seed, minimalEmoji });

  return clampLines(out, maxLines).trim();
}

/* =========================
   Mode inference & filters
========================= */

function inferMode(vector: ResonanceVector): RenderMode {
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

  // ユーザーが「本質」を要求しているなら露出
  if (userWantsEssence) return true;

  // transcend は露出しやすい
  if (mode === 'transcend') return true;

  // intent でも precision が高いなら露出
  if (mode === 'intent' && vector.precision >= 0.62) return true;

  return false;
}

/* =========================
   Plan: container + slots
========================= */

function buildPlan(args: {
  vector: ResonanceVector;
  mode: RenderMode;
  seed: string;
  minimalEmoji: boolean;

  facts: string;
  insight: string | null;
  next: string | null;

  userWantsEssence: boolean;
  highDefensiveness: boolean;
  exposeInsight: boolean;
}): ReplyPlan {
  const {
    vector,
    mode,
    seed,
    minimalEmoji,
    facts,
    insight,
    next,
    userWantsEssence,
    highDefensiveness,
    exposeInsight,
  } = args;

  const containerId = pickContainer({
    vector,
    mode,
    seed,
    facts,
    insight,
    next,
    userWantsEssence,
    highDefensiveness,
  });

  const slots: Partial<Record<ReplySlotKey, string>> = {};

  // opener（存在感）は、やりすぎない・挨拶雑談では消える
  const header = buildHeader({ mode, vector, minimalEmoji, seed, exposeInsight });
  if (header && containerId !== 'NONE') slots.opener = header;

  // facts（必須）
  slots.facts = shapeFacts(facts, { vector, mode, seed, minimalEmoji });

  // mirror（刺し or 滲ませ）
  if (insight) slots.mirror = insight;

  // elevate（一段上の俯瞰：transcend寄りの時だけ薄く）
  const elevate = buildElevateLine({ vector, mode, seed, minimalEmoji });
  if (elevate) slots.elevate = elevate;

  // move（次の一手）
  if (next) slots.move = next;

  // ask（問いは「置く」：毎回は出さない）
  const ask = buildAskLine({ vector, mode, seed, userWantsEssence, highDefensiveness });
  if (ask) slots.ask = ask;

  return {
    containerId,
    slots,
    debug: {
      reason: `container=${containerId}`,
      pickedBy: 'rule',
    },
  };
}

function pickContainer(args: {
  vector: ResonanceVector;
  mode: RenderMode;
  seed: string;
  facts: string;
  insight: string | null;
  next: string | null;
  userWantsEssence: boolean;
  highDefensiveness: boolean;
}): ContainerId {
  const { mode, seed, facts, insight, next, userWantsEssence, highDefensiveness } = args;

  const hasInsight = !!insight;
  const hasNext = !!next;

  const shortFacts = facts.trim().length <= 50;
  const longFacts = facts.trim().length >= 160;

  // 1) 挨拶/雑談/説明不要：短く（NONE）
  if (mode === 'casual' && shortFacts && !hasInsight && !hasNext) return 'NONE';

  // 2) 防御が強いとき：器は静かに（PLAIN）
  if (highDefensiveness && mode !== 'transcend') return 'PLAIN';

  // 3) 「教えて」「手順」「説得力」相当（ここでは userWantsEssence を代理）
  if (userWantsEssence || (hasInsight && longFacts)) {
    return pick(seed + '|c', ['NUMBERED', 'HEADING', 'PLAIN']) as ContainerId;
  }

  // 4) transcend は “見出し” が相性良い（ただし毎回固定しない）
  if (mode === 'transcend') {
    return pick(seed + '|cT', ['HEADING', 'PLAIN', 'HEADING']) as ContainerId;
  }

  // 既定：静かな段落
  return 'PLAIN';
}

function renderFromPlan(
  plan: ReplyPlan,
  ctx: { mode: RenderMode; vector: ResonanceVector; seed: string; minimalEmoji: boolean },
): string {
  const { containerId, slots } = plan;

  const s = (k: ReplySlotKey) => normalizeNullable(slots[k]);

  const opener = s('opener');
  const facts = s('facts') ?? '';
  const mirror = s('mirror');
  const elevate = s('elevate');
  const move = s('move');
  const ask = s('ask');

  if (containerId === 'NONE') {
    const parts = [facts, move].filter(Boolean);
    return parts.join('\n\n').trim();
  }

  if (containerId === 'PLAIN') {
    return [opener, facts, mirror, elevate, move, ask].filter(Boolean).join('\n\n').trim();
  }

  if (containerId === 'HEADING') {
    // HEADING のときは “芯” の絵文字が二重になりやすいので、mirror から先頭の印を剥ぐ
    const mirrorClean = mirror ? stripLeadingMarkers(mirror) : null;
    const elevateClean = elevate ? stripLeadingMarkers(elevate) : null;

    const blocks: string[] = [];
    if (opener) blocks.push(opener);

    blocks.push(`■ 現象\n${facts}`);

    if (mirrorClean) blocks.push(`■ 芯\n${mirrorClean}`);

    if (elevateClean) blocks.push(`■ 俯瞰\n${elevateClean}`);

    if (move) blocks.push(`■ 次\n${move}`);

    if (ask) blocks.push(`■ 確認\n${stripLeadingMarkers(ask)}`);

    return blocks.join('\n\n').trim();
  }

  if (containerId === 'NUMBERED') {
    // NUMBERED のときは “move 重複” を内容一致で判定しない。投入フラグで管理する。
    const steps: string[] = [];
    if (opener) steps.push(opener);

    steps.push(`1) ${facts}`);

    if (mirror) steps.push(`2) ${stripLeadingMarkers(mirror)}`);

    let moveInserted = false;

    if (elevate) {
      steps.push(`3) ${stripLeadingMarkers(elevate)}`);
    } else if (move) {
      steps.push(`3) ${move}`);
      moveInserted = true;
    }

    if (move && !moveInserted && steps.length < 5) {
      steps.push(`4) ${move}`);
      moveInserted = true;
    }

    if (ask && steps.length < 6) steps.push(`最後に：${stripLeadingMarkers(ask)}`);

    return steps.join('\n\n').trim();
  }

  // BULLET は “毎回は出さない” 前提。必要になったら別途ルール追加で使う。
  return [opener, facts, mirror, elevate, move, ask].filter(Boolean).join('\n\n').trim();
}

/* =========================
   Rendering blocks (slots)
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
    return facts;
  }

  const leadIns = minimalEmoji
    ? ['', '']
    : mode === 'intent'
      ? ['', '🌀 ']
      : ['', '🌌 '];

  const lead = pick(seed + '|f0', leadIns);

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

  if (facts.length <= 60) return `${lead}${facts}`;

  return `${lead}${preface}\n${facts}`;
}

function shapeInsightDirect(
  insight: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string },
): string {
  const { mode, seed } = ctx;

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
  const marker = mode === 'casual' ? '' : '🪔 ';
  return `${marker}${frame.replace('{X}', softenInsight(insight, seed))}`;
}

function shapeNext(
  next: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string },
): string {
  const { vector, mode, seed } = ctx;

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

function buildElevateLine(args: {
  vector: ResonanceVector;
  mode: RenderMode;
  seed: string;
  minimalEmoji: boolean;
}): string | null {
  const { vector, mode, seed, minimalEmoji } = args;

  const want =
    mode === 'transcend' ||
    (mode === 'intent' && vector.transcendence >= 0.55);

  if (!want) return null;

  const frames = [
    'ここは「結論」より、流れの向きが先に決まっています。',
    '出来事そのものより、“向き”が先に立っている局面です。',
    '答えを急ぐより、今は“方向”を整える段階です。',
  ];

  const line = pick(seed + '|e', frames);
  return minimalEmoji ? line : `🪔 ${line}`;
}

function buildAskLine(args: {
  vector: ResonanceVector;
  mode: RenderMode;
  seed: string;
  userWantsEssence: boolean;
  highDefensiveness: boolean;
}): string | null {
  const { mode, seed, userWantsEssence, highDefensiveness } = args;

  if (highDefensiveness) return null;
  if (!userWantsEssence && mode === 'casual') return null;

  const frames = userWantsEssence
    ? ['いま一番ひっかかるのは、どこですか？', '核心を一言で言うなら、何ですか？']
    : ['このまま進めるなら、何を残したいですか？', 'どこが一番ズレていますか？'];

  return `🌀 ${pick(seed + '|q', frames)}`;
}

/* =========================
   Helpers: anti-template drift
========================= */

function stripLeadingMarkers(text: string): string {
  // 先頭の絵文字・記号・全角スペースを軽く除去（見出し/番号の二重装飾を防ぐ）
  return (text ?? '')
    .toString()
    .trim()
    .replace(/^(?:[🌀🪔🌌🌱✨]+[\s　]*)+/u, '')
    .trim();
}

function softenInsight(text: string, seed: string): string {
  const t = text.trim();
  const style = pick(seed + '|soft', ['soft', 'neutral', 'soft']);

  if (style === 'neutral') return t;

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

  const keepTail = Math.min(5, maxLines);
  const headMax = Math.max(0, maxLines - keepTail);

  const head = lines.slice(0, headMax);
  const tail = lines.slice(lines.length - keepTail);

  return [...head, ...tail].join('\n');
}
