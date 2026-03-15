// src/lib/iros/mirrorFlow/mirrorFlow.v1.ts
// iros — MIRROR_FLOW Engine (v1, pure functions)
// 目的：
// - Mirror（e_turn/polarity/confidence/meaningKey/field）を「構造に囚われず」観測する
// - Flow（delta/returnStreak/sessionBreak/micro）は既存正本（ctxPack.flow）を尊重しつつ併記する
// - v1はルールベース（LLM推定なし）で再現性を最優先
//
// NOTE:
// - 既存に micro 判定が複数あるため、ここでは衝突しない名前（*V1）で定義する
// - stage/band/polarity は upstream から渡される想定（未提供なら null のまま）
// - e_turn は「このターンの userText だけ」から推定（履歴参照なし）
// - meaningKey は confidence>=0.55 かつ座標が揃った時だけ立てる（それ以外は null）
//
// IMPORTANT (boundary):
// - e_turn は instant（非保存・非継続・構造決定に不関与）
// - e_turn から Q_code を再推定/上書きしない（ここでは扱わない）
//
// v1.1 change:
// - confidence（観測安定度）と intensity（感情エネルギー）を分離する
//   - confidence: 情報量/手がかりに基づく “安定度” 0..1
//   - intensity: そのターンの “熱/圧” 0..1（短文でも強く出る）

export type PolarityV1 = 'yin' | 'yang';
export type FlowDeltaV1 = 'FORWARD' | 'RETURN';
export type BandV1 = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

// e_turn: instant emotion energy (turn-only)
export type ETurnV1 = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

export type MirrorMetaV1 = {
  e_turn: ETurnV1 | null;
  polarity: PolarityV1 | null;

  // confidence: stability of observation (info-based)
  confidence: number; // 0..1

  // intensity: energy of emotion on this turn (signal-based)
  intensity: number; // 0..1

  meaningKey: string | null; // e.g. "C12_e3_yin"
  field: {
    colorKey: string | null; // e.g. "e3_yin"
    alpha: number; // 0..1 (usually = confidence)
    size: number; // 0..1 (energy proxy, length-ish)
    intensity: number; // 0..1 (usually = mirror.intensity)
  };
};

export type FlowMetaV1 = {
  delta: FlowDeltaV1 | null; // upstream may pass null, we preserve
  returnStreak: number | null;
  sessionBreak: boolean | null;
  micro: boolean;
};

export type CoordMetaV1 = {
  stage: number | null; // 1..18
  band: BandV1 | null;
};

export type MirrorFlowResultV1 = {
  mirror: MirrorMetaV1;
  flow: FlowMetaV1;
  coord: CoordMetaV1;
  basedOn: { key: string; value: string };
};

export type MirrorFlowInputV1 = {
  userText: string;

  // upstream（推定は禁止：未提供なら null）
  stage?: number | null;
  band?: BandV1 | null;
  polarity?: PolarityV1 | null;

  // flow は既存正本を渡す想定（未提供なら null で保持）
  flow?: {
    delta?: FlowDeltaV1 | null;
    returnStreak?: number | null;
    sessionBreak?: boolean | null;
  } | null;
};

// ---- helpers ----

const MICRO_WORDS = new Set<string>([
  'うん', 'はい', 'そう', 'そうだね', 'なるほど', '了解', 'りょうかい', 'ok', 'おk', 'おけ',
  'え', 'えー', 'うーん', 'うーむ', 'んー',
  '…', '...', '。。', '。', '！', '!', '？', '?',
  '笑', 'w', 'ww', 'www',
]);

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function normText(s: string): string {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function stripSpaces(s: string): string {
  return s.replace(/[ \t\u3000]/g, '');
}

function nonWordRatio(s: string): number {
  const t = stripSpaces(s);
  if (!t) return 1;
  const wordish = t.match(/[A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]/g)?.length ?? 0;
  const total = Array.from(t).length;
  return total === 0 ? 1 : (total - wordish) / total;
}

// ---- e_turn normalization ----
// E/e, Q/q, 1..5 を e1..e5 に正規化する（入力の互換用）
export function normalizeETurnV1(raw: any): ETurnV1 | null {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const s0 = raw.trim();
    if (!s0) return null;

    // accept e1..e5
    const m1 = s0.match(/^e([1-5])$/i);
    if (m1) return (`e${m1[1]}` as ETurnV1);

    // accept Q1..Q5 / q1..q5 / E1..E5
    const m2 = s0.match(/^[QqEe]([1-5])$/);
    if (m2) return (`e${m2[1]}` as ETurnV1);

    // accept bare digit "1".."5"
    const m3 = s0.match(/^([1-5])$/);
    if (m3) return (`e${m3[1]}` as ETurnV1);

    return null;
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 1 && n <= 5) return (`e${n}` as ETurnV1);
  }

  return null;
}

// ---- v1 micro ----

export function detectMirrorMicroV1(userText: string): boolean {
  const t0 = normText(userText);
  const t = stripSpaces(t0);
  const len = Array.from(t).length;

  if (!t) return true;

  // strong signal: short but meaningful -> NOT micro
  const strongSignal =
    /(?:無理|怖|こわ|恐|パニック|詰ん|怒|ムカ|イラ|腹立|許せ|最悪|不安|心配|悩|迷|自信ない|虚無|空虚|意味ない|つらい|辛い|しんどい|きつい)/.test(
      t
    ) || /[!！]{2,}/.test(t);

  // micro dictionary
  if (MICRO_WORDS.has(t.toLowerCase())) return true;

  // only emoji/punct/symbol
  if (/^[\p{Extended_Pictographic}\p{P}\p{S}]+$/u.test(t)) return true;

  // 1..3 chars: micro unless strong signal
  if (len <= 3) return !strongSignal;

  // 4..10 chars: decide by symbol ratio unless strong signal
  if (len <= 10) {
    if (strongSignal) return false;
    if (nonWordRatio(t) >= 0.7) return true;
    return false;
  }

  // mostly symbols
  if (nonWordRatio(t) >= 0.6) return true;

  return false;
}

// ---- v1 confidence (stability) ----

function infoScoreByLen(lenTrim: number): number {
  if (lenTrim <= 10) return 0.20;
  if (lenTrim <= 25) return 0.35;
  if (lenTrim <= 60) return 0.55;
  if (lenTrim <= 120) return 0.70;
  if (lenTrim <= 240) return 0.80;
  return 0.88;
}

function countHits(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n++;
  return n;
}

export function calcMirrorConfidenceV1(userText: string, micro: boolean): number {
  const t0 = normText(userText);
  const t = stripSpaces(t0);
  const lenTrim = Array.from(t).length;

  const info = infoScoreByLen(lenTrim);

  const hasSelf = /(?:私|俺|僕|自分)/.test(t) ? 0.05 : 0;
  const hasRel = /(?:相手|上司|家族|彼女|彼|友達|会社|組織|チーム|同僚)/.test(t) ? 0.04 : 0;
  const hasTime = /(?:今日|昨日|明日|今週|最近|さっき|これから|先週|今月|来月)/.test(t) ? 0.03 : 0;
  const hasAct = /(?:やる|やった|決めた|やめる|始める|進める|送る|作る|直す|変える)/.test(t) ? 0.03 : 0;
  const hasQ = /[？?]/.test(t) || /(?:どう|なぜ|何|どれ|いつ|どこ)/.test(t) ? 0.03 : 0;

  const clue = Math.min(hasSelf + hasRel + hasTime + hasAct + hasQ, 0.18);

  const vaguePatterns = [/なんか/, /たぶん/, /よくわからない/, /微妙/, /適当/, /いろいろ/];
  const vagueHits = countHits(t, vaguePatterns);
  let pen = 0;
  if (vagueHits >= 1) pen += 0.05;
  if (vagueHits >= 3) pen += 0.07; // total 0.12

  if (lenTrim <= 25 && /^(?:すごい|やばい|最高|無理|きつい|助かる|ありがとう)[!！]*$/.test(t)) {
    pen += 0.08;
  }

  pen = clamp(pen, 0, 0.25);

  let c = info + clue - pen;

  if (micro) {
    // micro is low-stability by definition
    c = Math.min(0.45, c);
    c = clamp(c, 0.05, 0.45);
  } else {
    c = clamp(c, 0.10, 0.95);
  }
  return c;
}

// ---- v1 energy size (proxy, mostly length) ----

export function calcMirrorEnergySizeV1(userText: string): number {
  const t = stripSpaces(normText(userText));
  const len = Array.from(t).length;
  const x = len / 180;
  const size = 1 - Math.exp(-x); // smooth saturation
  return clamp(size, 0, 1);
}

// ---- v1 e_turn detection (rule-based, turn-only) ----
// NOTE: v1 は「再現性優先」なので、軽いキーワード/記号ベースで推定。
// - e1: 抑圧/我慢/秩序（固さ・義務・抑え）
// - e2: 怒り/対立/成長（イライラ・反発・攻め）
// - e3: 不安/心配/安定（迷い・心配・確認）
// - e4: 恐怖/萎縮/浄化（怖い・無理・震え・回避）
// - e5: 虚無/落差/火種（空虚・燃えない・無意味・飽き）
export function detectETurnV1(userText: string, micro: boolean): ETurnV1 | null {
  const t0 = normText(userText);
  const t = stripSpaces(t0).toLowerCase();

  if (!t) return null;

  const hasExcl = /[!！]/.test(t);
  const hasQuest = /[?？]/.test(t);

  // ------------------------------------------------------------
  // 1) 強い感情シグナルは先に即決
  //    いまは「文脈」より「感情の生っぽさ」を優先する
  // ------------------------------------------------------------

  // e5: 空虚 / 虚無 / 消耗
  if (
    /空っぽ|空虚|虚無|虚しい|むなしい|意味ない|無意味|どうでもいい|燃えない|やる気ない|飽きた|疲れた|しんどい|つらい|辛い|きつい/.test(
      t
    )
  ) {
    return 'e5';
  }

  // e4: 怖さ / 回避 / 萎縮 / 緊張
  if (
    /怖い|こわい|怖さ|こわさ|怖|こわ|恐れ|恐い|無理|無理だ|無理かも|萎縮|逃げたい|避けたい|震え|緊張|パニック|詰ん/.test(
      t
    )
  ) {
    return 'e4';
  }

  // e2: 怒り / 反発 / 押し返し / 違和感の強さ
  if (
    /なんで|なぜ|納得いか|許せ|ムカ|イラ|腹立|ふざけ|舐め|キレ|最悪|違う気がする|おかしい|それは違う|やってられない/.test(
      t
    )
  ) {
    return 'e2';
  }

  // e1: 張りつめ / 固める / 整える / 我慢
  if (
    /張りつめ|張り詰め|張ってる|こわば|力が入|力ん|固まってる|固い|緩めない|ちゃんとして|ちゃんとしないと|我慢|抑え|耐え|整えたい|整理したい|確認したい|順番に|一つずつ|1つずつ/.test(
      t
    )
  ) {
    return 'e1';
  }

  // ------------------------------------------------------------
  // 2) 通常スコアリング
  // ------------------------------------------------------------

  // e1: 整える / 守る / 固める / 抑える
  const p1 = [
    /我慢/,
    /抑え/,
    /抑圧/,
    /耐え/,
    /義務/,
    /べき/,
    /ちゃんと/,
    /正しく/,
    /ルール/,
    /秩序/,
    /仕様/,
    /規約/,
    /制約/,
    /守ら/,
    /固定/,
    /禁止/,
    /許可/,
    /整理/,
    /整え/,
    /確認したい/,
    /確認して/,
    /確かめ/,
    /検証/,
    /実在確認/,
    /存在確認/,
    /一つずつ/,
    /1つずつ/,
    /順番/,
    /安全に/,
    /慎重/,
    /根拠を見たい/,
    /張りつめ/,
    /張り詰め/,
    /こわば/,
    /力が入/,
    /固ま/,
    /緩めない/,
  ];

  // e2: 怒り / 反発 / 押す / 突破
  const p2 = [
    /怒/,
    /ムカ/,
    /イラ/,
    /腹立/,
    /許せ/,
    /対立/,
    /反発/,
    /喧嘩/,
    /キレ/,
    /最悪/,
    /ふざけ/,
    /舐め/,
    /ぶち/,
    /ダメダメ/,
    /何やってきた/,
    /できてないじゃん/,
    /なんで/,
    /なぜ/,
    /納得いか/,
    /違う気がする/,
    /それは違う/,
    /おかしい/,
    /やる/,
    /進めたい/,
    /進もう/,
    /進める/,
    /試したい/,
    /試す/,
    /直したい/,
    /直す/,
    /修正/,
    /実装/,
    /作りたい/,
    /作る/,
    /見たい/,
    /見てほしい/,
    /貼る/,
    /出したい/,
    /突破/,
    /動かしたい/,
    /回したい/,
    /確認するぞ/,
  ];

  // e3: 不安 / 迷い / 確認 / どうしたら
  const p3 = [
    /不安/,
    /心配/,
    /迷/,
    /どうしよう/,
    /どうしたら/,
    /大丈夫かな/,
    /このままで大丈夫/,
    /恐らく/,
    /たぶん/,
    /微妙/,
    /悩/,
    /もや/,
    /モヤ/,
    /自信ない/,
    /確証/,
    /本当に/,
    /これでok/,
    /これで大丈夫/,
    /なんだっけ/,
    /思い出せ/,
    /あれって/,
    /どうだったっけ/,
  ];

  // e4: 怖さ / 回避 / 萎縮
  const p4 = [
    /怖/,
    /こわ/,
    /恐/,
    /無理/,
    /無理だ/,
    /無理かも/,
    /萎縮/,
    /逃げ/,
    /避け/,
    /震え/,
    /緊張/,
    /焦り/,
    /パニック/,
    /詰ん/,
    /無理ゲー/,
  ];

  // e5: 虚無 / 消耗 / 燃えない
  const p5 = [
    /虚無/,
    /空虚/,
    /空っぽ/,
    /虚しい/,
    /むなしい/,
    /意味ない/,
    /無意味/,
    /どうでも/,
    /燃え/,
    /やる気ない/,
    /飽き/,
    /しんどい/,
    /つらい/,
    /辛い/,
    /落ち込/,
    /疲れた/,
    /きつい/,
  ];

  // 弱い揺れは e3 に“少しだけ”
  const softUncertain = [
    /…+/,
    /\.{2,}/,
    /うーん/,
    /んー/,
    /えー/,
    /えっと/,
    /なんか/,
    /微妙/,
    /よくわからない/,
    /たぶん/,
  ];

  let s1 = countHits(t, p1);
  let s2 = countHits(t, p2);
  let s3 = countHits(t, p3);
  let s4 = countHits(t, p4);
  let s5 = countHits(t, p5);

  // 記号補正
  // ! は e2 を少し押す
  s2 += /[!！]{2,}/.test(t) ? 2 : hasExcl ? 1 : 0;

  // ? は e3 を“軽く”押すだけ
  // ただし他の感情が立っている時は押しすぎない
  const emotionalBase = s1 + s2 + s4 + s5;
  if (emotionalBase === 0) {
    s3 += /[?？]{2,}/.test(t) ? 2 : hasQuest ? 1 : 0;
  }

  // 弱い揺れは、他感情が立っていない時だけ e3 に加点
  const soft = countHits(t, softUncertain);
  if (soft >= 1 && emotionalBase === 0) s3 += 1;

  // 開発系の「確認」「根拠」は e1 側へ
  if (/確認|根拠|検証|存在確認|実在確認/.test(t)) s1 += 1;

  // 進行意図は e2 側へ
  if (/進めたい|直したい|修正したい|見たい|試したい|作りたい|やりたい/.test(t)) s2 += 1;

  // 消耗語は e5 優先
  if (/疲れた|しんどい|つらい|辛い|きつい/.test(t)) s5 += 1;

  const scores: Array<[ETurnV1, number]> = [
    ['e1', s1],
    ['e2', s2],
    ['e3', s3],
    ['e4', s4],
    ['e5', s5],
  ];
  scores.sort((a, b) => b[1] - a[1]);

  const [best, bestScore] = scores[0];

  // 全ゼロ時の安全デフォルト
  if (!bestScore || bestScore <= 0) {
    if (/疲れた|しんどい|つらい|辛い|きつい|空っぽ|虚無/.test(t)) return 'e5';
    if (/怖い|こわい|怖|こわ|恐|無理|震え|緊張/.test(t)) return 'e4';
    if (/なんで|なぜ|違う気がする|それは違う|ムカ|イラ|腹立/.test(t)) return 'e2';
    if (/張りつめ|張り詰め|こわば|力が入|整理|整え|確認|検証|順番|一つずつ|1つずつ/.test(t))
      return 'e1';
    if (/どうしよう|どうしたら|大丈夫かな|不安|心配/.test(t)) return 'e3';
    if (hasExcl) return 'e2';
    if (hasQuest) return 'e3';
    return micro ? 'e1' : 'e3';
  }

  // tie-break: 感情の強いものを優先
  const top = scores.filter(([, v]) => v === bestScore).map(([k]) => k);

  if (top.length >= 2) {
    if (top.includes('e5')) return 'e5';
    if (top.includes('e4')) return 'e4';
    if (top.includes('e2')) return 'e2';
    if (top.includes('e1')) return 'e1';
    return 'e3';
  }

  return best;
}

// ---- v1 intensity (energy on this turn; signal-based) ----
// NOTE:
// - confidence と違い、短文でも強信号なら上がる
// - micro でも上がり得る（ただし上限は抑えめ）
export function calcMirrorIntensityV1(args: {
  userText: string;
  micro: boolean;
  e_turn: ETurnV1 | null;
}): number {
  const t0 = normText(args.userText);
  const t = stripSpaces(t0).toLowerCase();
  if (!t) return 0;

  const micro = args.micro;
  const e = args.e_turn;

  const excl2 = /[!！]{2,}/.test(t);
  const quest2 = /[?？]{2,}/.test(t);
  const hasExcl = /[!！]/.test(t);
  const hasQuest = /[?？]/.test(t);

  // strong phrase set (fixed, reproducible)
  const strongWords = [
    /無理/, /怖|こわ|恐/, /パニック/, /詰ん/,
    /最悪/, /許せ/, /キレ/, /ふざけ/,
    /不安/, /心配/, /悩|迷/, /確証|根拠/,
    /虚無|空虚|無意味|意味ない/,
    /つらい|辛い|しんどい|きつい/,
  ];
  const strongHits = countHits(t, strongWords);

  // base by e_turn kind (turn energy bias)
  // e2/e4/e5 tends to feel higher pressure than e1/e3 in moment
  const baseByKind: Record<ETurnV1, number> = {
    e1: 0.35,
    e2: 0.60,
    e3: 0.45,
    e4: 0.65,
    e5: 0.55,
  };

  let x = 0.10;

  if (e) x += baseByKind[e];
  x += Math.min(0.25, strongHits * 0.12);

  // punctuation pressure
  if (excl2) x += 0.20;
  else if (hasExcl) x += 0.10;

  if (quest2) x += 0.10;
  else if (hasQuest) x += 0.05;

  // length gives a tiny support but not dominant (intensity ≠ info)
  const len = Array.from(t).length;
  x += clamp(len / 200, 0, 0.10);

  // micro cap (still can be strong, but not max)
  if (micro) x = Math.min(x, 0.75);

  return clamp(x, 0, 1);
}

// ---- meaningKey ----

export function makeMirrorMeaningKeyV1(args: {
  stage: number | null | undefined;
  band: BandV1 | null | undefined;
  e_turn: ETurnV1 | null | undefined;
  polarity: PolarityV1 | null | undefined;
  confidence: number;
}): string | null {
  const { stage, band, e_turn, polarity, confidence } = args;
  if (!stage || !band || !e_turn || !polarity) return null;
  if (confidence < 0.55) return null;
  return `${band}${stage}_${e_turn}_${polarity}`;
}

// ---- main ----

export function buildMirrorFlowV1(input: MirrorFlowInputV1): MirrorFlowResultV1 {
  const userText = input.userText ?? '';
  const micro = detectMirrorMicroV1(userText);

  // confidence = stability (info-based)
  const confidence = calcMirrorConfidenceV1(userText, micro);

  // size = energy proxy (length-ish)
  const size = calcMirrorEnergySizeV1(userText);

  const stage = input.stage ?? null;
  const band = input.band ?? null;

  // e_turn: turn-only (instant)
  const e_turn = detectETurnV1(userText, micro);

  // intensity: energy (signal-based)
  const intensity = calcMirrorIntensityV1({ userText, micro, e_turn });

  // ---- polarity normalization (for key stability) ----
  const normPol = (raw: any): 'yin' | 'yang' | null => {
    if (raw == null) return null;

    if (typeof raw === 'string') {
      const s = raw.trim().toLowerCase();
      if (!s) return null;

      if (s === 'yin' || s === '陰') return 'yin';
      if (s === 'yang' || s === '陽') return 'yang';

      if (s === 'positive' || s === 'pos' || s === '+' || s === 'plus') return 'yang';
      if (s === 'negative' || s === 'neg' || s === '-' || s === 'minus') return 'yin';

      return null;
    }

    return (
      normPol((raw as any).in) ||
      normPol((raw as any).out) ||
      normPol((raw as any).metaBand) ||
      normPol((raw as any).band) ||
      null
    );
  };

  const polarityRaw: any = (input as any).polarity ?? null;

  const polarity_metaBand: string | null =
    typeof polarityRaw === 'string'
      ? (polarityRaw.trim() ? polarityRaw.trim() : null)
      : (typeof (polarityRaw as any)?.metaBand === 'string' && (polarityRaw as any).metaBand.trim()
          ? (polarityRaw as any).metaBand.trim()
          : null);

  const polarity_in = normPol(polarityRaw);
  const polarity_out =
    normPol((polarityRaw as any)?.out) ||
    normPol((polarityRaw as any)?.in) ||
    polarity_in;

  const polarityForKey = polarity_in;

  const meaningKey = makeMirrorMeaningKeyV1({
    stage,
    band,
    e_turn,
    polarity: polarityForKey as any,
    confidence,
  });

  const colorKey = e_turn
    ? (polarityForKey ? `${e_turn}_${polarityForKey}` : `${e_turn}`)
    : null;

  const flowDelta = input.flow?.delta ?? null;
  const returnStreak =
    typeof input.flow?.returnStreak === 'number'
      ? input.flow!.returnStreak!
      : (input.flow?.returnStreak ?? null);
  const sessionBreak =
    typeof input.flow?.sessionBreak === 'boolean'
      ? input.flow!.sessionBreak!
      : (input.flow?.sessionBreak ?? null);

  return {
    mirror: {
      e_turn,
      polarity: {
        in: polarity_in,
        out: polarity_out,
        metaBand: polarity_metaBand,
      } as any,
      confidence,
      intensity,
      meaningKey,
      field: {
        colorKey,
        alpha: confidence,
        size,
        intensity,
      },
    },
    flow: {
      delta: flowDelta,
      returnStreak,
      sessionBreak,
      micro,
    },
    coord: {
      stage,
      band,
    },
    basedOn: {
      key: micro ? 'flow.micro' : 'flow.delta',
      value: micro ? 'true' : String(flowDelta ?? ''),
    },
  };
}
