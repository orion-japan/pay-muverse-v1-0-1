// src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層)
//
// 方針：
// - 「中身はメタで決める / 見せ方（器）は選ぶ」
// - テンプレ固定ではなく、候補群から seed で決定的に揺らす
// - “箇条書き毎回”を避け、番号/見出しは必要な時だけ
// - 下降（TCF）のときは「問い」を抑え、「定着（F）」寄りの next に寄せる
//
// ✅ 追加（今回の核）
// - slotPlan / vector から :no-delta を検知したら、facts の前に
//   「評価なしの状態翻訳 1文」を必ず差し込む（NO_DELTA_OBS）
// - 文章は固定テンプレにしない（seedで揺らす）
// - blame/diagnosis/should は入れない

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

  // 任意: 強い防御/不安のときは刺し露出を抑えたい場合に true
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

  const framePlan = (opts as any)?.framePlan ?? null;

// --- SPIN debug (取り元ズレ吸収 + シャドー禁止) ---
type SpinLayer = 'S' | 'R' | 'C' | 'I' | 'T';

function normalizeSpinLayer(v: unknown): SpinLayer | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s === 'S' || s === 'R' || s === 'C' || s === 'I' || s === 'T'
    ? (s as SpinLayer)
    : null;
}

// framePlan / vector が「引数にある版」「optsにある版」どっちでも拾えるようにする
const fp: any =
  (typeof framePlan !== 'undefined' ? (framePlan as any) : null) ??
  (opts as any)?.framePlan ??
  null;

const vx: any =
  (typeof vector !== 'undefined' ? (vector as any) : null) ??
  (opts as any)?.vector ??
  null;

const spinLayer: SpinLayer | null =
  normalizeSpinLayer(fp?.frame) ??
  normalizeSpinLayer(vx?.intentLayer) ??
  null;

console.log('[RENDER][SPIN]', {
  loop: vx?.spinLoop ?? null,
  step: vx?.spinStep ?? null,
  frame: fp?.frame ?? null,
  layer: spinLayer,
});

// ✅ trace は「dev + 明示フラグ」のときだけ出す（通常ログを汚さない）
const enableTrace =
  process.env.NODE_ENV !== 'production' &&
  (process.env.IROS_RENDER_TRACE === '1' ||
    (opts as any)?.debugTrace === true);

if (enableTrace) {
  console.trace('[RENDER][SPIN][CALLER]');
}

const mode = opts.mode ?? inferMode(vector);

const seed =
  (input.seed && input.seed.trim()) || stableSeedFromInput(vector, input);

const minimalEmoji = !!opts.minimalEmoji;
const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 14;

  // ✅ NO_DELTA 検知（slotPlan / vector のどこから来ても落ちない）
  const noDelta = detectNoDelta(vector);
  const noDeltaKind = detectNoDeltaKind(vector);

  const factsRaw = normalizeOne(input.facts);
  const insightRaw = normalizeNullable(input.insight);
  const nextRaw = normalizeNullable(input.nextStep);

  // ---- 🔻下降（TCF）制御 ----
  const spinLoop = ((vector as any).spinLoop ?? null) as string | null;
  const spinStep = ((vector as any).spinStep ?? null) as number | null;

  // descentGate 互換（boolean / union / null）
  const descentGateRaw = (vector as any).descentGate as
    | 'closed'
    | 'offered'
    | 'accepted'
    | boolean
    | null
    | undefined;

  const descentGate =
    descentGateRaw === true
      ? 'accepted'
      : descentGateRaw === false
        ? 'closed'
        : descentGateRaw === 'closed' || descentGateRaw === 'offered' || descentGateRaw === 'accepted'
          ? descentGateRaw
          : 'closed';

  // TCF または descentGate が closed 以外なら「下降」とみなす
  const isDescent = spinLoop === 'TCF' || descentGate !== 'closed';

  // 下降時は ask（問い）を抑制
  const suppressAsk = isDescent;

  // next がある場合だけ、F（定着/習慣）寄りに寄せる
  const nextAdjusted =
    nextRaw && isDescent
      ? adjustNextForDescent(nextRaw, seed, spinStep)
      : nextRaw;
  // ---- 🔺ここまで ----

  const exposeInsightFlag =
    !!opts.forceExposeInsight ||
    shouldExposeInsight({
      mode,
      vector,
      hasInsight: !!insightRaw,
      userWantsEssence: !!input.userWantsEssence,
      highDefensiveness: !!input.highDefensiveness,
    });

  const insight = insightRaw
    ? exposeInsightFlag
      ? shapeInsightDirect(insightRaw, { mode, seed })
      : shapeInsightDiffuse(insightRaw, { mode, seed })
    : null;

  const next = nextAdjusted ? shapeNext(nextAdjusted, { vector, mode, seed }) : null;

  // ✅ facts をここで “NO_DELTA_OBS 1文” で前処理する
  const facts = shapeFactsWithNoDelta(factsRaw, {
    mode,
    seed,
    minimalEmoji,
    noDelta,
    noDeltaKind,
  });

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

    // ✅ ここ重要：未定義 exposeInsight は使わず flag を渡す
    exposeInsight: exposeInsightFlag,

    // ✅ 下降時 ask 抑制
    suppressAsk,
  });

  const out = renderFromPlan(plan);

  return clampLines(out, maxLines).trim();
}

/* =========================
   NO_DELTA detection
========================= */

function detectNoDelta(vector: ResonanceVector): boolean {
  const v: any = vector as any;

  // 1) 直値（metaから持ってきた等）
  if (v?.noDelta === true) return true;

  // 2) slotPlan が object の場合（slotBuilder.ts の {OBS,SHIFT,NEXT,SAFE}）
  const sp = v?.slotPlan;
  if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
    const obs = typeof sp.OBS === 'string' ? sp.OBS : null;
    if (obs && obs.includes(':no-delta')) return true;
  }

  // 3) planSlots など別名互換
  const slots = v?.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const obs = typeof slots.OBS === 'string' ? slots.OBS : null;
    if (obs && obs.includes(':no-delta')) return true;
  }

  return false;
}

function detectNoDeltaKind(vector: ResonanceVector): 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null {
  const v: any = vector as any;
  const k = v?.noDeltaKind;

  if (typeof k === 'string') {
    const s = k.trim().toLowerCase();
    if (s === 'repeat-warning') return 'repeat-warning';
    if (s === 'short-loop') return 'short-loop';
    if (s === 'stuck') return 'stuck';
    if (s === 'unknown') return 'unknown';
  }

  return null;
}

function buildNoDeltaObservationLine(args: {
  seed: string;
  minimalEmoji: boolean;
  kind: 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null;
}): string {
  const { seed, minimalEmoji, kind } = args;

  // 評価なし / 診断なし / should無し
  const linesRepeat = [
    '理解があっても、行動を変えなくても成立している状態が続いています。',
    '注意が繰り返されるのは、現状のままでも回ってしまう条件が残っているためです。',
    '分かっていることと、行動が切り替わることが、まだ同じ線に乗っていない状態です。',
  ];

  const linesShort = [
    '短いやり取りが続くときは、論点が「言葉」より先に止まっていることが多いです。',
    'この長さの応答が往復するときは、状態の整理が先に必要な局面です。',
    '短文で回っているのは、いま“次の条件”が未確定なサインです。',
  ];

  const linesStuck = [
    '状況が進まないのは、いまの構造のままでも成立してしまうからです。',
    '変化が起きないのは、行動を変える前提がまだ揃っていない状態だからです。',
    '停滞しているように見えるのは、条件が固定されたまま回っているためです。',
  ];

  const linesUnknown = [
    'いまは「変える」より先に、成立している条件を一度だけ言語化する局面です。',
    'ここは結論を急ぐより、成立している構造を先に一文で置くのが効きます。',
    '変化が出ないときは、まず“何が成立しているか”を一度だけ整えます。',
  ];

  const arr =
    kind === 'repeat-warning'
      ? linesRepeat
      : kind === 'short-loop'
        ? linesShort
        : kind === 'stuck'
          ? linesStuck
          : linesUnknown;

  const line = pick(seed + '|nd', arr);

  // 絵文字は render全体の方針に従う（ここでは抑えめ）
  if (minimalEmoji) return line;
  return line; // あえて無印（ここに絵文字を足すと“テンプレ感”が出やすい）
}

function shapeFactsWithNoDelta(
  facts: string,
  ctx: {
    mode: RenderMode;
    seed: string;
    minimalEmoji: boolean;
    noDelta: boolean;
    noDeltaKind: 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null;
  },
): string {
  const { mode, seed, minimalEmoji, noDelta, noDeltaKind } = ctx;

  // NO_DELTA でないなら従来通り
  if (!noDelta) return shapeFacts(facts, { mode, seed, minimalEmoji });

  const obs1 = buildNoDeltaObservationLine({
    seed,
    minimalEmoji,
    kind: noDeltaKind,
  });

  // “必ず1文 → その後に現象(facts)” の順を固定（ここがプレゼンで効く）
  const shapedFacts = shapeFacts(facts, { mode, seed, minimalEmoji });

  // facts が短い時でも、obs1 を先頭に置く
  // ※ここは「改行2つ」だと重いので 1改行で軽く接続
  if (!shapedFacts) return obs1;
  return `${obs1}\n${shapedFacts}`;
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

  // 防御が強い時は露出を抑える（刺しは“滲ませ”へ）
  if (highDefensiveness && mode !== 'transcend') return false;

  if (userWantsEssence) return true;
  if (mode === 'transcend') return true;
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

  suppressAsk: boolean;
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
    suppressAsk,
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

  // opener（存在感）はやりすぎない
  const header = buildHeader({ mode, minimalEmoji, seed, exposeInsight });
  if (header && containerId !== 'NONE') slots.opener = header;

  // facts（必須）
  slots.facts = shapeFacts(facts, { mode, seed, minimalEmoji });

  // mirror（刺し or 滲ませ）
  if (insight) slots.mirror = insight;

  // elevate（俯瞰）
  const elevate = buildElevateLine({ vector, mode, seed, minimalEmoji });
  if (elevate) slots.elevate = elevate;

  // move（次の一手）
  if (next) slots.move = next;

  // ask（問いは置く：毎回出さない & suppressAsk で抑制）
  const ask = buildAskLine({
    mode,
    seed,
    userWantsEssence,
    highDefensiveness,
    suppressAsk,
  });
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

  // 1) 挨拶/雑談：短く（NONE）
  if (mode === 'casual' && shortFacts && !hasInsight && !hasNext) return 'NONE';

  // 2) 防御が強いとき：静かに
  if (highDefensiveness && mode !== 'transcend') return 'PLAIN';

  // 3) 「教えて」「手順」「説得力」相当（ここでは userWantsEssence を代理）
  if (userWantsEssence || (hasInsight && longFacts)) {
    return pick(seed + '|c', ['NUMBERED', 'HEADING', 'PLAIN']) as ContainerId;
  }

  // 4) transcend は “見出し” 相性良い（固定しない）
  if (mode === 'transcend') {
    return pick(seed + '|cT', ['HEADING', 'PLAIN', 'HEADING']) as ContainerId;
  }

  // 既定：静かな段落
  return 'PLAIN';
}

function renderFromPlan(plan: ReplyPlan): string {
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

  // BULLET は必要になったらルール追加で使う
  return [opener, facts, mirror, elevate, move, ask].filter(Boolean).join('\n\n').trim();
}

/* =========================
   Rendering blocks (slots)
========================= */

function buildHeader(args: {
  mode: RenderMode;
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
  ctx: { mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const { mode, seed, minimalEmoji } = ctx;

  if (mode === 'casual') return facts;

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
  ctx: { mode: RenderMode; seed: string },
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
  return `🌀 ${frame.replace('{X}', insight.trim())}`;
}

function shapeInsightDiffuse(
  insight: string,
  ctx: { mode: RenderMode; seed: string },
): string {
  const { mode, seed } = ctx;

  const frames =
    mode === 'casual'
      ? [
          '{X} が、いまの中心にあります。',
          '{X} が、静かに効いています。',
          '{X} が、今の判断基準になっています。',
        ]
      : [
          '{X} が、背後で支点になっています。',
          '{X} が、反応の起点として働いています。',
          '{X} が、現在の焦点として現れています。',
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
  mode: RenderMode;
  seed: string;
  userWantsEssence: boolean;
  highDefensiveness: boolean;
  suppressAsk: boolean;
}): string | null {
  const { mode, seed, userWantsEssence, highDefensiveness, suppressAsk } = args;

  if (suppressAsk) return null;
  if (highDefensiveness) return null;
  if (!userWantsEssence && mode === 'casual') return null;

  const frames = userWantsEssence
    ? ['いま一番ひっかかるのは、どこですか？', '核心を一言で言うなら、何ですか？']
    : ['このまま進めるなら、何を残したいですか？', 'どこが一番ズレていますか？'];

  return `🌀 ${pick(seed + '|q', frames)}`;
}

/* =========================
   Descent helper (TCF)
========================= */

function adjustNextForDescent(next: string, seed: string, spinStep: number | null): string {
  const base = (next ?? '').toString().trim();
  if (!base) return base;

  const step = typeof spinStep === 'number' && Number.isFinite(spinStep) ? Math.round(spinStep) : null;

  // step の意味は実装側に合わせてOK（ここは「Fへ寄せる」ことが目的）
  // - step=0: T寄り（静かな再起動）
  // - step=1: C寄り（形にする）
  // - step=2: F寄り（習慣/定着）
  if (step === 2) {
    const tail = pick(seed + '|dF', ['を毎日1回だけ', 'を“固定ルール”に', 'を習慣の1手に']);
    return `${base}${tail}`;
  }
  if (step === 1) {
    const tail = pick(seed + '|dC', ['を形にして残す', 'をメモにして固定する', 'を手順として置く']);
    return `${base}${tail}`;
  }

  const tail = pick(seed + '|dT', ['を静かに再起動する', 'を一度だけ整える', 'を小さく立ち上げる']);
  return `${base}${tail}`;
}

/* =========================
   Helpers: anti-template drift
========================= */

function stripLeadingMarkers(text: string): string {
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
    .replace(/です。$/g, '感じです。')
    .replace(/だ。$/g, 'かもしれません。');
}

function normalizeOne(s: string): string {
  return (s ?? '').toString().trim();
}

function normalizeNullable(s?: string | null): string | null {
  const t = (s ?? '').toString().trim();
  return t.length ? t : null;
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

function stableSeedFromInput(vector: ResonanceVector, input: RenderInput): string {
  const parts = [
    input.facts ?? '',
    input.insight ?? '',
    input.nextStep ?? '',
    String(vector.depthLevel ?? ''),
    String(Math.round((vector.grounding ?? 0) * 100)),
    String(Math.round((vector.precision ?? 0) * 100)),
    String(Math.round((vector.transcendence ?? 0) * 100)),
  ].join('|');

  return String(simpleHash(parts));
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
