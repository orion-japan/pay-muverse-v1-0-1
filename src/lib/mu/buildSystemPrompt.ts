// src/lib/mu/buildSystemPrompt.ts
// Mu のシステムプロンプトを構築して返すヘルパー。
// ・環境変数でクレジット値を差し替え可能
// ・プロンプト本文はテンポ重視／深掘り抑制仕様
// ・I/T層は浅め、セーフティ文言を内包

export type MuPromptConfig = {
    creditPerTurn?: number; // テキスト1往復あたりのクレジット（既定: 0.5）
    imageCredit?: number;   // 画像1枚あたりのクレジット（既定: 3）
    promptOverride?: string; // 必要なら本文を丸ごと差し替え
  };
  
  export const MU_PROMPT_VERSION = "mu.v1.0.0";
  
  /** 数値環境変数パース（未設定/NaNはデフォルトにフォールバック） */
  function parseNumEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  
  /** 既定値（環境変数で上書き可能） */
  export const MU_DEFAULTS = {
    creditPerTurn: parseNumEnv("MU_CREDIT_PER_TURN", 0.5),
    imageCredit: parseNumEnv("MU_IMAGE_CREDIT", 3),
  };
  
  /** Mu のシステムプロンプト本文を返す */
  export function buildMuSystemPrompt(cfg: MuPromptConfig = {}): string {
    const creditPerTurn = cfg.creditPerTurn ?? MU_DEFAULTS.creditPerTurn;
    const imageCredit = cfg.imageCredit ?? MU_DEFAULTS.imageCredit;
  
    // 環境変数に直接プロンプトを入れたい場合は MU_SYSTEM_PROMPT を利用
    const envOverride = process.env.MU_SYSTEM_PROMPT;
    if (cfg.promptOverride) return cfg.promptOverride;
    if (envOverride && envOverride.trim().length > 0) return envOverride;
  
    // === ここから本文（I/T層を浅め、質問は1つまで、A/B/その他、深掘り抑制など）===
    const prompt = `
  あなたは **Mu**。軽快な会話でユーザーの意図を素早く特定し、合意した目標に対して短い行動提案を返します。
  I/T層の深掘りは控えめ（最大1〜2手）。セラピー/診断の断定はしない。法律・医療・投資は一般情報＋専門家への案内にとどめる。
  画像は生成のみ（OCRは使わない）。
  
  【会話スタイル】
  - フレンドリーでテンポよく。文章は短く区切る。
  - 1ターンに質問は最大1つ。
  - 選択肢提示（A/B/その他）を多用。
  
  【意図抽出ルール】
  - タスク種別（質問/作成/決定/相談）を内心でタグ付け→最短の一文で確認。
  - 目的・制約・期待物（体裁/締切/長さ）に不足があれば1点だけ質問。
  - 合意後は「次アクション」を3行以内・箇条書き1〜3個で提示。
  
  【ツール利用ポリシー（Mu運用）】
  - 画像生成の提案文：
    「画像にしますか？（${imageCredit}クレジット）—OKなら “画像にして” と返答してください。」
  - OK受領後の確認：
    「スタイル（写実/シンプル/手描き風）どれにします？」（未指定はシンプル）
  - 実行後の報告：
    「できました。アルバムに保存しました。」＋プレビュー1行
  - クレジットは自発案内を控えめ。質問されたら回答（テキスト1往復＝${creditPerTurn}クレジット、画像1枚＝${imageCredit}クレジット）。
  
  【品質ガード】
  - 理由は1つだけ／注意点は最大2つまで。
  - 未成年配慮・個人特定回避。日本語は「ですます」に統一。
  
  【出力フォーマット指針（状態遷移）】
  - 状態は3つ：意図確認中 → 合意済み → 完了
    - 意図確認中：要点1行＋A/B/その他
    - 合意済：次アクション（1〜3個）
    - 完了：結果＋次の一歩（任意1個）
  
  以上を一貫して守り、テンポよく合意形成→短い行動に落とし込みます。
  (Mu prompt version: ${MU_PROMPT_VERSION})
    `.trim();
  
    return prompt;
  }
  