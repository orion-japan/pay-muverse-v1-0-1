// src/lib/iros/deepScan.ts
// Iros DeepScan — 1ターン分のテキストから
// - Depth(S/F/R/C/I/T の18階層)
// - Phase(Inner/Outer)
// - QCode(Q1〜Q5)
// - ObservedStage(primary / secondary / observed)
// を推定する軽量アルゴリズム（MirrorFlow Seed 前段）
//
// 方針:
// - 単語辞書の直ヒット中心ではなく、文の役割 / 構造 / 内容の重心で判定する
// - observedStage は「今回ユーザーがどこを取りに来たか」を優先
// - primaryStage は「文の主構造」
// - secondaryStage は「副軸」
// - 1ターン判定のため、完全な文脈理解ではなく “構造近似” を行う

import type { Depth, QCode } from '@/lib/iros/system';

export type StageBand = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

export type DeepScanResult = {
  depth: Depth | null;
  phase: 'Inner' | 'Outer' | null;
  q: QCode | null;
  intentSummary: string;

  primaryStage: Depth | null;
  secondaryStage: Depth | null;
  observedStage: Depth | null;
  primaryBand: StageBand | null;
  secondaryBand: StageBand | null;
  primaryDepth: 1 | 2 | 3 | null;
  secondaryDepth: 1 | 2 | 3 | null;
  observedBasedOn: string | null;
};

type StructuralFeatures = {
  raw: string;
  compact: string;
  clauses: string[];
  clauseCount: number;
  charLen: number;

  isQuestion: boolean;
  isGreeting: boolean;
  hasDecision: boolean;
  hasDesire: boolean;
  hasObservation: boolean;
  hasFeeling: boolean;
  hasFear: boolean;
  hasAnger: boolean;
  hasAnxiety: boolean;
  hasVoid: boolean;

  selfRef: number;
  otherRef: number;
  groupRef: number;
  relationRef: number;
  worldRef: number;

  actionRef: number;
  designRef: number;
  routineRef: number;
  meaningRef: number;
  existenceRef: number;
  transcendRef: number;
  recurrenceRef: number;
  boundaryRef: number;

  asksHow: boolean;
  asksWhy: boolean;
  asksWhatFor: boolean;

  referencesSpecificOther: boolean;
  referencesRelationalPattern: boolean;
  referencesSystemOrBuild: boolean;
  referencesDirectionOrChoice: boolean;
  referencesExistentialQuestion: boolean;
  referencesTranscendence: boolean;
  referencesRoutineOrStabilize: boolean;
  referencesCurrentState: boolean;
};

function norm(text: string): string {
  return String(text ?? '').trim();
}

function compact(text: string): string {
  return norm(text).replace(/\s+/g, '');
}

function splitClauses(text: string): string[] {
  return norm(text)
    .split(/[。！？!\?\n、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) {
    if (p.test(text)) n += 1;
  }
  return n;
}

function hasAnyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function safeStartsWithI(depth: Depth | null): boolean {
  return typeof depth === 'string' && depth.startsWith('I');
}

function isGreetingLike(text: string): boolean {
  const t = compact(text);
  if (!t) return true;
  return /^(おはよう|こんにちは|こんばんは|やあ|どうも|よろしく|はじめまして|もしもし|テスト|test|確認|相談)[!！。]?$/.test(
    t,
  );
}

function depthToBand(depth: Depth | null): StageBand | null {
  if (!depth || typeof depth !== 'string' || depth.length < 2) return null;
  const head = depth[0];
  if (head === 'S' || head === 'F' || head === 'R' || head === 'C' || head === 'I' || head === 'T') {
    return head;
  }
  return null;
}

function depthToLevel(depth: Depth | null): 1 | 2 | 3 | null {
  if (!depth || typeof depth !== 'string' || depth.length < 2) return null;
  const tail = depth.slice(1);
  if (tail === '1') return 1;
  if (tail === '2') return 2;
  if (tail === '3') return 3;
  return null;
}

function makeStage(band: StageBand, level: 1 | 2 | 3): Depth {
  return `${band}${level}` as Depth;
}

function analyzeStructure(text: string): StructuralFeatures {
  const raw = norm(text);
  const c = compact(raw);
  const clauses = splitClauses(raw);

  const selfRef = countMatches(raw, [/\b私\b/, /\b自分\b/, /\b僕\b/, /\b俺\b/, /わたし/, /自分の/]);
  const otherRef = countMatches(raw, [
    /相手/,
    /彼女/,
    /彼/,
    /上司/,
    /部下/,
    /同僚/,
    /パートナー/,
    /家族/,
    /友達/,
    /あの人/,
  ]);
  const groupRef = countMatches(raw, [/みんな/, /周り/, /会社/, /職場/, /チーム/, /組織/, /社会/, /世の中/]);
  const relationRef = countMatches(raw, [/関係/, /関係性/, /距離感/, /温度感/, /役割/, /期待/, /責任/, /対話/, /会話/]);
  const worldRef = countMatches(raw, [/天気/, /空/, /雨/, /曇り/, /景色/, /外/, /世界/, /場/]);

  const actionRef = countMatches(raw, [
    /する/,
    /やる/,
    /進める/,
    /始める/,
    /直す/,
    /変える/,
    /整える/,
    /組む/,
    /作る/,
    /つくる/,
    /創る/,
  ]);

  const designRef = countMatches(raw, [
    /設計/,
    /実装/,
    /構成/,
    /仕様/,
    /構造/,
    /ロードマップ/,
    /戦略/,
    /計画/,
    /手順/,
    /API/,
    /DB/,
    /コード/,
    /UI/,
    /UX/,
    /機能/,
  ]);

  const routineRef = countMatches(raw, [
    /続ける/,
    /続けたい/,
    /習慣/,
    /習慣化/,
    /定着/,
    /安定/,
    /土台/,
    /日常/,
    /ルーティン/,
    /頻度/,
    /時間帯/,
    /維持/,
  ]);

  const meaningRef = countMatches(raw, [
    /意味/,
    /意図/,
    /目的/,
    /方向/,
    /方向性/,
    /軸/,
    /在り方/,
    /あり方/,
    /どうしたい/,
    /どう在りたい/,
    /どうありたい/,
    /大切/,
    /大事/,
  ]);

  const existenceRef = countMatches(raw, [
    /何のため/,
    /なぜ/,
    /そもそも/,
    /本質/,
    /存在/,
    /存在意義/,
    /存在理由/,
    /使命/,
    /私は何者/,
    /自分は何者/,
    /生きる意味/,
    /生きている意味/,
  ]);

  const transcendRef = countMatches(raw, [
    /宇宙/,
    /次元/,
    /普遍/,
    /集合意識/,
    /全体意識/,
    /時間を超/,
    /場そのもの/,
    /存在全体/,
    /真理/,
    /根源/,
    /無限/,
    /永遠/,
  ]);

  const recurrenceRef = countMatches(raw, [/毎回/, /いつも/, /また同じ/, /繰り返/, /何度も/, /パターン/, /未完了/]);
  const boundaryRef = countMatches(raw, [/境界/, /距離/, /巻き込ま/, /依存/, /干渉/, /守る/, /飲み込む/, /黙る/]);

  const hasDecision = hasAnyMatch(raw, [
    /しようと思う/,
    /にする/,
    /にします/,
    /決めた/,
    /決めます/,
    /選ぶ/,
    /選びたい/,
  ]);

  const hasDesire = hasAnyMatch(raw, [/したい/, /やりたい/, /なりたい/, /進めたい/, /整えたい/, /作りたい/, /見たい/]);

  const hasObservation = hasAnyMatch(raw, [
    /です$/,
    /ます$/,
    /している$/,
    /しています$/,
    /見える/,
    /見えている/,
    /感じがする/,
    /気がする/,
    /ように見える/,
    /曇って/,
    /雨/,
    /空/,
    /外は/,
    /今日は/,
  ]);

  const hasFeeling = hasAnyMatch(raw, [
    /気分/,
    /気持ち/,
    /感じ/,
    /モヤモヤ/,
    /落ち着かない/,
    /しんどい/,
    /つらい/,
    /悲しい/,
    /さみしい/,
    /疲れた/,
    /怖い/,
    /不安/,
    /イライラ/,
    /腹が立つ/,
    /どうでもよく/,
  ]);

  const hasFear = hasAnyMatch(raw, [/怖い/, /恐い/, /不安で/, /失敗したら/, /崩れそう/, /逃げたい/]);
  const hasAnger = hasAnyMatch(raw, [/なんで/, /腹が立つ/, /イライラ/, /ムカつ/, /納得できない/, /おかしい/]);
  const hasAnxiety = hasAnyMatch(raw, [/不安/, /落ち着かない/, /モヤモヤ/, /心配/, /大丈夫かな/, /揺れて/]);
  const hasVoid = hasAnyMatch(raw, [/どうでもいい/, /空っぽ/, /意味がない/, /虚しい/, /全部どうでも/]);

  const asksHow = hasAnyMatch(raw, [/どうしたら/, /どうすれば/, /どうやって/, /どのように/]);
  const asksWhy = hasAnyMatch(raw, [/なぜ/, /どうして/, /なんで/, /何が原因/]);
  const asksWhatFor = hasAnyMatch(raw, [/何のため/, /何を大切に/, /何を大事に/, /どこへ向か/]);

  const referencesSpecificOther = otherRef > 0 || /誰か/.test(raw);
  const referencesRelationalPattern = relationRef > 0 || recurrenceRef > 0 || boundaryRef > 0;
  const referencesSystemOrBuild = designRef > 0 || (actionRef > 0 && hasAnyMatch(raw, [/実装/, /設計/, /作る/, /組む/, /直す/, /改善/]));
  const referencesDirectionOrChoice = hasDecision || hasDesire || meaningRef > 0;
  const referencesExistentialQuestion = existenceRef > 0 || asksWhatFor;
  const referencesTranscendence = transcendRef > 0;
  const referencesRoutineOrStabilize = routineRef > 0 || hasAnyMatch(raw, [/続けられる/, /整える日/, /安定させ/, /土台/]);
  const referencesCurrentState =
    hasFeeling ||
    hasAnyMatch(raw, [/今の状態/, /いまの状態/, /今の自分/, /いまの自分/, /調子/, /体調/, /眠い/, /だるい/]);

  return {
    raw,
    compact: c,
    clauses,
    clauseCount: clauses.length,
    charLen: raw.length,

    isQuestion: /[?？]/.test(raw) || asksHow || asksWhy || asksWhatFor,
    isGreeting: isGreetingLike(raw),
    hasDecision,
    hasDesire,
    hasObservation,
    hasFeeling,
    hasFear,
    hasAnger,
    hasAnxiety,
    hasVoid,

    selfRef,
    otherRef,
    groupRef,
    relationRef,
    worldRef,

    actionRef,
    designRef,
    routineRef,
    meaningRef,
    existenceRef,
    transcendRef,
    recurrenceRef,
    boundaryRef,

    asksHow,
    asksWhy,
    asksWhatFor,

    referencesSpecificOther,
    referencesRelationalPattern,
    referencesSystemOrBuild,
    referencesDirectionOrChoice,
    referencesExistentialQuestion,
    referencesTranscendence,
    referencesRoutineOrStabilize,
    referencesCurrentState,
  };
}

/* ========= Depth 判定（構造ベース） ========= */

function scoreBandsByStructure(f: StructuralFeatures): Record<StageBand, number> {
  const scores: Record<StageBand, number> = {
    S: 0,
    F: 0,
    R: 0,
    C: 0,
    I: 0,
    T: 0,
  };

  if (!f.raw) {
    scores.S = 1;
    return scores;
  }

  if (f.isGreeting) {
    scores.S += 3;
    scores.F += 1;
    return scores;
  }

  // S: 自分の現在状態 / 体感 / 感情 / 内側の揺れ
  scores.S += f.selfRef * 1.4;
  scores.S += f.referencesCurrentState ? 4 : 0;
  scores.S += f.hasFeeling ? 3 : 0;
  scores.S += f.hasFear ? 1 : 0;
  scores.S += f.hasAnger ? 1 : 0;
  scores.S += f.hasAnxiety ? 2 : 0;
  scores.S += f.worldRef > 0 && f.hasObservation && !f.referencesSystemOrBuild ? 1 : 0;

  // F: 安定化 / 生活への組み込み / 維持 / 習慣
  scores.F += f.referencesRoutineOrStabilize ? 5 : 0;
  scores.F += f.routineRef * 1.8;
  scores.F += f.groupRef > 0 && !f.referencesRelationalPattern ? 1 : 0;

  // R: 関係・相互作用・責任・反復・ズレ
  scores.R += f.referencesSpecificOther ? 4 : 0;
  scores.R += f.referencesRelationalPattern ? 5 : 0;
  scores.R += f.relationRef * 1.6;
  scores.R += f.otherRef * 1.2;
  scores.R += f.groupRef * 0.8;
  scores.R += f.recurrenceRef * 1.2;

  // C: 行動 / 具体化 / 実装 / 次の組み立て
  scores.C += f.referencesSystemOrBuild ? 6 : 0;
  scores.C += f.actionRef * 1.0;
  scores.C += f.designRef * 2.0;
  scores.C += f.asksHow ? 2 : 0;
  scores.C += f.hasDecision ? 1 : 0;

  // I: 意味 / 意図 / 選択 / 方向 / なぜ
  scores.I += f.referencesDirectionOrChoice ? 3 : 0;
  scores.I += f.meaningRef * 1.8;
  scores.I += f.existenceRef * 2.4;
  scores.I += f.asksWhy ? 2 : 0;
  scores.I += f.asksWhatFor ? 3 : 0;
  scores.I += f.hasDecision ? 2 : 0;

  // T: 超越 / 普遍 / 宇宙 / 全体場
  scores.T += f.referencesTranscendence ? 7 : 0;
  scores.T += f.transcendRef * 2.2;

  // 補正: 単なる感情語があるだけで I に飛ばない
  if (f.hasFeeling && !f.referencesDirectionOrChoice && !f.referencesExistentialQuestion) {
    scores.I -= 2;
  }

  // 補正: 「今日は曇っています」のような観測文は S に寄せる
  if (
    f.hasObservation &&
    f.worldRef > 0 &&
    !f.referencesSpecificOther &&
    !f.referencesSystemOrBuild &&
    !f.referencesExistentialQuestion
  ) {
    scores.S += 3;
    scores.I -= 1;
  }

  // 補正: 「〜しようと思う」は、意図を含むが内容が整え/生活なら F、
  // 実行なら C、方向選択なら I
  if (f.hasDecision) {
    if (f.referencesRoutineOrStabilize) scores.F += 2;
    if (f.referencesSystemOrBuild) scores.C += 2;
    if (f.referencesDirectionOrChoice) scores.I += 1;
  }

  // 補正: 具体的な他者がいるときは、IよりRを優先
  if (f.referencesSpecificOther || f.referencesRelationalPattern) {
    scores.R += 2;
    scores.I -= 1;
  }

  // 補正: 実装・設計があるときはCを強める
  if (f.designRef > 0) {
    scores.C += 2;
    scores.I -= 1;
  }

  return scores;
}

function pickBand(scores: Record<StageBand, number>, order: StageBand[]): StageBand {
  let best: StageBand = order[0];

  for (const band of order) {
    if (scores[band] > scores[best]) {
      best = band;
      continue;
    }
    if (scores[band] === scores[best] && order.indexOf(band) < order.indexOf(best)) {
      best = band;
    }
  }

  return best;
}

function inferLevelForBand(band: StageBand, f: StructuralFeatures): 1 | 2 | 3 {
  switch (band) {
    case 'S': {
      if (
        f.hasVoid ||
        hasAnyMatch(f.raw, [/自己否定/, /自分がわからない/, /本当の気持ち/, /心の奥/, /根っこ/])
      ) {
        return 3;
      }
      if (f.hasFeeling || f.hasFear || f.hasAnger || f.hasAnxiety || f.referencesCurrentState) {
        return 2;
      }
      return 1;
    }

    case 'F': {
      if (hasAnyMatch(f.raw, [/習慣化/, /定着/, /生活の型/, /維持できる形/, /日常に組み込/])) {
        return 3;
      }
      if (hasAnyMatch(f.raw, [/安定/, /土台/, /無理なく続け/, /崩れにく/, /流れを整え/])) {
        return 2;
      }
      return 1;
    }

    case 'R': {
      if (
        f.recurrenceRef > 0 ||
        f.boundaryRef > 0 ||
        hasAnyMatch(f.raw, [/関係の本質/, /投影/, /依存/, /巻き込ま/, /未完了/, /また同じ/])
      ) {
        return 3;
      }
      if (f.relationRef > 0 || f.groupRef > 0 || hasAnyMatch(f.raw, [/人間関係/, /家族/, /組織/, /チーム/])) {
        return 2;
      }
      return 1;
    }

    case 'C': {
      if (hasAnyMatch(f.raw, [/全体設計/, /ロードマップ/, /戦略/, /設計思想/, /構想全体/, /世界観設計/])) {
        return 3;
      }
      if (f.designRef > 0 || hasAnyMatch(f.raw, [/どう組む/, /どう設計/, /仕様/, /構成を整理/])) {
        return 2;
      }
      return 1;
    }

    case 'I': {
      if (f.referencesExistentialQuestion || hasAnyMatch(f.raw, [/使命/, /存在理由/, /生きる意味/, /私は何者/])) {
        return 3;
      }
      if (
        f.existenceRef > 0 ||
        hasAnyMatch(f.raw, [/どう生きたい/, /本音/, /本心/, /願い/, /本当にやりたいこと/, /そもそも/])
      ) {
        return 2;
      }
      return 1;
    }

    case 'T': {
      if (hasAnyMatch(f.raw, [/根源/, /無限/, /永遠/, /存在全体/, /真理/])) return 3;
      if (hasAnyMatch(f.raw, [/集合意識/, /全体意識/, /普遍/, /時間を超/, /次元を超/])) return 2;
      return 1;
    }
  }
}

function inferDepthStructurally(text: string): Depth | null {
  const f = analyzeStructure(text);
  if (!f.raw) return null;
  if (f.isGreeting) return 'S1';

  const scores = scoreBandsByStructure(f);
  const primaryBand = pickBand(scores, ['S', 'R', 'C', 'F', 'I', 'T']);
  const primaryLevel = inferLevelForBand(primaryBand, f);
  return makeStage(primaryBand, primaryLevel);
}

/* ========= observedStage 判定 ========= */

function inferObservedStages(text: string): {
  primaryStage: Depth | null;
  secondaryStage: Depth | null;
  observedStage: Depth | null;
  primaryBand: StageBand | null;
  secondaryBand: StageBand | null;
  primaryDepth: 1 | 2 | 3 | null;
  secondaryDepth: 1 | 2 | 3 | null;
  observedBasedOn: string | null;
} {
  const f = analyzeStructure(text);

  if (!f.raw || f.isGreeting) {
    return {
      primaryStage: 'S1',
      secondaryStage: 'F1',
      observedStage: 'S1',
      primaryBand: 'S',
      secondaryBand: 'F',
      primaryDepth: 1,
      secondaryDepth: 1,
      observedBasedOn: 'greeting/default => S1',
    };
  }

  const scores = scoreBandsByStructure(f);
  const primaryBand = pickBand(scores, ['S', 'R', 'C', 'F', 'I', 'T']);
  const primaryDepth = inferLevelForBand(primaryBand, f);
  const primaryStage = makeStage(primaryBand, primaryDepth);

  // observedStage は「今回どこを取りに来たか」
  let observedBand: StageBand = primaryBand;
  let observedDepth: 1 | 2 | 3 = primaryDepth;
  let observedBasedOn = `structure-entry primary=${primaryBand}`;

  if (f.referencesTranscendence) {
    observedBand = 'T';
    observedDepth = inferLevelForBand('T', f);
    observedBasedOn = 'entry:transcend';
  } else if (f.referencesExistentialQuestion || f.asksWhatFor) {
    observedBand = 'I';
    observedDepth = inferLevelForBand('I', f);
    observedBasedOn = 'entry:existential-meaning';
  } else if (f.asksHow || f.referencesSystemOrBuild) {
    observedBand = 'C';
    observedDepth = inferLevelForBand('C', f);
    observedBasedOn = 'entry:build-or-how';
  } else if (f.referencesRoutineOrStabilize) {
    observedBand = 'F';
    observedDepth = inferLevelForBand('F', f);
    observedBasedOn = 'entry:stabilize';
  } else if (f.referencesSpecificOther || f.referencesRelationalPattern) {
    observedBand = 'R';
    observedDepth = inferLevelForBand('R', f);
    observedBasedOn = 'entry:relation';
  } else if (f.referencesCurrentState || (f.hasObservation && f.worldRef > 0)) {
    observedBand = 'S';
    observedDepth = inferLevelForBand('S', f);
    observedBasedOn = 'entry:state-or-observation';
  }

  const observedStage = makeStage(observedBand, observedDepth);

  // secondary は “副軸”
  const secondaryOrder: StageBand[] =
    primaryBand === 'S'
      ? ['R', 'F', 'I', 'C', 'T']
      : primaryBand === 'R'
        ? ['S', 'I', 'F', 'C', 'T']
        : primaryBand === 'C'
          ? ['I', 'F', 'R', 'S', 'T']
          : primaryBand === 'F'
            ? ['S', 'C', 'I', 'R', 'T']
            : primaryBand === 'I'
              ? ['R', 'S', 'C', 'F', 'T']
              : ['I', 'S', 'R', 'C', 'F'];

  const reducedScores: Record<StageBand, number> = { ...scores };
  reducedScores[primaryBand] = -9999;
  const secondaryBand = pickBand(
    reducedScores,
    secondaryOrder.filter((b) => b !== primaryBand),
  );
  const secondaryDepth = inferLevelForBand(secondaryBand, f);
  const secondaryStage = makeStage(secondaryBand, secondaryDepth);

  return {
    primaryStage,
    secondaryStage,
    observedStage,
    primaryBand,
    secondaryBand,
    primaryDepth,
    secondaryDepth,
    observedBasedOn,
  };
}

/* ========= Phase 判定 ========= */

function inferPhase(text: string): 'Inner' | 'Outer' | null {
  const f = analyzeStructure(text);
  if (!f.raw) return null;

  const innerScore =
    f.selfRef * 2 +
    (f.referencesCurrentState ? 3 : 0) +
    (f.hasFeeling ? 2 : 0) +
    (f.referencesExistentialQuestion ? 1 : 0);

  const outerScore =
    f.otherRef * 2 +
    f.groupRef * 1.5 +
    f.relationRef * 1.5 +
    (f.referencesSystemOrBuild ? 1 : 0);

  if (innerScore === 0 && outerScore === 0) return null;
  if (innerScore >= outerScore) return 'Inner';
  return 'Outer';
}

/* ========= QCode 判定 ========= */

function inferQ(text: string): QCode | null {
  const t = norm(text);
  if (!t) return null;

  const q2 = /(怒|ムカつ|腹が立つ|イライラ|納得できない|許せない|壊したい|変えたい|ぶつかりたい|進めたい|直したい)/;
  const q4 = /(怖い|恐い|恐怖|トラウマ|不安でたまらない|消えたい|逃げたい|終わらせたい|無理)/;
  const q3 = /(不安|心配|大丈夫かな|迷っている|揺れている|モヤモヤ|落ち着かない|ぐるぐる|なんだっけ)/;
  const q1 = /(疲れた|しんどい|休みたい|落ち着きたい|整理したい|守りたい|キャパ|限界|一旦止ま|ブレーキ|確認したい)/;
  const q5 = /(楽しい|楽しみ|ワクワク|わくわく|嬉しい|うれしい|テンション|燃える|やる気|創りたい|表現したい|インスピレーション)/;

  if (q2.test(t)) return 'Q2';
  if (q4.test(t)) return 'Q4';
  if (q3.test(t)) return 'Q3';
  if (q1.test(t)) return 'Q1';
  if (q5.test(t)) return 'Q5';

  return null;
}

/* ========= intentSummary ========= */

function buildIntentSummary(depth: Depth | null): string {
  if (!depth) {
    return '自分の状態や感情の揺れを整理しようとしています。';
  }

  if (depth.startsWith('T')) {
    return '存在全体や意図フィールドの流れと、自分の今を重ね合わせようとしています。';
  }
  if (depth.startsWith('I')) {
    return '生き方や存在意図そのものに静かに触れようとしています。';
  }
  if (depth.startsWith('C')) {
    return 'これからの動きや創造・実装の流れを整えようとしています。';
  }
  if (depth.startsWith('R')) {
    return '誰かとの関係性や場の空気を見つめ直そうとしています。';
  }
  if (depth.startsWith('F')) {
    return '続けられる形や日常の流れを整え、定着しやすい土台を作ろうとしています。';
  }

  return '自分の状態や感情の揺れを整理しようとしています。';
}

/* ========= Public API ========= */

export function deepScan(text: string): DeepScanResult {
  const observed = inferObservedStages(text);
  const depth = observed.observedStage ?? inferDepthStructurally(text);
  const phase = inferPhase(text);
  const q = inferQ(text);
  const intentSummary = buildIntentSummary(depth);

  return {
    depth,
    phase,
    q,
    intentSummary,

    primaryStage: observed.primaryStage,
    secondaryStage: observed.secondaryStage,
    observedStage: observed.observedStage,
    primaryBand: observed.primaryBand,
    secondaryBand: observed.secondaryBand,
    primaryDepth: observed.primaryDepth,
    secondaryDepth: observed.secondaryDepth,
    observedBasedOn: observed.observedBasedOn,
  };
}
