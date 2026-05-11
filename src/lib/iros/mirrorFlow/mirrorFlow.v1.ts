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
export type TurnPolarityV1 = 'pos' | 'neg';
export type FlowDeltaV1 = 'FORWARD' | 'RETURN';
export type BandV1 = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

// e_turn: instant emotion energy (turn-only)
export type ETurnV1 = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

export type ETurnV2 = {
  base: 'E1' | 'E2' | 'E3' | 'E4' | 'E5';
  action: 'control' | 'push' | 'confirm' | 'avoid' | 'fill';
  polarity: 'pos' | 'neg' | null;
};

export type EmotionTextureV1 = {
  surface: string;
  inner: string;
  need: string;
  block: string;
} | null;

export type MirrorMetaV1 = {
  e_turn: ETurnV1 | null;
  e_turn_v2: ETurnV2 | null;
  emotionTexture: EmotionTextureV1;
  emotionProfile?: {
    primary: string;
    secondary: string[];
    balance: Record<string, number>;
  } | null;
  polarity: {
    in: PolarityV1 | null;
    out: PolarityV1 | null;
    metaBand: string | null;
  } | null;

  // confidence: stability of observation (info-based)
  confidence: number;

  // intensity: energy of emotion on this turn (signal-based)
  intensity: number;

  meaningKey: string | null;
  field: {
    colorKey: string | null;
    alpha: number;
    size: number;
    intensity: number;
  };
};

function mapToETurnV2(e: ETurnV1 | null, turnPolarity: TurnPolarityV1 | null): ETurnV2 | null {
  if (!e) return null;

  const baseMap = {
    e1: 'E1',
    e2: 'E2',
    e3: 'E3',
    e4: 'E4',
    e5: 'E5',
  } as const;

  const actionMap = {
    e1: 'control',
    e2: 'push',
    e3: 'confirm',
    e4: 'avoid',
    e5: 'fill',
  } as const;

  return {
    base: baseMap[e],
    action: actionMap[e],

    // ✅ yin/yang は内向き/外向きの位相。
    // pos/neg はこのターンの状態方向として別に渡す。
    polarity: turnPolarity,
  };
}

function buildEmotionTexture(args: {
  userText: string;
  e: ETurnV2 | null;
}): EmotionTextureV1 {
  const text = stripSpaces(normText(args.userText)).toLowerCase();
  const e = args.e;

  if (!text && !e) return null;

  const profile = buildEmotionProfile(args.userText);

  const contextPrimary = (() => {
    if (/iros|能力|一段|アップ|改善|修正|実装|精度|writer|seed|flow|q_code|e_turn|emotion|発揮|新しい/i.test(text)) {
      return 'e2_pos';
    }

    if (/彼|彼女|相手|恋愛|連絡|返信|既読|未読|好き|不安|心配|会えない|距離|関係/.test(text)) {
      return 'e3_neg';
    }

    return '';
  })();

  const fallbackPrimary =
    e?.base && e?.polarity ? `${String(e.base).toLowerCase()}_${e.polarity}` : '';

  const primary = String(
    contextPrimary ||
      profile?.primary ||
      fallbackPrimary ||
      '',
  ).trim();
  if (contextPrimary === 'e2_pos') {
    return {
      surface: '開発前進',
      inner: 'irosを、表面の言葉ではなく感情エネルギーから返答できる形に進めたい',
      need: 'emotion_primaryからe_turnと表示までつながった変化を、わかる言葉で出したい',
      block: '仕組みは動いているのに、返答が抽象化して変化が伝わりにくくなる',
    };
  }
  const textures: Record<string, Exclude<EmotionTextureV1, null>> = {
    e1_pos: {
      surface: '整理',
      inner: 'ばらついているものを、扱える順番に整えたい',
      need: '安全に確認しながら進めたい',
      block: '急に広げると崩れそうな感じがある',
    },
    e1_neg: {
      surface: '抑制',
      inner: 'ちゃんと保とうとして、内側が固まりやすくなっている',
      need: '崩さずに力を抜ける形がほしい',
      block: '緩めると乱れる感じがある',
    },

    e2_pos: {
      surface: '前進',
      inner: '今あるものを、もう一段動く形に進めたい',
      need: '止まっている材料を実際に動かしたい',
      block: '材料はあるのに、出力や形で浅くなる感じが残る',
    },
    e2_neg: {
      surface: '反発',
      inner: 'このまま流されることに納得できない',
      need: '止まっている状況をちゃんと動かしたい',
      block: '強く出すぎて壊したくない',
    },

    e3_pos: {
      surface: '確認',
      inner: 'つながりや安定を確かめながら進めたい',
      need: '関係や場の温度を見ながら安心して動きたい',
      block: '確かめきれないまま進むと揺れやすい',
    },
    e3_neg: {
      surface: '不安',
      inner: '曖昧なままにせず、分かる形で確かめたい',
      need: '状況の手触りを確かめたい',
      block: '重く見えすぎることを避けたい',
    },

    e4_pos: {
      surface: '保護',
      inner: '大事なものを守りながら慎重に進めたい',
      need: '無理に踏み込まず、安全な距離で見極めたい',
      block: '急に近づくと壊れそうな感じがある',
    },
    e4_neg: {
      surface: '怖さ',
      inner: '失敗したくない・傷つきたくない',
      need: '安全に進める形がほしい',
      block: '判断ミスへの恐れ',
    },

    e5_pos: {
      surface: '熱量',
      inner: '好きなものや情熱を、もっと素直に出したい',
      need: '内側の火を消さずに表に出したい',
      block: '強く出すと浮いてしまう感じがある',
    },
    e5_neg: {
      surface: '空虚',
      inner: '意味や熱が見えにくくなっている',
      need: 'もう一度、内側に火が戻る接点がほしい',
      block: '動いても満たされない感じが残る',
    },
  };

  return textures[primary] ?? null;
}

function buildEmotionProfile(userText: string): {
  primary: string;
  secondary: string[];
  balance: Record<string, number>;
} | null {
  const text = stripSpaces(normText(userText)).toLowerCase();
  if (!text) return null;

  const scores: Record<string, number> = {
    e1_pos: 0,
    e1_neg: 0,
    e2_pos: 0,
    e2_neg: 0,
    e3_pos: 0,
    e3_neg: 0,
    e4_pos: 0,
    e4_neg: 0,
    e5_pos: 0,
    e5_neg: 0,
  };

  if (/整理|整え|確認|検証|順番|一つずつ|1つずつ|安全に|慎重/.test(text)) scores.e1_pos += 2;
  if (/我慢|抑え|耐え|ちゃんとしないと|固ま|張りつめ|緩めない/.test(text)) scores.e1_neg += 2;

  if (/iros|能力|一段|アップ|改善|修正|実装|精度|writer|seed|flow|q_code|e_turn|emotion|発揮|新しい|進めたい|作りたい|直したい|動かしたい|突破/i.test(text)) scores.e2_pos += 2;
  if (/怒|ムカ|イラ|腹立|納得いか|許せ|おかしい|なんで|なぜ/.test(text)) scores.e2_neg += 2;

  if (/つなげたい|関係を整えたい|安定|大丈夫|確かめたい/.test(text)) scores.e3_pos += 2;
  if (/不安|心配|迷|どうしよう|大丈夫かな|曖昧|もや|モヤ/.test(text)) scores.e3_neg += 2;

  if (/守りたい|慎重に見たい|距離を置く|様子を見る/.test(text)) scores.e4_pos += 2;
  if (/怖|こわ|恐|無理|逃げ|避け|緊張|パニック/.test(text)) scores.e4_neg += 2;

  if (/情熱|燃える|やりたい|ワクワク|楽しい|好き/.test(text)) scores.e5_pos += 2;
  if (/虚無|空虚|空っぽ|意味ない|無意味|疲れた|しんどい|つらい|辛い|きつい/.test(text)) scores.e5_neg += 2;

  const entries = Object.entries(scores)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const top = entries.slice(0, 3);

  const balance: Record<string, number> = {};
  for (const [key, value] of top) {
    balance[key] = Math.round((value / total) * 100) / 100;
  }

  return {
    primary: top[0][0],
    secondary: top.slice(1).map(([key]) => key),
    balance,
  };
}

export type FlowMetaV1 = {
  delta: FlowDeltaV1 | null;
  returnStreak: number | null;
  sessionBreak: boolean | null;
  micro: boolean;
};

export type CoordMetaV1 = {
  stage: number | null;
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
  stage?: number | null;
  band?: BandV1 | null;
  polarity?: PolarityV1 | null;
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
export function normalizeETurnV1(raw: any): ETurnV1 | null {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const s0 = raw.trim();
    if (!s0) return null;

    const m1 = s0.match(/^e([1-5])$/i);
    if (m1) return (`e${m1[1]}` as ETurnV1);

    const m2 = s0.match(/^[QqEe]([1-5])$/);
    if (m2) return (`e${m2[1]}` as ETurnV1);

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

  const strongSignal =
    /(?:無理|怖|こわ|恐|パニック|詰ん|怒|ムカ|イラ|腹立|許せ|最悪|不安|心配|悩|迷|自信ない|虚無|空虚|意味ない|つらい|辛い|しんどい|きつい)/.test(t) ||
    /[!！]{2,}/.test(t);

  if (MICRO_WORDS.has(t.toLowerCase())) return true;

  if (/^[\p{Extended_Pictographic}\p{P}\p{S}]+$/u.test(t)) return true;

  if (len <= 3) return !strongSignal;

  if (len <= 10) {
    if (strongSignal) return false;
    if (nonWordRatio(t) >= 0.7) return true;
    return false;
  }

  if (nonWordRatio(t) >= 0.6) return true;

  return false;
}

// ---- v1 confidence ----

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
  if (vagueHits >= 3) pen += 0.07;

  if (lenTrim <= 25 && /^(?:すごい|やばい|最高|無理|きつい|助かる|ありがとう)[!！]*$/.test(t)) {
    pen += 0.08;
  }

  pen = clamp(pen, 0, 0.25);

  let c = info + clue - pen;

  if (micro) {
    c = Math.min(0.45, c);
    c = clamp(c, 0.05, 0.45);
  } else {
    c = clamp(c, 0.10, 0.95);
  }

  return c;
}

// ---- v1 energy size ----

export function calcMirrorEnergySizeV1(userText: string): number {
  const t = stripSpaces(normText(userText));
  const len = Array.from(t).length;
  const x = len / 180;
  const size = 1 - Math.exp(-x);
  return clamp(size, 0, 1);
}

// ---- v1 e_turn detection ----

export function detectETurnV1(userText: string, micro: boolean): ETurnV1 | null {
  const t0 = normText(userText);
  const t = stripSpaces(t0).toLowerCase();

  if (!t) return null;

  const hasExcl = /[!！]/.test(t);
  const hasQuest = /[?？]/.test(t);

  if (/空っぽ|空虚|虚無|虚しい|むなしい|意味ない|無意味|どうでもいい|燃えない|やる気ない|飽きた|疲れた|しんどい|つらい|辛い|きつい/.test(t)) {
    return 'e5';
  }

  if (/怖い|こわい|怖さ|こわさ|怖|こわ|恐れ|恐い|無理|無理だ|無理かも|萎縮|逃げたい|避けたい|震え|緊張|パニック|詰ん/.test(t)) {
    return 'e4';
  }

  if (/なんで|なぜ|納得いか|許せ|ムカ|イラ|腹立|ふざけ|舐め|キレ|最悪|違う気がする|おかしい|それは違う|やってられない/.test(t)) {
    return 'e2';
  }

  if (/張りつめ|張り詰め|張ってる|こわば|力が入|力ん|固まってる|固い|緩めない|ちゃんとして|ちゃんとしないと|我慢|抑え|耐え|整えたい|整理したい|確認したい|順番に|一つずつ|1つずつ/.test(t)) {
    return 'e1';
  }

  const p1 = [
    /我慢/, /抑え/, /抑圧/, /耐え/, /義務/, /べき/, /ちゃんと/, /正しく/,
    /ルール/, /秩序/, /仕様/, /規約/, /制約/, /守ら/, /固定/, /禁止/, /許可/,
    /整理/, /整え/, /確認したい/, /確認して/, /確かめ/, /検証/, /実在確認/,
    /存在確認/, /一つずつ/, /1つずつ/, /順番/, /安全に/, /慎重/, /根拠を見たい/,
    /張りつめ/, /張り詰め/, /こわば/, /力が入/, /固ま/, /緩めない/,
  ];

  const p2 = [
    /怒/, /ムカ/, /イラ/, /腹立/, /許せ/, /対立/, /反発/, /喧嘩/, /キレ/,
    /最悪/, /ふざけ/, /舐め/, /ぶち/, /ダメダメ/, /何やってきた/,
    /できてないじゃん/, /なんで/, /なぜ/, /納得いか/, /違う気がする/,
    /それは違う/, /おかしい/, /やる/, /進めたい/, /進もう/, /進める/,
    /試したい/, /試す/, /直したい/, /直す/, /修正/, /実装/, /作りたい/,
    /作る/, /見たい/, /見てほしい/, /貼る/, /出したい/, /突破/, /動かしたい/,
    /回したい/, /確認するぞ/,
  ];

  const p3 = [
    /不安/, /心配/, /迷/, /どうしよう/, /どうしたら/, /大丈夫かな/,
    /このままで大丈夫/, /恐らく/, /たぶん/, /微妙/, /悩/, /もや/, /モヤ/,
    /自信ない/, /確証/, /本当に/, /これでok/, /これで大丈夫/,
    /なんだっけ/, /思い出せ/, /あれって/, /どうだったっけ/,
  ];

  const p4 = [
    /怖/, /こわ/, /恐/, /無理/, /無理だ/, /無理かも/, /萎縮/, /逃げ/,
    /避け/, /震え/, /緊張/, /焦り/, /パニック/, /詰ん/, /無理ゲー/,
  ];

  const p5 = [
    /虚無/, /空虚/, /空っぽ/, /虚しい/, /むなしい/, /意味ない/, /無意味/,
    /どうでも/, /燃え/, /やる気ない/, /飽き/, /しんどい/, /つらい/, /辛い/,
    /落ち込/, /疲れた/, /きつい/,
  ];

  const softUncertain = [
    /…+/, /\.{2,}/, /うーん/, /んー/, /えー/, /えっと/, /なんか/,
    /微妙/, /よくわからない/, /たぶん/,
  ];

  let s1 = countHits(t, p1);
  let s2 = countHits(t, p2);
  let s3 = countHits(t, p3);
  let s4 = countHits(t, p4);
  let s5 = countHits(t, p5);

  s2 += /[!！]{2,}/.test(t) ? 2 : hasExcl ? 1 : 0;

  const emotionalBase = s1 + s2 + s4 + s5;
  if (emotionalBase === 0) {
    s3 += /[?？]{2,}/.test(t) ? 2 : hasQuest ? 1 : 0;
  }

  const soft = countHits(t, softUncertain);
  if (soft >= 1 && emotionalBase === 0) s3 += 1;

  if (/確認|根拠|検証|存在確認|実在確認/.test(t)) s1 += 1;
  if (/進めたい|直したい|修正したい|見たい|試したい|作りたい|やりたい/.test(t)) s2 += 1;
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

  if (!bestScore || bestScore <= 0) {
    if (/疲れた|しんどい|つらい|辛い|きつい|空っぽ|虚無/.test(t)) return 'e5';
    if (/怖い|こわい|怖|こわ|恐|無理|震え|緊張/.test(t)) return 'e4';
    if (/なんで|なぜ|違う気がする|それは違う|ムカ|イラ|腹立/.test(t)) return 'e2';
    if (/張りつめ|張り詰め|こわば|力が入|整理|整え|確認|検証|順番|一つずつ|1つずつ/.test(t)) return 'e1';
    if (/どうしよう|どうしたら|大丈夫かな|不安|心配/.test(t)) return 'e3';
    if (hasExcl) return 'e2';
    if (hasQuest) return 'e3';
    return 'e3';
  }

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

// ---- v1 intensity ----

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

  const strongWords = [
    /無理/, /怖|こわ|恐/, /パニック/, /詰ん/,
    /最悪/, /許せ/, /キレ/, /ふざけ/,
    /不安/, /心配/, /悩|迷/, /確証|根拠/,
    /虚無|空虚|無意味|意味ない/,
    /つらい|辛い|しんどい|きつい/,
  ];

  const strongHits = countHits(t, strongWords);

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

  if (excl2) x += 0.20;
  else if (hasExcl) x += 0.10;

  if (quest2) x += 0.10;
  else if (hasQuest) x += 0.05;

  const len = Array.from(t).length;
  x += clamp(len / 200, 0, 0.10);

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

  const confidence = calcMirrorConfidenceV1(userText, micro);
  const size = calcMirrorEnergySizeV1(userText);

  const stage = input.stage ?? null;
  const band = input.band ?? null;

  const emotionProfile = buildEmotionProfile(userText);

  const eTurnFromEmotionPrimary: ETurnV1 | null = (() => {
    const primary = String(emotionProfile?.primary ?? '').trim().toLowerCase();
    const matched = primary.match(/^(e[1-5])_(pos|neg)$/u);
    return matched ? (matched[1] as ETurnV1) : null;
  })();

  const polarityFromEmotionPrimary: PolarityV1 | null = (() => {
    const primary = String(emotionProfile?.primary ?? '').trim().toLowerCase();
    if (/_pos$/u.test(primary)) return 'yang';
    if (/_neg$/u.test(primary)) return 'yin';
    return null;
  })();

  const e_turn = eTurnFromEmotionPrimary ?? detectETurnV1(userText, micro);
  const intensity = calcMirrorIntensityV1({ userText, micro, e_turn });
  const normPol = (raw: any): PolarityV1 | null => {
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
      ? polarityRaw.trim() || null
      : typeof (polarityRaw as any)?.metaBand === 'string' && (polarityRaw as any).metaBand.trim()
        ? (polarityRaw as any).metaBand.trim()
        : null;

        const polarity_in_raw = polarityFromEmotionPrimary ?? normPol(polarityRaw);

        // ✅ 自己理解・未来展望の問いは、明示不安がない限り neg に落とさない
        // 例: 「わたしの今の心理状態と、この先に見据える未来を教えてください」
        // yin は「内向き/受け取り中」であり、必ずしも neg ではない。
        const userTextForPolarity = stripSpaces(normText(userText));
        const looksSelfUnderstandingOrFuture =
          /(心理状態|今の状態|いまの状態|自分の状態|現在地|この先|未来|見据える|見通し|方向性|展望|流れを見|流れを教えて|教えてください|見てください)/.test(
            userTextForPolarity,
          );

        const hasExplicitNegativeEmotion =
          /(不安|心配|怖い|こわい|恐い|苦しい|つらい|辛い|しんどい|無理|どうしよう|迷って|迷う|モヤ|もや|大丈夫かな|嫌われ|終わり|消えたい|空虚|虚無|怒り|イライラ)/.test(
            userTextForPolarity,
          );

        const polarity_in =
          polarity_in_raw === 'yin' &&
          looksSelfUnderstandingOrFuture &&
          !hasExplicitNegativeEmotion
            ? 'yang'
            : polarity_in_raw;

        const polarity_out =
          polarityFromEmotionPrimary ||
          normPol((polarityRaw as any)?.out) ||
          normPol((polarityRaw as any)?.in) ||
          polarity_in;

  const polarityForKey = polarity_in;

  const turnPolarity: TurnPolarityV1 | null = (() => {
    const primary = String(emotionProfile?.primary ?? '').trim().toLowerCase();

    if (/_pos$/u.test(primary)) return 'pos';
    if (/_neg$/u.test(primary)) return 'neg';

    const textForTurnPolarity = stripSpaces(normText(userText)).toLowerCase();

    if (
      /(不安|心配|怖い|こわい|恐い|苦しい|つらい|辛い|しんどい|無理|どうしよう|迷って|迷う|モヤ|もや|大丈夫かな|嫌われ|終わり|消えたい|空虚|虚無|怒り|イライラ|停滞|失敗|拒絶|断絶|崩れ|閉じる|閉じて)/.test(
        textForTurnPolarity,
      )
    ) {
      return 'neg';
    }

    if (
      /(意図|本来の意図|目的|未来|この先|方向性|展望|構造をつく|構造を作|構造化|創造|活動|ムーブメント|ブームメント|世界|争いの無い世界|争いのない世界|希望|歓喜|成長|進化|広が|広げ|実現|実装|形にする|進めたい|作りたい|やりたい|突破|熱量|情熱|ワクワク|楽しい|好き|喜び|太陽|sun)/i.test(
        textForTurnPolarity,
      )
    ) {
      return 'pos';
    }

    return null;
  })();

  const e_turn_v2 = mapToETurnV2(e_turn, turnPolarity);
  const emotionTexture = buildEmotionTexture({ userText, e: e_turn_v2 });

  const meaningKey = makeMirrorMeaningKeyV1({
    stage,
    band,
    e_turn,
    polarity: polarityForKey,
    confidence,
  });

  const colorKey = e_turn
    ? polarityForKey
      ? `${e_turn}_${polarityForKey}`
      : `${e_turn}`
    : null;

  const flowDelta = input.flow?.delta ?? null;
  const returnStreak =
    typeof input.flow?.returnStreak === 'number'
      ? input.flow.returnStreak
      : input.flow?.returnStreak ?? null;

  const sessionBreak =
    typeof input.flow?.sessionBreak === 'boolean'
      ? input.flow.sessionBreak
      : input.flow?.sessionBreak ?? null;

  return {
    mirror: {
      e_turn,
      e_turn_v2,
      emotionTexture,
      emotionProfile,
      polarity: {
        in: polarity_in,
        out: polarity_out,
        metaBand: polarity_metaBand,
      },
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
