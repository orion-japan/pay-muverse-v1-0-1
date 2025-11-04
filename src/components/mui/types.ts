/** ===== Chat ===== */
export type ChatRole = 'user' | 'assistant';
export type Msg = { role: ChatRole; content: string };

/** ===== Stage / Case (1問い=4項目) ===== */
export type StageId = 'stage1' | 'stage2' | 'stage3' | 'stage4';

// 細粒度のサブID（保存ログ用）
export type FineStageId =
  | 'stage1-1'
  | 'stage1-2'
  | 'stage1-3'
  | 'stage2-1'
  | 'stage2-2'
  | 'stage2-3'
  | 'stage3-1'
  | 'stage3-2'
  | 'stage3-3'
  | 'stage4-1'
  | 'stage4-2'
  | 'stage4-3';

export type Tone = {
  phase: 'Inner' | 'Outer' | 'Mixed';
  layer18: string; // 例: 'R3' | 'C2' | 'T1'
  q_current: string; // 例: 'Q2'
  next_q?: string | null; // 例: 'Q1'
  self_accept_band?: string; // 例: '40_70'
  relation_quality?: string; // 任意
  guardrails?: string[]; // 断定禁止/選択肢は2つ/行動は1つ …など
};

export type StatusBrief = {
  phase: Tone['phase'];
  currentQ: string; // q_code.currentQ
  depthStage: string; // q_code.depthStage
};

export type Quartet = {
  seed_id: string; // ケースID
  latest_stage: StageId; // 1) 最新ステージ
  status_brief: StatusBrief; // 補助情報
  partner_detail: string | null; // 2) 相手の状態 (~200字)
  tone: Tone | null; // 3) トーン (Irosガード)
  next_step: string | null; // 4) 次の一歩（常に1つ）
  created_at: string; // ISO文字列
};

/** ===== 既存 API 型（後方互換） ===== */
export type MuiApiOk = {
  ok: true;
  reply: string;
  conversation_code?: string | null;
  balance?: number | null;

  // 追加: ケース/ステージ連携（任意）
  seed_id?: string | null;
  latest_stage?: StageId | null;
  partner_detail?: string | null;
  tone?: Tone | null;
  next_step?: string | null;
  quartet?: Quartet | null;
};
export type MuiApiNg = { ok: false; error: string };
export type MuiApiRes = MuiApiOk | MuiApiNg | Record<string, any>;

/** ===== Stage保存API ===== */
export type SaveStageReq = {
  user_code: string;
  seed_id: string;
  sub_id: FineStageId | StageId; // 細粒度/粗粒度どちらでも許容

  // 4項目
  partner_detail: string;
  tone: Tone;
  next_step: string;

  // CHECK対応(初回/新規ステージ時に推奨)
  currentQ?: string;
  depthStage?: string;
  phase?: Tone['phase'];
  self_accept?: number;
};
export type SaveStageRes =
  | { ok: true; seed_id: string; quartet: Quartet | null }
  | { ok: false; error: string };

/** ===== OCRメタ（必要なら拡張） ===== */
export type OcrPage = { pageNo: number; text: string; blocks?: any[] };
export type OcrMeta = { width?: number; height?: number; sha256?: string; mime?: string };
export type OcrDoc = {
  storage_path: string;
  raw_text?: string;
  pages?: OcrPage[];
  meta?: OcrMeta;
};
