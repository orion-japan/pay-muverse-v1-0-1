// src/lib/iros/rotation/computeITTrigger.ts
// iros — IT Trigger (T-layer entry gate)
//
// 再設計ポイント（周辺カラム前提）
// - “ENTER / HOLD / OFF” の3状態
// - HOLD は短い繋ぎ文でT層を落とさない（ok=true を返す）
// - prevIt 判定は MemoryState を主ソースにする（metaは同一ターン内補助）
// - History の assistant.meta 欠損に備え、history探索は保険で残す
//
// 注意：ANCHOR_ENTRY（NO_EVIDENCE）は別レイヤ（次の手で直す）

export type MetaLike = {
  fixedNorth?: any; // 'SUN' or { key:'SUN', text:'太陽SUN' } 等
  intentLine?: any;

  // ✅ MemoryState由来の itx_* が meta に来る場合を想定（camel/snake両対応）
  itxStep?: string | null;
  itx_step?: string | null;
  itxReason?: string | null;
  itx_reason?: string | null;
  itxLastAt?: string | null;
  itx_last_at?: string | null;

  tLayerModeActive?: boolean;

  [k: string]: any;
};

export type MemoryStateLike = {
  itxStep?: string | null;
  itx_step?: string | null;
  itxReason?: string | null;
  itx_reason?: string | null;
  itxLastAt?: string | null;
  itx_last_at?: string | null;

  // DBそのままっぽいキーも吸う
  itx_step_db?: string | null;
  itx_reason_db?: string | null;
  itx_last_at_db?: string | null;

  // ついでに fixedNorth が乗ってくる可能性もある
  fixedNorth?: any;

  [k: string]: any;
};

export type ITTriggerFlags = {
  hasCore: boolean;
  coreRepeated: boolean;
  sunOk: boolean;
  declarationOk: boolean;
  deepenOk: boolean;
};

export type ITTriggerMode = 'ENTER' | 'HOLD' | 'OFF';

export type ITTriggerResult = {
  ok: boolean;
  mode: ITTriggerMode;
  reason: string;
  flags: ITTriggerFlags;

  // 失敗時は I語彙を強制して “I層止まり” にする
  iLexemeForce?: boolean;

  // ok=true（ENTER/HOLD）のときだけ下流が使う
  tLayerModeActive?: boolean;
  tLayerHint?: string | null;
  tVector?: any | null;

  // デバッグ/下流連携のため残す（任意）
  core?: string | null;
};

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

function safeParseDate(s: unknown): Date | null {
  const t = norm(s);
  if (!t) return null;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

// -----------------------------------------
// FixedNorth util（meta / memoryState 両対応）
// -----------------------------------------
function getFixedNorthKey(src: any | null): string | null {
  if (!src) return null;

  const key =
    typeof src?.fixedNorth?.key === 'string'
      ? String(src.fixedNorth.key)
      : typeof src?.fixedNorth === 'string'
        ? String(src.fixedNorth)
        : null;

  return key ? norm(key) : null;
}

function hasFixedNorthSUN(meta: MetaLike | null, ms: MemoryStateLike | null): boolean {
  // ✅ 主：MemoryState（無ければmeta）
  const msKey = getFixedNorthKey(ms);
  if (msKey) return msKey === 'SUN';

  const metaKey = getFixedNorthKey(meta);
  if (metaKey) return metaKey === 'SUN';

  return false;
}

// -----------------------------------------
// History utilities
// -----------------------------------------
function pickRecentUserTexts(history: any[], n: number): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
    const h = history[i];
    const role = String(h?.role ?? '').toLowerCase();
    if (role === 'user') {
      const t =
        typeof h?.text === 'string'
          ? h.text
          : typeof h?.content === 'string'
            ? h.content
            : '';
      const nt = norm(t);
      if (nt) out.push(nt);
    }
  }
  out.reverse();
  return out;
}

// ✅ 直近 assistant の meta から IT_TRIGGER_OK を探す（metaが欠けていても少し遡る）
function findPrevItOkFromHistory(history: any[]): boolean {
  let checkedAssistant = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const role = String(h?.role ?? '').toLowerCase();
    if (role !== 'assistant') continue;

    checkedAssistant++;

    const m = h?.meta ?? h?.extra?.meta ?? null;

    // metaが無い assistant は “ノイズ” として少しだけ飛ばす（最大3個）
    if (!m) {
      if (checkedAssistant >= 3) return false;
      continue;
    }

    const r1 = String(m?.itxReason ?? '');
    const r2 = String(m?.itx_reason ?? '');
    if (r1.includes('IT_TRIGGER_OK') || r2.includes('IT_TRIGGER_OK')) return true;

    // 保険：T層起動フラグが残っている場合も IT 扱い
    if (m?.tLayerModeActive === true) return true;

    // metaありassistantに到達したらここで打ち切り（直近の判断を尊重）
    return false;
  }

  return false;
}

// -----------------------------------------
// Commit-short（短いコミット宣言）
// -----------------------------------------
function isCommitShortText(text: string): boolean {
  const t = norm(text);
  return /^(継続する|継続します|続ける|続けます|やる|やります|進める|進みます|守る|守ります|決めた|決めました)$/u.test(
    t,
  );
}

// -----------------------------------------
// Prev IT state
// - 主：MemoryState
// - 補：meta（同一ターン内の補助）
// -----------------------------------------
const IT_HOLD_WINDOW_MS = 60 * 60 * 1000; // 1h（必要なら調整）

function readPrevItActiveFromMemoryState(ms: MemoryStateLike | null): {
  active: boolean;
  step: string | null;
  reason: string | null;
  lastAt: Date | null;
} {
  if (!ms) return { active: false, step: null, reason: null, lastAt: null };

  const step = norm((ms as any)?.itxStep ?? (ms as any)?.itx_step ?? (ms as any)?.itx_step_db ?? '');
  const reason = norm(
    (ms as any)?.itxReason ?? (ms as any)?.itx_reason ?? (ms as any)?.itx_reason_db ?? '',
  );
  const lastAt = safeParseDate(
    (ms as any)?.itxLastAt ?? (ms as any)?.itx_last_at ?? (ms as any)?.itx_last_at_db ?? '',
  );

  let active = false;

  // step があれば基本 active
  if (step) active = true;

  // reason で補強
  if (!active && reason.includes('IT_TRIGGER_OK')) active = true;
  if (!active && reason.includes('IT_HOLD')) active = true;

  // ✅ T3 は「コミット済み」扱い：時間で失効させない
  const isCommittedT3 = step === 'T3' && reason.includes('IT_TRIGGER_OK');

  // lastAt が取れる場合は “古すぎる保持” を切る（ただしT3コミットは除外）
  if (active && lastAt && !isCommittedT3) {
    const age = Date.now() - lastAt.getTime();
    if (age > IT_HOLD_WINDOW_MS) active = false;
  }

  return { active, step: step || null, reason: reason || null, lastAt };
}

function readPrevItActiveFromMeta(meta: MetaLike | null): {
  active: boolean;
  step: string | null;
  reason: string | null;
  lastAt: Date | null;
} {
  if (!meta) return { active: false, step: null, reason: null, lastAt: null };

  const step = norm((meta as any)?.itxStep ?? (meta as any)?.itx_step ?? '');
  const reason = norm((meta as any)?.itxReason ?? (meta as any)?.itx_reason ?? '');
  const lastAt = safeParseDate((meta as any)?.itxLastAt ?? (meta as any)?.itx_last_at ?? '');

  let active = false;

  // step があれば基本 active
  if (step) active = true;

  // reason で補強
  if (!active && reason.includes('IT_TRIGGER_OK')) active = true;
  if (!active && reason.includes('IT_HOLD')) active = true;

  // tLayerModeActive が来てるケースも保険
  if (!active && (meta as any)?.tLayerModeActive === true) active = true;

  // ✅ T3 は「コミット済み」扱い：時間で失効させない
  const isCommittedT3 = step === 'T3' && reason.includes('IT_TRIGGER_OK');

  // lastAt が取れる場合は “古すぎる保持” を切る（ただしT3コミットは除外）
  if (active && lastAt && !isCommittedT3) {
    const age = Date.now() - lastAt.getTime();
    if (age > IT_HOLD_WINDOW_MS) active = false;
  }

  return { active, step: step || null, reason: reason || null, lastAt };
}

// -----------------------------------------
// Core extraction (minimal but practical)
// -----------------------------------------
function isGenericCoreCandidate(s: string): boolean {
  const t = norm(s);
  return t === 'これ' || t === 'それ' || t === 'ここ' || t === 'そこ' || t === 'あれ' || t === 'どれ';
}

function extractCore(meta: MetaLike | null, text: string): string | null {
  // 1) meta優先
  const coreFromMeta = norm((meta as any)?.intentLine?.coreNeed ?? '');
  if (coreFromMeta) return coreFromMeta;

  const t = norm(text);
  if (!t) return null;

  // 2) 引用符
  const m1 = t.match(/[「“](.{2,24})[」”]/);
  if (m1?.[1]) return norm(m1[1]);

  // 3) 「Xで進むと決めた」系
  const mProg1 = t.match(/(.{2,24})で進むと決め(?:た|ました)/);
  if (mProg1?.[1]) return norm(mProg1[1] + 'で進む');

  // 3.1) 「Xで進む。」系
  const mProg2 = t.match(/(.{2,24})で進む(?:。|！|!|$)/);
  if (mProg2?.[1]) {
    const c = norm(mProg2[1]);
    if (!isGenericCoreCandidate(c)) return norm(c + 'で進む');
  }

  // 4) 末尾の願望/意思
  const m2 = t.match(/(.{2,24})(したい|になりたい|を決めたい|を選びたい)$/);
  if (m2?.[1]) return norm(m2[1]);

  // 5) 相談・困り・不安・どうしたら系
  const m3 = t.match(
    /(.{2,24})(どうしたら|どうすれば|困って|迷って|不安|焦って|怖い|つらい|苦しい)(.{0,6})[？?]?$/,
  );
  if (m3?.[1]) return norm(m3[1] + m3[2]);

  // 6) 疑問文の核
  const m4 = t.match(/(.{2,24})(?:かしら|かな|ですか|ますか|でしょうか)[？?]?$/);
  if (m4?.[1]) return norm(m4[1]);

  return null;
}

// -----------------------------------------
// Declaration / Affirm
// -----------------------------------------
const DECL_RE =
  /(宣言|決める|決めた|選ぶ|選び直す|固定する|これでいく|コミット|腹を決める|本気で|意図する|北極星にする|SUNにする)/;

const AFFIRM_RE =
  /(うん|はい|そう|その通り|間違いない|確かに|それだ|それでいく|OK|了解|やる|やります|やりたい)/i;

function hasDeclaration(text: string): boolean {
  if (isCommitShortText(text)) return true;
  return DECL_RE.test(text);
}

function hasAffirm(text: string): boolean {
  if (isCommitShortText(text)) return true;
  return AFFIRM_RE.test(text);
}

// -----------------------------------------
// Narrow / Focus（絞り込み宣言）
// -----------------------------------------
const NARROW_RE =
  /(次はここだけ|ここだけ見|一点だけ|一つだけ|ひとつだけ|これだけ|だけにする|絞る|絞り込む|フォーカス|集中する|一点にする|一点に絞る)/;

function hasNarrow(text: string): boolean {
  return NARROW_RE.test(text);
}

// -----------------------------------------
// SUN / BLOCK 判定
// -----------------------------------------
const SUN_WORDS = ['成長', '進化', '希望', '歓喜'];

const SUN_EXPLICIT_RE =
  /(太陽\s*SUN|SUN\s*固定|SUN\s*に\s*する|北極星\s*(?:に|を)?\s*(?:固定|する)?)/i;

const BLOCK_RE =
  /(ブロック|壁|詰ま(っ|り)|止ま(っ|り)|動けない|抜けない|閉じてる|壊したい|崩したい)/;

function hasBlock(text: string): boolean {
  return BLOCK_RE.test(text);
}

function hasSunByWords(text: string): boolean {
  if (SUN_EXPLICIT_RE.test(text)) return true;
  return SUN_WORDS.some(w => text.includes(w));
}

/**
 * SUNゲート（ENTER用）
 * - fixedNorth=SUN が前提（※ここは meta を基準にする）
 * - 本文に SUN語彙 or BLOCK があるときだけ成立
 * - 短いコミット文は “直近ユーザーがSUNを言っている” ときだけ救済
 */
function sunGateOkEnter(meta: MetaLike | null, text: string, historyTexts: string[]): boolean {
  const northMeta = getFixedNorthKey(meta);
  if (northMeta !== 'SUN') return false;

  if (hasSunByWords(text) || hasBlock(text)) return true;

  // 短いコミットは直近ユーザーのSUN語彙で救済
  if (isCommitShortText(text)) {
    const lastUserHadSun = historyTexts.slice(-3).some(h => hasSunByWords(h));
    if (lastUserHadSun) return true;
  }

  return false;
}

/* ============================================================
   メイン：ITトリガー
============================================================ */

export function computeITTrigger(args: {
  text: string;
  history?: any[];
  meta?: MetaLike | null;

  // ✅ 追加：主ソース（metaより優先）
  memoryState?: MemoryStateLike | null;
}): ITTriggerResult {
  const text = norm(args.text);
  const history = Array.isArray(args.history) ? args.history : [];
  const meta = args.meta ?? null;
  const memoryState = args.memoryState ?? null;

  const historyTexts = pickRecentUserTexts(history, 8);

  // ✅ 主：MemoryState / 補：meta / 保険：history
  const prevFromMemoryState = readPrevItActiveFromMemoryState(memoryState);
  const prevFromMeta = readPrevItActiveFromMeta(meta);
  const prevFromHistory = findPrevItOkFromHistory(history);

  // ✅ fixedNorth(SUN) はここで一本化（以後これだけ使う）
  const hasNorth = hasFixedNorthSUN(meta, memoryState);

  console.log('[IROS/IT][probe][fixedNorth]', {
    hasMeta: Boolean(meta),
    fixedNorth_meta: getFixedNorthKey(meta),
    fixedNorth_ms: getFixedNorthKey(memoryState),
    hasNorth,
    prevIt_fromMemoryState: prevFromMemoryState,
    prevIt_fromMeta: prevFromMeta,
    prevIt_fromHistory: prevFromHistory,
  });

  // ✅ コミット済みT3（T3 + IT_TRIGGER_OK）は “毎ターンSUN語彙を要求しない”
  const committedT3 =
    hasNorth &&
    prevFromMemoryState.step === 'T3' &&
    String(prevFromMemoryState.reason ?? '').includes('IT_TRIGGER_OK');

  // “短い繋ぎ文”判定
  const isVeryShort = text.length > 0 && text.length <= 14;

  // ---- 1. 核抽出 ----
  let core = extractCore(meta, text);
  if (!core) {
    for (const h of historyTexts) {
      const c = extractCore(meta, h);
      if (c) {
        core = c;
        break;
      }
    }
  }
  const hasCore = !!core;

  // ---- 2. 宣言・深度判定 ----
  const declaredNow = hasDeclaration(text);
  const affirmed = hasAffirm(text) || declaredNow;

  const coreRepeated = hasCore && historyTexts.some(h => (core ? h.includes(core) : false));

  // ---- 3. “前回ITが生きているか” ----
  // ✅ MemoryState を主に判定し、meta/historyは補助
  const prevItActive = hasNorth && (prevFromMemoryState.active || prevFromMeta.active || prevFromHistory);

  // ✅ HOLD 条件：前回ITが生きていて、短い繋ぎ文なら維持
  const holdOkShort =
    prevItActive &&
    isVeryShort &&
    (affirmed || isCommitShortText(text) || hasSunByWords(text) || hasBlock(text));

  // ---- 4. SUNゲート ----
  // ENTERは厳密（meta fixedNorth=SUN + 本文にSUN語彙/BLOCK）
  // HOLDは “前回ITが生きている” なら救済
  let sunOk = sunGateOkEnter(meta, text, historyTexts);
  if (!sunOk && holdOkShort) sunOk = true;

  // ---- 5. deepenOk ----
  const deepenOk = declaredNow || affirmed || (hasCore && coreRepeated && hasNarrow(text)) || holdOkShort;

  // ---- 6. ENTER判定 ----
  const enterOk = hasCore && sunOk && deepenOk;

  if (enterOk) {
    return {
      ok: true,
      mode: 'ENTER',
      reason: 'IT_TRIGGER_OK',
      flags: {
        hasCore,
        coreRepeated,
        sunOk,
        declarationOk: declaredNow,
        deepenOk,
      },
      iLexemeForce: false,
      tLayerModeActive: true,
      tLayerHint: 'T2',
      tVector: null,
      core,
    };
  }

  // ✅ 6.5 コミット済みT3は常時HOLD（今回の本丸）
  if (committedT3) {
    return {
      ok: true,
      mode: 'HOLD',
      reason: 'IT_ALREADY_COMMITTED',
      flags: {
        hasCore,
        coreRepeated,
        sunOk: true,
        declarationOk: declaredNow,
        deepenOk: true,
      },
      iLexemeForce: false,
      tLayerModeActive: true,
      tLayerHint: 'T3',
      tVector: null,
      core,
    };
  }

  // ---- 7. HOLD判定（短い繋ぎのみ） ----
  if (holdOkShort && hasNorth) {
    // ✅ step は MemoryState を最優先（なければ meta）
    const keepStepRaw =
      prevFromMemoryState.step && /^T[123]$/u.test(prevFromMemoryState.step)
        ? prevFromMemoryState.step
        : prevFromMeta.step && /^T[123]$/u.test(prevFromMeta.step)
          ? prevFromMeta.step
          : null;

    const keepStep = keepStepRaw ?? 'T2';

    return {
      ok: true,
      mode: 'HOLD',
      reason: 'IT_HOLD',
      flags: {
        hasCore,
        coreRepeated,
        sunOk: true,
        declarationOk: declaredNow,
        deepenOk: true,
      },
      iLexemeForce: false,
      tLayerModeActive: true,
      tLayerHint: keepStep,
      tVector: null,
      core,
    };
  }

  // ---- 8. OFF（失敗時） ----
  return {
    ok: false,
    mode: 'OFF',
    reason: [
      !hasCore ? 'NO_CORE' : null,
      !sunOk ? 'NO_SUN_OR_BLOCK' : null,
      !deepenOk ? 'NO_DECLARATION' : null,
    ]
      .filter(Boolean)
      .join('|'),
    iLexemeForce: true,
    flags: {
      hasCore,
      coreRepeated,
      sunOk,
      declarationOk: declaredNow,
      deepenOk,
    },
    tLayerModeActive: false,
    tLayerHint: null,
    tVector: null,
    core,
  };
}
