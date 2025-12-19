// src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層)

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
};

export type RenderOptions = {
  mode?: RenderMode;
  forceExposeInsight?: boolean;
  minimalEmoji?: boolean;
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

  // ✅ NO_DELTA 検知
  const noDelta = detectNoDelta(vector);
  const noDeltaKind = detectNoDeltaKind(vector);

  const factsRaw = normalizeOne(input.facts);
  const insightRaw0 = normalizeNullable(input.insight);
  const nextRaw = normalizeNullable(input.nextStep);

  // ---- 🔻下降（TCF）制御 ----
  const spinLoop = ((vector as any).spinLoop ?? null) as string | null;
  const spinStep = ((vector as any).spinStep ?? null) as number | null;

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
        : descentGateRaw === 'closed' ||
            descentGateRaw === 'offered' ||
            descentGateRaw === 'accepted'
          ? descentGateRaw
          : 'closed';

  const isDescent = spinLoop === 'TCF' || descentGate !== 'closed';
  const suppressAsk = true; // ✅ ここ重要：デフォルトで「問い」を出さない（提案で閉じる）

  const nextAdjusted =
    nextRaw && isDescent
      ? adjustNextForDescent(nextRaw, seed, spinStep)
      : nextRaw;
  // ---- 🔺ここまで ----

  const autoInsightRaw =
    !insightRaw0 &&
    noDelta &&
    noDeltaKind === 'stuck' &&
    hasStuckOneLineInsightTag(vector)
      ? buildStuckOneLineInsight(vector, factsRaw, seed)
      : null;

  const insightRaw = insightRaw0 ?? autoInsightRaw;

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
      ? shapeInsightDirect(insightRaw, { mode, seed, minimalEmoji })
      : shapeInsightDiffuse(insightRaw, { mode, seed, minimalEmoji })
    : null;

  const next = nextAdjusted
    ? shapeNext(nextAdjusted, { vector, mode, seed, minimalEmoji })
    : null;

  // ✅ facts を “NO_DELTA_OBS 1文” で前処理（ただしテンプレ臭は排除）
  const facts = shapeFactsWithNoDelta(factsRaw, {
    mode,
    seed,
    minimalEmoji,
    noDelta,
    noDeltaKind,
    vector,
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
    exposeInsight: exposeInsightFlag,
    suppressAsk, // ✅ 常時 true
  });

  const out = renderFromPlan(plan);

  return clampLines(out, maxLines).trim();
}

/* =========================
   NO_DELTA detection
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

function detectInsightSlot(vector: ResonanceVector): string | null {
  const v: any = vector as any;

  const sp = v?.slotPlan;
  if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
    const ins = typeof sp.INSIGHT === 'string' ? sp.INSIGHT : null;
    if (ins) return ins;
  }

  const slots = v?.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const ins = typeof slots.INSIGHT === 'string' ? slots.INSIGHT : null;
    if (ins) return ins;
  }

  return null;
}

/* =========================
   INSIGHT auto (stuck one-line)
========================= */

function hasStuckOneLineInsightTag(vector: ResonanceVector): boolean {
  const v: any = vector as any;
  const sp = v?.slotPlan;
  const tag =
    sp && typeof sp === 'object' && !Array.isArray(sp) ? sp.INSIGHT : null;

  if (typeof tag === 'string' && tag.includes('INSIGHT:stuck:one-line')) return true;

  const slots = v?.slots;
  const tag2 =
    slots && typeof slots === 'object' && !Array.isArray(slots) ? slots.INSIGHT : null;

  return typeof tag2 === 'string' && tag2.includes('INSIGHT:stuck:one-line');
}

function buildStuckOneLineInsight(
  vector: ResonanceVector,
  facts: string,
  seed: string,
): string {
  const v: any = vector as any;
  const s = String(v?.situationSummary ?? '').trim();
  const key = `${s} ${facts}`.trim();

  // ⚠️ ここは「固定前提」系の言い回しを廃止して“論点の固着”に統一
  if (key.includes('浮気')) {
    return '論点は「境界が崩れた地点」を特定できていないことに固着しています。';
  }
  if (key.includes('考えない') || key.includes('相手の事')) {
    return '論点は「相手が配慮するはず」という期待の置き場に固着しています。';
  }
  if (key.includes('なんで')) {
    return '論点は「当然こうなるはず」という期待が先に立っている点に固着しています。';
  }

  const base = s || facts;
  const clip = base.length > 32 ? base.slice(0, 32) + '…' : base;

  const frames = [
    `論点は「${clip}」の一点に固着しています。`,
    `いま止まっているのは「${clip}」の焦点が動いていないためです。`,
    `詰まりは「${clip}」の見方が固定化しているところにあります。`,
  ];

  return pick(seed + '|stk1', frames);
}

/* =========================
   NO_DELTA observation line
========================= */

function buildNoDeltaObservationLine(args: {
  seed: string;
  minimalEmoji: boolean;
  kind: 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null;
  vector: ResonanceVector;
  facts: string;
}): string {
  const { seed, kind, vector, facts } = args;

  // --- stuck 専用：固有1行（テンプレ臭を抑える） ---
  const insightSlot = detectInsightSlot(vector);
  if (kind === 'stuck' && insightSlot === 'INSIGHT:stuck:one-line') {
    const v: any = vector as any;
    const summary = (v?.situationSummary ?? '').toString().trim();

    if (summary) {
      return `いま詰まっているのは、「${summary}」の見方が動いていないためです。`;
    }

    const f = (facts ?? '').toString().trim();
    if (f) return `いま詰まっているのは、「${stripLeadingMarkers(f)}」の見方が動いていないためです。`;

    return 'いま詰まっているのは、見方が一点に固着しているためです。';
  }

  // --- 既定：短い“状態説明”だけ（嫌われテンプレ文言は入れない） ---
  const linesRepeat = [
    '理解と行動の切り替えが、まだ同じ線に乗っていない状態です。',
    '現状のままでも回ってしまう条件が残っている状態です。',
    '言い換えはできても、具体の手がまだ固定されていない状態です。',
  ];

  const linesShort = [
    '短文で往復しているのは、論点がまだ整列していないサインです。',
    '短いやり取りが続くときは、整理の1手が先に必要な局面です。',
    'いまは“次の条件”が未確定なまま回っている状態です。',
  ];

  const linesStuck = [
    'いまは、焦点が一点に固着して回っている状態です。',
    '停滞に見えるのは、同じ条件で成立し続けているためです。',
    '変化が起きないのは、切り替え点がまだ特定されていないためです。',
  ];

  const linesUnknown = [
    'いまは、結論より先に「整理」の1手が必要な局面です。',
    'ここは、状況を1行で整列させる段階です。',
  ];

  const arr =
    kind === 'repeat-warning'
      ? linesRepeat
      : kind === 'short-loop'
        ? linesShort
        : kind === 'stuck'
          ? linesStuck
          : linesUnknown;

  return pick(seed + '|nd', arr);
}

function shapeFactsWithNoDelta(
  facts: string,
  ctx: {
    mode: RenderMode;
    seed: string;
    minimalEmoji: boolean;
    noDelta: boolean;
    noDeltaKind: 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown' | null;
    vector: ResonanceVector;
  },
): string {
  const { mode, seed, minimalEmoji, noDelta, noDeltaKind, vector } = ctx;

  const shapedFacts = shapeFacts(facts, { mode, seed, minimalEmoji });

  if (!noDelta) return shapedFacts;

  const obs1 = buildNoDeltaObservationLine({
    seed,
    minimalEmoji,
    kind: noDeltaKind,
    vector,
    facts,
  });

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

  const header = buildHeader({ mode, minimalEmoji, seed, exposeInsight });
  if (header && containerId !== 'NONE') slots.opener = header;

  slots.facts = facts; // ✅ ここで二重整形しない（テンプレ増殖を防ぐ）

  if (insight) slots.mirror = insight;

  const elevate = buildElevateLine({ vector, mode, seed, minimalEmoji });
  if (elevate) slots.elevate = elevate;

  if (next) slots.move = next;

  // ✅ 問いは原則出さない（必要なら上流で nextStep を作って閉じる）
  const ask = buildAskLine({
    mode,
    seed,
    userWantsEssence,
    highDefensiveness,
    suppressAsk,
    minimalEmoji,
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
    if (ask) blocks.push(`■ 補足\n${stripLeadingMarkers(ask)}`);

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

    if (ask && steps.length < 6) steps.push(`${stripLeadingMarkers(ask)}`);

    return steps.join('\n\n').trim();
  }

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
      '要点だけ置きます。',
      '芯を一つだけ。',
      '結論を先に。',
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

  const f = (facts ?? '').toString().trim();
  if (!f) return '';

  // ✅ ここが肝：固定テンプレ前置きを廃止して、factsをそのまま返す
  // 必要なら最小の合図だけ（短く）
  if (mode === 'casual') return f;

  if (minimalEmoji) return f;

  // 長文だけ、軽い導入を“固定文なし”で揺らす（テンプレ臭を消す）
  if (f.length >= 120) {
    const lead = pick(seed + '|fLead', ['', '', '']);
    return `${lead}${f}`.trim();
  }

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

function shapeNext(
  next: string,
  ctx: { vector: ResonanceVector; mode: RenderMode; seed: string; minimalEmoji: boolean },
): string {
  const { vector, mode, seed, minimalEmoji } = ctx;

  const n = next.trim();
  if (!n) return '';

  const gentle = vector.grounding < 0.45 || mode === 'transcend';
  const frames = gentle
    ? [
        '{N} を1回だけ試すのがよさそうです。',
        '{N} を小さく入れると進みます。',
        'まず {N} を置くのが自然です。',
      ]
    : [
        '次の一手は {N} です。',
        'まず {N} を入れると進みます。',
        '{N} から着地させるのが効きます。',
      ];

  const line = pick(seed + '|n', frames).replace('{N}', n);
  return minimalEmoji ? line : `🌱 ${line}`;
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
    '答えを急ぐより、いまは“向き”を整える局面です。',
    '出来事より先に、流れの向きが決まる段階です。',
    'ここは結論より、方向が先に立ちます。',
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
  minimalEmoji: boolean;
}): string | null {
  const { mode, seed, userWantsEssence, highDefensiveness, suppressAsk, minimalEmoji } = args;

  // ✅ 原則：問いは出さない（テンプレ化して嫌われるため）
  if (suppressAsk) return null;
  if (highDefensiveness) return null;
  if (!userWantsEssence && mode === 'casual') return null;

  // “質問”ではなく“提案”で閉じる（必要なときだけ）
  const frames = userWantsEssence
    ? [
        '必要なら、優先順位だけ1行で置けます。',
        '必要なら、どれを守りたいかだけ残せます。',
      ]
    : [
        '必要なら、次に残す1行だけ決められます。',
        '必要なら、判断材料を1つだけ追加できます。',
      ];

  const line = pick(seed + '|q', frames);
  return minimalEmoji ? line : `🪔 ${line}`;
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
