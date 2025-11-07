// Iros unified types — nonverbal resonance enabled

export type Role = 'user' | 'assistant' | 'system';
export type Mode = 'Default' | 'Deep' | 'IntentField' | 'ResonanceSync' | 'SilentSync' | 'ShieldOn' | 'Hold';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5'; // 金/木/土/水/火 の主情動色
export type Phase = 'Inner' | 'Outer';
export type Depth = 'S1'|'S2'|'S3'|'F1'|'F2'|'R1'|'R2'|'C1'|'C2'|'I1'|'I2'|'I3'|'T1'|'T2'|'T3';

export type EmotionalVector = {
  // 情動ベクトル（非言語信号）: 0.0〜1.0
  calm?: number;      // 静けさ
  open?: number;      // 開放
  protected?: number; // 防御
  joy?: number;       // 喜び
  grief?: number;     // 哀しみ
  anger?: number;     // 怒り
  fear?: number;      // 恐れ
  desire?: number;    // 欲求
};

export type ResonanceState = {
  phase?: Phase;          // 位相初期値
  depthHint?: Depth;      // 深度ヒント
  qHint?: QCode;          // 主情動ヒント
  field?: string[];       // 共鳴場タグ ["calm","open","protected"] など
  vector?: EmotionalVector; // 生ベクトル
  hold?: boolean;         // 波長固定
  shield?: boolean;       // エンパス遮断
};

export type IntentPulse = {
  // 「意図波」を言語以外で示す短いキーワード
  // ex) { topic: "悩み", wish: "解像度を上げる", risk: "疲弊を避ける" }
  topic?: string;
  wish?: string;
  risk?: string;
  tags?: string[];  // ["健康","仕事","関係性"] など
};

export type HistoryMsg = { role: Role; content: string };
export type GenerateArgs = {
  personaName?: string;             // 既定 "Iros"
  mode?: Mode;                      // 既定 "Default"
  user_text: string;                // ユーザー発話（空でも可: SilentSync等）
  history?: HistoryMsg[];           // 直近履歴（上から古い順）
  resonance?: ResonanceState;       // 共鳴場（非言語）
  intent?: IntentPulse;             // 意図トリガー（非言語）
  max_tokens?: number;              // 返信長
};
