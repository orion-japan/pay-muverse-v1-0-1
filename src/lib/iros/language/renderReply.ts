// file: src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層) [compact]

import type { ResonanceVector } from './resonanceVector';
import type { ReplyPlan, ContainerId, ReplySlotKey } from './planReply';

export type RenderMode = 'casual' | 'intent' | 'transcend';

export type RenderInput = {
  facts: string;
  insight?: string | null;
  nextStep?: string | null;
  userWantsEssence?: boolean;
  highDefensiveness?: boolean;
  seed?: string;

  // ✅ 追加：IT構造化の材料（あれば使う / 無くても落ちない）
  // ※上流で userText を渡せるようになったら、より自然に“状態定義”が書ける
  userText?: string | null;
};

export type RenderOptions = {
  mode?: RenderMode;
  forceExposeInsight?: boolean;
  minimalEmoji?: boolean;
  maxLines?: number;

  // （拡張）上流が渡す可能性があるもの：any で拾う
  // framePlan / renderMode / spinLoop / descentGate / itDensity ...
};

// ✅ IT 密度（自然発火は micro/compact、ボタンは normal 想定）
export type ItDensity = 'micro' | 'compact' | 'normal';

export function renderReply(
  vector: ResonanceVector,
  input: RenderInput,
  opts: RenderOptions = {},
): string {
  const framePlan = (opts as any)?.framePlan ?? null;

// ✅ 外部（extra/meta）からの強制指定を優先して拾う
// - opts は postprocess / handleIrosReply 側から渡される可能性あり
// - 自然発火・ボタン発火どちらもここに集約する
const forcedRenderMode =
  ((opts as any)?.renderMode ??
    (opts as any)?.meta?.renderMode ??
    (opts as any)?.extra?.renderMode) as string | undefined;

const forcedSpinLoop =
  ((opts as any)?.spinLoop ??
    (opts as any)?.meta?.spinLoop ??
    (opts as any)?.extra?.spinLoop) as string | undefined;

const forcedDescentGate =
  (opts as any)?.descentGate ??
  (opts as any)?.meta?.descentGate ??
  (opts as any)?.extra?.descentGate ??
  undefined;


  // ✅ 追加：IT density（postprocess が渡せるように）
  // - opts.itDensity: 最優先（UIボタン/自然発火で出し分け）
  // - opts.density: 互換
  // - vector/meta 経由も一応拾う（壊れないように）
  const forcedItDensityRaw =
    (opts as any)?.itDensity ??
    (opts as any)?.density ??
    (vector as any)?.itDensity ??
    (vector as any)?.meta?.extra?.itDensity ??
    (vector as any)?.extra?.itDensity ??
    null;

  const forcedItDensity: ItDensity =
    String(forcedItDensityRaw ?? '').toLowerCase() === 'micro'
      ? 'micro'
      : String(forcedItDensityRaw ?? '').toLowerCase() === 'compact'
        ? 'compact'
        : 'normal';

  // ---- 🔻下降（TCF）制御（vector ではなく “強制指定込み” で判定） ----
  const spinLoop = (forcedSpinLoop ?? ((vector as any).spinLoop ?? null)) as
    | 'SRI'
    | 'TCF'
    | string
    | null;

  const descentGateRaw = (forcedDescentGate ?? (vector as any).descentGate) as
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
        : descentGateRaw === 'closed' ||
            descentGateRaw === 'offered' ||
            descentGateRaw === 'accepted'
          ? descentGateRaw
          : 'closed';

  const isDescent = spinLoop === 'TCF' || descentGate !== 'closed';

  // ✅ IT 指定が来たら mode を強制的に transcend 扱いに寄せる（まず動かす）
  const baseMode = opts.mode ?? inferMode(vector);
  const mode: RenderMode = forcedRenderMode === 'IT' ? 'transcend' : baseMode;

  // 以降は元の処理のまま
  const seed =
    (input.seed && input.seed.trim()) || stableSeedFromInput(vector, input);

  const minimalEmoji = !!opts.minimalEmoji;
  const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 14;

  // ✅ NO_DELTA 検知（現状は“差し込まない”方針だが、将来の条件分岐に残しておく）
  // ※いまは未使用でも keep（将来の分岐用）
  const _noDelta = detectNoDelta(vector);
  const _noDeltaKind = detectNoDeltaKind(vector);

  const factsRaw = normalizeOne(input.facts);

  // --- slotPlan (from vector) を拾う ---
  const slotPlan0 = pickSlotPlanFromVector(vector);

  // --- required slot を埋める（SHIFT/NEXT が null のまま落ちないように） ---
  const slotPlan = fillRequiredSlots({ framePlan, slotPlan: slotPlan0 });

  // --- insight/nextStep が上流から来てない場合、slotPlan から最小生成して差し込む ---
  const insightFromSlots = buildInsightFromSlotPlan(slotPlan, seed);
  const nextFromSlots = buildNextFromSlotPlan(slotPlan, seed);

  const insightRaw0 =
    normalizeNullable(input.insight) ?? normalizeNullable(insightFromSlots);

  const nextRaw =
    normalizeNullable(input.nextStep) ?? normalizeNullable(nextFromSlots);

  const spinStep = ((vector as any).spinStep ?? null) as number | null;

  const nextAdjusted =
    nextRaw && isDescent
      ? adjustNextForDescent(nextRaw, seed, spinStep)
      : nextRaw;

  // ✅ IT構造化（最短デモ）：forcedRenderMode==='IT' のときは通常planを通さず返す
  if (forcedRenderMode === 'IT') {
    const itText = renderITStructured({
      seed,
      minimalEmoji,
      maxLines,
      itDensity: forcedItDensity, // ✅ 追加
      userText: normalizeNullable(input.userText) ?? '',
      facts: factsRaw,
      insight: insightRaw0,
      nextStep: nextAdjusted,
      isDescent,
      spinStep,
    });

    return itText.trim();
  }

  // ---- noDelta 最小（factsに余計な観測文は足さない方針）----
  const facts = shapeFacts(factsRaw, { mode, seed, minimalEmoji });

  const exposeInsight =
    !!opts.forceExposeInsight ||
    shouldExposeInsight({
      mode,
      vector,
      hasInsight: !!insightRaw0,
      userWantsEssence: !!input.userWantsEssence,
      highDefensiveness: !!input.highDefensiveness,
    });

  const insight = insightRaw0
    ? exposeInsight
      ? shapeInsightDirect(insightRaw0, { mode, seed, minimalEmoji })
      : shapeInsightDiffuse(insightRaw0, { mode, seed, minimalEmoji })
    : null;

  const next = nextRaw
    ? shapeNext(nextRaw, { vector, mode, seed, minimalEmoji })
    : null;

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

  const out = renderFromPlan(plan, { seed });
  return clampLines(out, maxLines).trim();
}

/* =========================
   ✅ IT structured renderer
========================= */

function renderITStructured(args: {
  seed: string;
  minimalEmoji: boolean;
  maxLines: number;

  // ✅ 追加：密度
  itDensity: ItDensity;

  userText: string;
  facts: string;
  insight: string | null;
  nextStep: string | null;

  isDescent: boolean;
  spinStep: number | null;
}): string {
  const {
    seed,
    minimalEmoji,
    maxLines,
    itDensity,
    userText,
    facts,
    insight,
    nextStep,
    isDescent,
    spinStep,
  } = args;

  // --- I: 状態定義 / ズレ言語化 / 停滞理由 ---
  const I1 =
    insight?.trim() ||
    (userText
      ? `いま動けないのは、${soften(userText)} の出来事そのものより、“動く事に変換できていない感覚”が邪魔しているからです。`
      : facts
        ? `いま動いてないのは、起きている事実（${soften(facts)}）の外側に、まだ“固まっていない"焦点”があるからです。`
        : 'いまは「答え」ではなく、状況を一度確定する局面です。');

  const I2 =
    '正しいと思う方向と、動き方の方向が一致していない。だから迷いとして現れている。';
  const I3 =
    '選択肢の問題ではなく、焦点がまだ一点に絞られていないだけです。';

  // --- T: 未来方向 / 未来状態 ---
  const T1 =
    '次は、正解探しより先に「自分が壊れない形」を先に作る。';
  const T2 =
    '未来は「不安をゼロにする事」より、「迷っても前に進める足場がある」状態へ。';

  // --- C: 次の一歩（最大2） / やらないこと ---
  const nextBase = nextStep?.trim() || '最初の一歩だけを取り出して、1分で決める。';

  const nextAdj =
    isDescent ? adjustNextForDescent(nextBase, seed, spinStep) : nextBase;

  const C1 = `今夜は、${nextAdj}`;
  const C2 = '必要なら、境界線を短い一通で先に置く。説明は増やさない。';
  const C3 = '代わりに、比較と反省で時間を費やすのはやめる。';

  // --- F: 確信 / 余韻 ---
  const F1 = minimalEmoji
    ? 'もう変化は起きています。あとは、その変化に沿って歩むだけ。'
    : 'もう変化は起きています。あとは、その変化に沿って歩くだけ。🪔';

  const F2 = '“できる側”のあなたに、変わっていきます。';

  // =========================================================
  // ✅ 密度ごとの出力（自然発火は micro/compact）
  // =========================================================

  // ■ micro: 1行I / 1行T / 1行C / 1行F（頻発してもくどくならない）
  if (itDensity === 'micro') {
    const lines: string[] = [I1, T1, C1, F1];
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return clampLines(text, Math.min(maxLines, 8));
  }

  // ■ compact: 構造は見せるが削る（8〜10行目安）
  if (itDensity === 'compact') {
    const lines: string[] = [I1, I2, '', T1, T2, '', C1, C3, '', F1];
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return clampLines(text, Math.min(maxLines, 12));
  }

  // ■ normal: いまの濃いIT（ボタン想定）
  const lines: string[] = [I1, I2, I3, '', T1, T2, '', C1, C2, C3, '', F1, F2];
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return clampLines(text, maxLines);
}

function soften(x: string): string {
  const t = (x ?? '').toString().trim();
  if (!t) return '';
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

/* =========================
   Mode
========================= */

function inferMode(vector: ResonanceVector): RenderMode {
  const grounding = (vector as any).grounding ?? 0;
  const transcendence = (vector as any).transcendence ?? 0;

  if ((vector as any).depthLevel === 2 || transcendence >= 0.7) return 'transcend';
  if ((vector as any).depthLevel === 0 && grounding >= 0.45) return 'casual';
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
  if (highDefensiveness && mode !== 'transcend') return false;
  if (userWantsEssence) return true;
  if (mode === 'transcend') return true;
  if (mode === 'intent' && ((vector as any).precision ?? 0) >= 0.62) return true;
  return false;
}

/* =========================
   Plan / Container
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
    mode,
    seed,
    facts,
    insight,
    next,
    userWantsEssence,
    highDefensiveness,
  });

  const slots: Partial<Record<ReplySlotKey, string>> = {};

  const header = buildHeader({ mode, minimalEmoji, seed, exposeInsight });
  if (header && containerId !== 'NONE') slots.opener = header;

  slots.facts = facts;
  if (insight) slots.mirror = insight;

  // elevate/ask は “短縮版” では出さない（テンプレ化の主因になりやすい）
  if (next) slots.move = next;

  return {
    containerId,
    slots,
    debug: { reason: `container=${containerId}`, pickedBy: 'rule' },
  };
}

function pickContainer(args: {
  mode: RenderMode;
  seed: string;
  facts: string;
  insight: string | null;
  next: string | null;
  userWantsEssence: boolean;
  highDefensiveness: boolean;
}): ContainerId {
  const { mode, seed, facts, insight, next, userWantsEssence, highDefensiveness } =
    args;

  const hasInsight = !!insight;
  const hasNext = !!next;

  const shortFacts = facts.trim().length <= 50;
  const longFacts = facts.trim().length >= 160;

  if (mode === 'casual' && shortFacts && !hasInsight && !hasNext) return 'NONE';
  if (highDefensiveness && mode !== 'transcend') return 'PLAIN';

  if (userWantsEssence || (hasInsight && longFacts)) {
    return pick(seed + '|c', ['NUMBERED', 'HEADING', 'PLAIN']) as ContainerId;
  }

  if (mode === 'transcend') {
    return pick(seed + '|cT', ['HEADING', 'PLAIN', 'HEADING']) as ContainerId;
  }

  return 'PLAIN';
}

function renderFromPlan(plan: ReplyPlan, ctx: { seed: string }): string {
  const { containerId, slots } = plan;
  const { seed } = ctx;

  const s = (k: ReplySlotKey) => normalizeNullable(slots[k]);

  const opener = s('opener');
  const facts = s('facts') ?? '';
  const mirror = s('mirror');
  const move = s('move');

  if (containerId === 'NONE') {
    return [facts, move].filter(Boolean).join('\n\n').trim();
  }

  if (containerId === 'PLAIN') {
    return [opener, facts, mirror, move].filter(Boolean).join('\n\n').trim();
  }

  if (containerId === 'HEADING') {
    const blocks: string[] = [];
    if (opener) blocks.push(opener);

    blocks.push(`■ 現象\n${facts}`);

    if (mirror) blocks.push(`■ 芯\n${stripLeadingMarkers(mirror)}`);

    if (move) {
      const label = pickNextSectionLabel(seed);
      blocks.push(`■ ${label}\n${move}`);
    }

    return blocks.join('\n\n').trim();
  }

  // NUMBERED
  const steps: string[] = [];
  if (opener) steps.push(opener);

  steps.push(`1) ${facts}`);
  if (mirror) steps.push(`2) ${stripLeadingMarkers(mirror)}`);
  if (move) steps.push(`3) ${move}`);

  return steps.join('\n\n').trim();
}

/* =========================
   Slot shaping
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
    const pre = pick(seed + '|p', ['要点だけ置きます。', '芯を一つだけ。', '結論を先に。']);
    return `${head} ${pre}`;
  }

  return head ? `${head}` : '';
}

function shapeFacts(
  facts: string,
  _ctx: { mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const f = (facts ?? '').toString().trim();
  if (!f) return '';
  return f;
}

function shapeInsightDirect(
  insight: string,
  ctx: { mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const { mode, seed, minimalEmoji } = ctx;
  const x = insight.trim();
  if (!x) return '';

  const frames =
    mode === 'transcend'
      ? ['核心は {X} です。', '論点は {X} にあります。', '{X} が支点です。']
      : ['焦点は {X} です。', '{X} がいちばん効いています。', '要点は {X} です。'];

  const frame = pick(seed + '|iD', frames).replace('{X}', x);
  return minimalEmoji ? frame : `🌀 ${frame}`;
}

function shapeInsightDiffuse(
  insight: string,
  ctx: { mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const { mode, seed, minimalEmoji } = ctx;
  const x = softenInsight(insight.trim(), seed);
  if (!x) return '';

  const frames =
    mode === 'casual'
      ? ['{X} が中心です。', '{X} が静かに効いています。', '{X} が判断基準になっています。']
      : ['{X} が支点になっています。', '{X} が反応の起点です。', '{X} が焦点として現れています。'];

  const frame = pick(seed + '|iS', frames).replace('{X}', x);
  if (minimalEmoji) return frame;
  return mode === 'casual' ? frame : `🪔 ${frame}`;
}

/**
 * ✅ 「次の一歩」を固定ラベルにしない
 */
function shapeNext(
  next: string,
  ctx: {
    vector: ResonanceVector;
    mode: RenderMode;
    seed: string;
    minimalEmoji: boolean;
  },
): string {
  const { vector, mode, seed, minimalEmoji } = ctx;

  const n = next.trim();
  if (!n) return '';

  const gentle = ((vector as any).grounding ?? 0) < 0.45 || mode === 'transcend';

  const lead = pickNextLead(seed, gentle);
  const tail = pickNextTail(seed, gentle);

  const line = `${lead}${n}${tail}`.replace(/\s{2,}/g, ' ').trim();

  if (minimalEmoji) return line;
  return `🌱 ${line}`;
}

/* =========================
   Descent helper (TCF)
========================= */

function adjustNextForDescent(
  next: string,
  seed: string,
  spinStep: number | null,
): string {
  const base = (next ?? '').toString().trim();
  if (!base) return base;

  const step =
    typeof spinStep === 'number' && Number.isFinite(spinStep)
      ? Math.round(spinStep)
      : null;

  if (step === 2) {
    const tail = pick(seed + '|dF', ['を毎日1回だけ', 'を固定ルールに', 'を習慣の1手に']);
    return `${base}${tail}`;
  }
  if (step === 1) {
    const tail = pick(seed + '|dC', ['を形にして残す', 'をメモにして固定する', 'を手順として置く']);
    return `${base}${tail}`;
  }

  const tail = pick(seed + '|dT', ['を一度だけ整える', 'を小さく立ち上げる', 'を静かに再起動する']);
  return `${base}${tail}`;
}

/* =========================
   Next phrasing (bank)
========================= */

function pickNextLead(seed: string, gentle: boolean): string {
  const arr = gentle
    ? ['今日は、', 'まずは ', 'ここから ', '', 'いったん ', 'スムーズ ']
    : ['まず ', '今夜は、', 'ここから ', '', '先に ', '最初に '];

  return pick(seed + '|nLead', arr);
}

function pickNextTail(seed: string, gentle: boolean): string {
  const arr = gentle
    ? [' を1度だけ。', ' だけ。', ' を短く。', ' を5分だけ。', ' を小さく。', '。']
    : [' から着地。', ' を先に通す。', ' を短く。', ' を10分だけ。', '。', ''];

  const t = pick(seed + '|nTail', arr);
  if (!t) return '。';
  return t.startsWith(' ') || t.startsWith('。') ? t : ` ${t}`;
}

function pickNextSectionLabel(seed: string): string {
  return pick(seed + '|nLabel', ['動き', '一歩', '着地', 'ここから', 'やること', '手順']);
}

/* =========================
   Helpers
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

  return t.replace(/です。$/g, '感じです。').replace(/だ。$/g, 'かもしれません。');
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
    String((vector as any).depthLevel ?? ''),
    String(Math.round((((vector as any).grounding ?? 0) as number) * 100)),
    String(Math.round((((vector as any).precision ?? 0) as number) * 100)),
    String(Math.round((((vector as any).transcendence ?? 0) as number) * 100)),
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

/* =========================
   NO_DELTA detection (minimal restore)
========================= */

function detectNoDelta(vector: ResonanceVector): boolean {
  const v: any = vector as any;

  if (v?.noDelta === true) return true;

  const sp = v?.slotPlan;
  if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
    const obs = typeof sp.OBS === 'string' ? sp.OBS : null;
    if (obs && obs.includes(':no-delta')) return true;
  }

  const slots = v?.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const obs = typeof slots.OBS === 'string' ? slots.OBS : null;
    if (obs && obs.includes(':no-delta')) return true;
  }

  return false;
}

function detectNoDeltaKind(
  vector: ResonanceVector,
): 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null {
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

function pickSlotPlanFromVector(
  vector: ResonanceVector,
): Record<string, string | null> | null {
  const v: any = vector as any;
  const sp = v?.slotPlan;
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;

  return {
    OBS: typeof sp.OBS === 'string' ? sp.OBS : null,
    SHIFT: typeof sp.SHIFT === 'string' ? sp.SHIFT : null,
    NEXT: typeof sp.NEXT === 'string' ? sp.NEXT : null,
    SAFE: typeof sp.SAFE === 'string' ? sp.SAFE : null,
  };
}

// framePlan.slots の required を見て null を埋める
function fillRequiredSlots(args: {
  framePlan: any | null;
  slotPlan: Record<string, string | null> | null;
}): Record<string, string | null> {
  const fp = args.framePlan;
  const sp = (args.slotPlan ?? {}) as Record<string, string | null>;

  const requiredIds: string[] = Array.isArray(fp?.slots)
    ? fp.slots
        .filter((s: any) => s && s.required === true && typeof s.id === 'string')
        .map((s: any) => String(s.id))
    : [];

  const defaults: Record<string, string> = {
    OBS: 'OBS:reflect',
    SHIFT: 'SHIFT:one-angle',
    NEXT: 'NEXT:action',
    SAFE: 'SAFE:soft',
  };

  for (const id of requiredIds) {
    if (sp[id] == null) sp[id] = defaults[id] ?? `${id}:default`;
  }

  if (sp.SHIFT == null) sp.SHIFT = defaults.SHIFT;
  if (sp.NEXT == null) sp.NEXT = defaults.NEXT;

  return sp;
}

function buildInsightFromSlotPlan(
  slotPlan: Record<string, string | null> | null,
  seed: string,
): string | null {
  const shift = slotPlan?.SHIFT ?? null;
  if (!shift) return null;

  if (shift.startsWith('SHIFT:one-angle')) {
    return pick(seed + '|shift', [
      '視点を一段だけ変えるなら、「好き/嫌い」ではなく「楽に続くか」で選ぶのが効きます。',
      '焦点を少しずらすなら、「正しいか」より「自分が壊れない形」を基準にしてみてください。',
      'ポイントは、結論を急がず「進める形」を先に決めることです。',
    ]);
  }

  return pick(seed + '|shift2', [
    '一度だけ視点を切り替えると、動きが見えやすくなります。',
    'ここは見方を一段ずらすと、迷いがほどけます。',
  ]);
}

function buildNextFromSlotPlan(
  slotPlan: Record<string, string | null> | null,
  seed: string,
): string | null {
  const next = slotPlan?.NEXT ?? null;
  if (!next) return null;

  if (next.startsWith('NEXT:action')) {
    return pick(seed + '|next', [
      '候補を3つだけ書き、いちばん軽いものを試す。',
      'やることを1つに絞り、まず少しだけ着手する。',
      '「次やる1手」だけ決めて、他は保留にする。',
    ]);
  }

  return pick(seed + '|next2', ['少し覗いて', '1つだけ試して、そこで止める']);
}
