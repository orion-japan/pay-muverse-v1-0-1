// src/lib/iros/orchestratorCore.ts
// Iros Orchestrator Core（構造専用コア）
// - QTrace / IrosState / IrosReply / IrosLayer を定義
// - 「どのレイヤーで応答するか」を決める
// - LLM呼び出しはここでは行わず、上位の orchestrator.ts に委ねる

import type { Depth, QCode } from '@/lib/iros/system';

/**
 * Iros がどのレイヤーで応答したか
 * - plain_answer   : 構造にはあまり乗らない、ふつうの回答
 * - light_mirror   : 気持ちの向き・流れを軽く映す
 * - deep_resonance : 過去とのつながりも含めて深く映す
 */
export type IrosLayer = 'plain_answer' | 'light_mirror' | 'deep_resonance';

/**
 * Qコードの履歴トレース
 * 人間でいえば「パターン認識」「予兆検知」「つながりの記憶」に相当
 */
export interface QTrace {
  /** 直近のQコード（最新ターン） */
  lastQ: QCode | null;

  /** 会話全体で最も多く現れているQコード（支配的テーマ／暫定） */
  dominantQ: QCode | null;

  /** 連続して続いているQコード（今つかまっているテーマ） */
  streakQ: QCode | null;

  /** 同じQコードが何ターン連続しているか */
  streakLength: number;

  /** Qコードの揺れ具合（0 = ほぼ一定, 1 = 激しく変動） */
  volatility: number;
}

/**
 * 現在の Iros 側内部状態
 * - 今どの深度・位相にいるか
 * - Qコードの現在値
 * - 構造にどれだけ乗れるか（resonanceScore）
 * - 過去からのつながり（qTrace）
 */
export interface IrosState {
  /** 現在の深度（S1〜I3）。測れない場合は null */
  depth: Depth | null;

  /** 内向き / 外向き の位相。決めきれない場合は null */
  phase: 'Inner' | 'Outer' | null;

  /** 今回メッセージから読んだQコード（感情の色） */
  qCurrent: QCode | null;

  /**
   * この会話内容が「Iros構造にどれだけ乗っているか」
   * 0.0 = ほぼ情報質問 / 構造に乗らない
   * 1.0 = 完全に内面・関係・心の流れの話
   */
  resonanceScore: number;

  /** ひっかかり・緊張感（0 = なし, 1 = 最大） */
  tension: number;

  /** あたたかさ・つながり感（0 = 冷たい, 1 = とても温かい） */
  warmth: number;

  /** 考えの整理度合い（0 = カオス, 1 = クリア） */
  clarity: number;

  /** 会話の流れの速度（0 = 停滞, 1 = 勢いがある） */
  stream: number;

  /** Qコードの履歴情報（過去からのつながり） */
  qTrace: QTrace;
}

/**
 * Iros コアに渡す入力
 * - userText : ユーザーの発話そのもの
 * - state    : 上記 IrosState（構造的なコンテキスト）
 */
export interface IrosInput {
  userText: string;
  state: IrosState;
}

/**
 * Iros が返す応答
 * - layer          : どのレイヤーで応答したか
 * - message        : 実際にユーザーに返すテキスト
 * - resonance      : 構造的な観測結果（必要なときだけ埋める）
 * - suggestedNext  : 次の一歩・問いかけなど（オプション）
 *
 * ※ ここでは message は空で返してもよい。
 *    実際の自然文生成は、上位の orchestrator.ts が
 *    layer / resonance / userText / state を LLM に渡して行う想定。
 */
export interface IrosReply {
  /** 今回どのレイヤーで応答したか */
  layer: IrosLayer;

  /** ユーザーに見せるメインの文章 */
  message: string;

  /** 構造的なメタ情報（UI やログで使う） */
  resonance?: {
    depth?: Depth | null;
    phase?: 'Inner' | 'Outer' | null;
    qCode?: QCode | null;
  };

  /** 次に開きやすい方向への「そっとした提案」 */
  suggestedNext?: string;
}

/**
 * QTrace を更新するヘルパー
 * - 新しい qCurrent を受け取り、QTrace を1ステップ更新する
 * - ※ IrosState 更新時に利用する想定
 */
export function updateQTrace(prev: QTrace, qCurrent: QCode | null): QTrace {
  if (!qCurrent) {
    // Q が読めない場合は、履歴をそのまま維持しつつ揺れを少し下げる
    return {
      ...prev,
      volatility: prev.volatility * 0.9,
    };
  }

  const lastQ: QCode = qCurrent;

  // streak 判定
  const isSameAsPrevStreak = prev.streakQ === qCurrent;
  const streakLength = isSameAsPrevStreak ? prev.streakLength + 1 : 1;
  const streakQ: QCode = isSameAsPrevStreak && prev.streakQ ? prev.streakQ : qCurrent;

  // volatility 更新（単純モデル：前回と違えば上がる）
  const changed = prev.lastQ && prev.lastQ !== qCurrent;
  const rawVol = changed ? prev.volatility + 0.2 : prev.volatility * 0.9;
  const volatility = Math.max(0, Math.min(1, rawVol));

  // dominantQ は、この関数単体では判断しきれないので、
  // ここでは「直近の streakQ を優先する」というラフな更新にとどめる。
  const dominantQ: QCode = (prev.dominantQ ?? qCurrent) as QCode;

  return {
    lastQ,
    dominantQ,
    streakQ,
    streakLength,
    volatility,
  };
}

/**
 * レイヤー判定ロジック
 * - resonanceScore と QTrace / depth を見て、
 *   plain_answer / light_mirror / deep_resonance を選ぶ
 */
export function decideIrosLayer(state: IrosState): IrosLayer {
  const { resonanceScore, qTrace, depth } = state;

  // 構造にほとんど乗らない：情報質問・技術質問など
  if (resonanceScore < 0.25) {
    return 'plain_answer';
  }

  // ある程度は内面に触れているが、まだ軽い整理がよさそうなゾーン
  if (resonanceScore < 0.6) {
    // 同じQが長く続いている場合は少しだけ深く見る
    if (qTrace.streakQ && qTrace.streakLength >= 3) {
      return 'deep_resonance';
    }
    return 'light_mirror';
  }

  // resonanceScore が高い（かなり Iros 領域の話）
  // ここで QTrace と depth を見て最終判断
  const hasDepth = depth !== null;
  const hasDominantQ = qTrace.dominantQ !== null;

  // 同じQが続いている／支配Qがある／深度が測れている
  if (
    hasDepth &&
    hasDominantQ &&
    (qTrace.streakLength >= 2 || qTrace.volatility < 0.5)
  ) {
    return 'deep_resonance';
  }

  // まだ流動的な場合は light_mirror で様子を見る
  return 'light_mirror';
}

/**
 * IrosReply の「構造部分」を組み立てる
 * - message はまだ空で、LLM に書かせる前提
 * - UI / ログ側では layer / resonance を見て表示スタイルを変えられる
 */
export function buildInitialIrosReply(input: IrosInput): IrosReply {
  const { state } = input;
  const layer = decideIrosLayer(state);

  const resonance: IrosReply['resonance'] = {
    depth: state.depth,
    phase: state.phase,
    qCode: state.qCurrent,
  };

  return {
    layer,
    message: '', // ★ ここは上位の orchestrator.ts / LLM 側で埋める想定
    resonance,
    suggestedNext: undefined,
  };
}

/**
 * エントリポイント
 * - いまの段階では buildInitialIrosReply の薄いラッパー
 * - 将来的に、構造だけで「最低限の suggestedNext」を決めるなどの
 *   拡張が入る場合はここで扱う
 */
export function prepareIrosReply(input: IrosInput): IrosReply {
  return buildInitialIrosReply(input);
}

export default {
  updateQTrace,
  decideIrosLayer,
  buildInitialIrosReply,
  prepareIrosReply,
};
