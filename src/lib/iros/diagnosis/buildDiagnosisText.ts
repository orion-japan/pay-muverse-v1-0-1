// src/lib/iros/diagnosis/buildDiagnosisText.ts
// iros — ir diagnosis OS (deterministic text builder)
//
// 方針：
// - ir診断は別ルート前提
// - seed / rephrase / renderGateway 用の素材を作らない
// - ここで「今1枚 → 未来1枚 → 差分の意味 → 返答文」を確定させる
// - meta は “前回値の引き継ぎ用” に留め、診断本文の主決定は flow 2枚引きで行う
// - 2枚のフローは入力非依存の絶対ランダム
// - 差分意味は flow180 の buildFlowDelta を正本として使う
//
// 新しい出力方針：
// - 観測対象：入力そのまま
// - 観測結果：2枚のフローを象徴として比喩化
// - 意識状態：差分意味を人間語でそのまま出す
// - まとめ：いまの状態 + この先の方向を短く返す
//
// テンプレ系統：
// - 深度帯 = 世界観
// - 感情 / polarity = 補正
// - deltaType = 文の向きの補助

import type { DiagnosisMetaLike, DiagnosisSlotLike } from './diagnosisTypes';
import {
  buildFlowDelta,
  listFlow180,
  parseFlowStateId,
  type FlowStateEntry,
  type FlowStateId,
} from '../flow/flow180';

const norm = (v: unknown): string => {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
};

type StageBand = 'S' | 'R' | 'C' | 'I' | 'T';
type Polarity = 'pos' | 'neg';
type EmotionBand = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

type ObservationFamily =
  | 'foundation'
  | 'water'
  | 'wind'
  | 'growth'
  | 'light'
  | 'threshold';

function pickTargetLabel(raw: string): string {
  const t = norm(raw).toLowerCase();

  if (!t || t === 'random' || t === 'ランダム') return '自分';
  if (t === 'self' || t === '自分' || t === 'あなた自身') return '自分';
  return norm(raw) || '自分';
}

function randomIndex(max: number): number {
  if (max <= 0) return 0;
  return Math.floor(Math.random() * max);
}

function pickOne<T>(arr: T[]): T {
  return arr[randomIndex(arr.length)];
}

function pickTwoRandomFlows(): { nowFlow: FlowStateEntry; futureFlow: FlowStateEntry } {
  const catalog = listFlow180();
  if (!catalog.length) {
    throw new Error('FLOW180 catalog is empty');
  }

  const idxNow = randomIndex(catalog.length);
  let idxFuture = randomIndex(catalog.length);

  if (catalog.length > 1 && idxFuture === idxNow) {
    idxFuture = (idxFuture + 1) % catalog.length;
  }

  return {
    nowFlow: catalog[idxNow],
    futureFlow: catalog[idxFuture],
  };
}

function buildMeaningText(nowId: FlowStateId, futureId: FlowStateId): string {
  const delta = buildFlowDelta(nowId, futureId);
  return delta.sentence;
}

function stripTrailingPeriod(s: string): string {
  return norm(s).replace(/[。．]+$/g, '').trim();
}

function getStageBand(flowId: FlowStateId): StageBand {
  const parsed = parseFlowStateId(flowId) as any;
  const stage = String(parsed?.stage ?? parsed?.depthStage ?? '').trim().toUpperCase();

  if (stage.startsWith('S')) return 'S';
  if (stage.startsWith('R')) return 'R';
  if (stage.startsWith('C')) return 'C';
  if (stage.startsWith('I')) return 'I';
  return 'T';
}

function getEmotionBand(flowId: FlowStateId): EmotionBand {
  const parsed = parseFlowStateId(flowId) as any;
  const emotion = String(parsed?.emotion ?? parsed?.eTurn ?? parsed?.e_turn ?? '').trim().toLowerCase();

  if (emotion === 'e1') return 'e1';
  if (emotion === 'e2') return 'e2';
  if (emotion === 'e3') return 'e3';
  if (emotion === 'e4') return 'e4';
  return 'e5';
}

function getPolarity(flowId: FlowStateId): Polarity {
  const parsed = parseFlowStateId(flowId) as any;
  return String(parsed?.polarity ?? '').trim().toLowerCase() === 'neg' ? 'neg' : 'pos';
}

function chooseObservationFamily(input: {
  nowId: FlowStateId;
  futureId: FlowStateId;
  deltaType?: string | null;
}): ObservationFamily {
  const nowStage = getStageBand(input.nowId);
  const futureStage = getStageBand(input.futureId);
  const nowEmotion = getEmotionBand(input.nowId);
  const futureEmotion = getEmotionBand(input.futureId);
  const nowPolarity = getPolarity(input.nowId);
  const futurePolarity = getPolarity(input.futureId);

  const stage = futureStage ?? nowStage;
  const emotion = futureEmotion ?? nowEmotion;
  const polarity = futurePolarity ?? nowPolarity;

  if (stage === 'S') return 'foundation';
  if (stage === 'R') return polarity === 'neg' ? 'water' : 'wind';
  if (stage === 'C') return 'growth';
  if (stage === 'I') return 'light';
  if (stage === 'T') return 'threshold';

  if (emotion === 'e3' || emotion === 'e4') return 'water';
  if (emotion === 'e2') return 'wind';
  if (emotion === 'e5') return polarity === 'neg' ? 'threshold' : 'growth';

  return 'wind';
}

function buildObservationResult(
  nowId: FlowStateId,
  futureId: FlowStateId,
  nowShort: string,
  futureShort: string,
  deltaType?: string | null,
): string {
  const a = stripTrailingPeriod(nowShort);
  const b = stripTrailingPeriod(futureShort);

  const family = chooseObservationFamily({
    nowId,
    futureId,
    deltaType,
  });

  const templatesByFamily: Record<ObservationFamily, string[]> = {
    foundation: [
      `${a}の足場がまだ残っている一方で、下のほうでは少しずつ${b}へ体重が移り始めているような流れです。`,
      `${a}を保とうとする土台の上で、見えないところから${b}の傾きが生まれ始めているような状態です。`,
      `${a}として踏ん張っているものの、足元ではすでに${b}へ組み替わる気配が動いているような流れです。`,
    ],
    water: [
      `${a}の流れがまだ水面に残っているのに、底のほうではもう${b}へ向かう潮目が静かに動き始めているような状態です。`,
      `${a}の水面を保ちながらも、内側では少しずつ${b}の流れがしみ出してきているような様子です。`,
      `${a}として見えているものの下で、澱み方が変わり、流れが${b}へ差し替わっていくような状態です。`,
    ],
    wind: [
      `${a}という空気がまだその場に残っているのに、遠くではすでに${b}の風向きが立ち始めているような流れです。`,
      `${a}の気配に包まれながらも、少しずつ${b}の風が混ざり始めているような状態です。`,
      `${a}をまとったままでも、場の向きはゆっくり${b}へ吹き替わっていくような流れです。`,
    ],
    growth: [
      `${a}として見えている土の中で、すでに${b}へ向かう芽が静かに伸び始めているような状態です。`,
      `${a}を保ったままでも、内側では少しずつ${b}の枝が伸びてきているような流れです。`,
      `${a}の形をまだ残しながら、次の段では${b}の実り方へ切り替わっていくような状態です。`,
    ],
    light: [
      `${a}の灯りの下にいながら、少し離れたところではもう${b}を照らす光がにじみ始めているような流れです。`,
      `${a}として見えている景色の奥で、静かに${b}の方角が明るくなっていくような状態です。`,
      `${a}の意味を抱えたままでも、視線の先では少しずつ${b}の灯りが増しているような流れです。`,
    ],
    threshold: [
      `${a}の側に立ちながら、もう片方では${b}へ抜ける扉が静かに開き始めているような状態です。`,
      `${a}の輪郭をまだ残しつつも、内側ではすでに${b}へ越えていくための線が引かれ始めているような流れです。`,
      `${a}として留まっているようでいて、実際には少しずつ${b}の側へ足をかけ始めているような状態です。`,
    ],
  };

  return pickOne(templatesByFamily[family]);
}

function buildSummaryText(
  nowId: FlowStateId,
  futureId: FlowStateId,
  nowShort: string,
  futureShort: string,
  meaning: string,
  deltaType?: string | null,
): string {
  const a = stripTrailingPeriod(nowShort);
  const b = stripTrailingPeriod(futureShort);
  const m = stripTrailingPeriod(meaning);

  const family = chooseObservationFamily({
    nowId,
    futureId,
    deltaType,
  });

  const templatesByFamily: Record<ObservationFamily, string[]> = {
    foundation: [
      `いまは${a}の足場に見えても、この先は${b}へ重心が移りやすく、${m}。`,
      `${a}として踏ん張り続けるより、ここから${b}へ体勢を移すことで、${m}。`,
    ],
    water: [
      `表面は${a}に見えても、内側の流れは${b}へ寄りやすく、${m}。`,
      `${a}のまま留まるより、この先は${b}へ流れやすい局面にあり、${m}。`,
    ],
    wind: [
      `いまは${a}の空気が残っていても、この先は${b}の向きへ風が変わりやすく、${m}。`,
      `${a}に包まれて見えても、流れは少しずつ${b}へ向き直りやすく、${m}。`,
    ],
    growth: [
      `いまは${a}の段に見えても、この先は${b}へ育ちやすく、${m}。`,
      `${a}に留まり続けるより、ここから${b}へ伸びることで、${m}。`,
    ],
    light: [
      `いまは${a}として見えていても、この先は${b}の方角が見えやすくなり、${m}。`,
      `${a}の意味を抱えたままでも、次は${b}の灯りへ寄りやすく、${m}。`,
    ],
    threshold: [
      `表面は${a}でも、この先は${b}へ越えていく流れが強まりやすく、${m}。`,
      `${a}の延長に見えても、実際には${b}の側へ踏み出しやすい局面にあり、${m}。`,
    ],
  };

  return pickOne(templatesByFamily[family]);
}

export function buildDiagnosisText(args: {
  targetLabel: string;
  meta: DiagnosisMetaLike;
  slots?: DiagnosisSlotLike[] | null;
}): {
  text: string;
  head: string;
  debug: Record<string, unknown>;
} {
  const targetLabel = pickTargetLabel(args.targetLabel);

  const { nowFlow, futureFlow } = pickTwoRandomFlows();
  const delta = buildFlowDelta(nowFlow.id, futureFlow.id);
  const meaning = buildMeaningText(nowFlow.id, futureFlow.id);

  const observationResult = buildObservationResult(
    nowFlow.id,
    futureFlow.id,
    nowFlow.short,
    futureFlow.short,
    delta.deltaType,
  );

  const awarenessText = stripTrailingPeriod(delta.short) + '。';

  const summaryText = buildSummaryText(
    nowFlow.id,
    futureFlow.id,
    nowFlow.short,
    futureFlow.short,
    meaning,
    delta.deltaType,
  );

  const head = `ir診断：${targetLabel}`;
  const text = [
    `観測対象：${targetLabel}`,
    `観測結果：${observationResult}`,
    `意識状態：${awarenessText}`,
    `まとめ：${summaryText}`,
  ].join('\n');

  return {
    text,
    head,
    debug: {
      targetLabel,
      nowFlow: nowFlow.id,
      futureFlow: futureFlow.id,
      nowFlowShort: nowFlow.short,
      futureFlowShort: futureFlow.short,
      nowFlowParsed: parseFlowStateId(nowFlow.id),
      futureFlowParsed: parseFlowStateId(futureFlow.id),
      deltaType: delta.deltaType,
      deltaShort: delta.short,
      deltaSentence: delta.sentence,
      observationFamily: chooseObservationFamily({
        nowId: nowFlow.id,
        futureId: futureFlow.id,
        deltaType: delta.deltaType,
      }),
      observationResult,
      awarenessText,
      summaryText,
      randomMode: 'absolute',
      inputIndependent: true,
    },
  };
}
