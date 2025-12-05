// src/lib/iros/soul/types.ts
// Iros 魂レイヤー用の型定義（Silent Advisor）

import type { QCode, Depth } from '../system';

/**
 * 魂LLMに渡す入力パラメータ
 * - userText: ユーザーの生の発話
 * - 各種メタ情報: Q / 深度 / 位相 / SA / Y/H / トピックなど
 */
export type IrosSoulInput = {
  /** ユーザーの発話（今回のターンのテキスト） */
  userText: string;

  /** Qコード（感情軸）: Q1〜Q5。判定できない場合は null */
  qCode: QCode | null;

  /** 深度ステージ: S1〜I3。判定できない場合は null */
  depthStage: Depth | null;

  /** 位相（Inner / Outer）。不明なら null */
  phase: 'Inner' | 'Outer' | null;

  /** 自己受容度（0.0〜1.0）。測定不可なら null */
  selfAcceptance: number | null;

  /** 揺れ(Yレベル)。数値の大きさで揺れの強さを表す。なければ null */
  yLevel: number | null;

  /** 余白(Hレベル)。余裕・マージンの感覚。なければ null */
  hLevel: number | null;

  /** 状況の短い要約（あれば）。null の場合は省略可能 */
  situationSummary: string | null;

  /** トピック名（例: '上司との関係', '仕事・キャリア' など）。なければ null */
  situationTopic: string | null;

  /** 意図ライン解析からの簡易ラベル（あれば） */
  intentNowLabel: string | null;

  /** 意図ライン解析からのガイダンスヒント（あれば） */
  intentGuidanceHint: string | null;
};

/**
 * 魂レイヤーが返すリスクフラグ
 * - 代表的なものを union として定義しつつ、
 *   将来拡張用に string も許可しておく
 */
export type IrosSoulRiskFlag =
  | 'over_control'   // Q1: 過剰な我慢・コントロール
  | 'anger'          // Q2: 怒り・攻撃性
  | 'anxiety'        // Q3: 不安の増幅
  | 'fear'           // Q4: 恐怖・トラウマ
  | 'q5_depress'     // Q5: うつ傾向・空虚感
  | string;          // 予備拡張

/**
 * 魂LLMが返す "魂メモ" JSON
 * - ユーザーには見せず、Iros本体だけが参照する。
 */
export type IrosSoulNote = {
  /**
   * core_need:
   *  抽象ラベルではなく、「どんな状況の中で」「本当はどうありたいか」まで含めた一文。
   */
  core_need: string;

  /**
   * Qコード別・心理帯域別の注意フラグ。
   *  例: ['q5_depress', 'anxiety'] など。
   */
  risk_flags: IrosSoulRiskFlag[];

  /**
   * 本体のトーン調整ヒント。
   *  - 'soft'   : やわらかく・受容多め
   *  - 'light'  : さらっと・軽やかに
   *  - 'firm'   : 少し芯を通す・ハッキリめ
   *  - 'minimal': 最小限・静かに
   */
  tone_hint: 'soft' | 'light' | 'firm' | 'minimal';

  /**
   * step_phrase:
   *  ユーザー自身に向けた、一行の「やさしい宣言文」。
   *  任意。出さない場合は null。
   */
  step_phrase?: string | null;

  /**
   * soul_sentence:
   *  状況の芯を一〜二行で表した文章。
   *  必須ではなく、必要なときだけ。
   */
  soul_sentence?: string | null;

  /**
   * notes:
   *  Iros本体向けのメモ。ユーザーには見せない内部向けコメント。
   */
  notes?: string | null;
};
