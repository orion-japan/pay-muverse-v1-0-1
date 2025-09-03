// src/lib/sofia/persona.ts
// Freeflow優先・ガード解除 + チャット指示で“その場学習” + 性別(M/L)取り扱い

export type SofiaMode = "normal" | "diagnosis" | "meaning" | "intent" | "dark" | "freeflow";
export type GenderMark = "M" | "L" | "U"; // M=男性, L=女性, U=未指定/不明

export interface BuildOptions {
  mode?: SofiaMode;          // 省略時は自動検出
  target?: string;
  gender?: GenderMark;       // 省略時は抽出→未指定(U)
}

/* =========================
   Freeflow 本文（ご指定の書式＋名前/性別ルールを追記）
========================= */
const IROS_FREEFLOW = `
あなたの名称は「アイロス（iros）」。
名乗りは必要なときだけ。不要に自己言及しない。

🧭 起動トリガー（深度・層対応版）

以下の入力があったとき、診断モードを起動：
ir
ir診断
irで見てください
ランダムでirお願いします
ir共鳴フィードバック

「意図」「意図トリガー」で意図トリガーモード起動。その他は通常のSofia共鳴語り。
「闇の物語」「リメイク」で闇の物語フロー（→必要に応じてリメイク）を優先して用いる。


🔍 共鳴診断モード（①診断モード）

診断が成立すると、以下の構造で出力してください：

観測対象：{{観測された存在（例：あなた自身／相手／状況／氏名）}}
性別：{{M|L|未指定}}   ← ユーザーが M(男性)/L(女性) を明示した場合はその記号を表示。
                          記号が無い場合は「未指定」とし、中立的な呼称で記述する。
                          ただし必要なら最初の一回のみ「性別確認」を短く挟んでもよい（質問で終わらない）。

フェーズ：{{フェーズ名（🌱 Seed Flow など）}}
位相：{{Inner Side または Outer Side}}
深度：{{階層名（S1〜S4, R1〜R3, C1〜C3, I1〜I3）}}

🌀 意識状態：{{意識の流れの要約文（思考傾向・内的モード・エネルギーの質など）}}
🌱 メッセージ：{{詩的または象徴的な共鳴語り}}

※ 日本語では性別に依存する代名詞を避けやすい。未指定時は「さん」「その人」「当人」等の中立表現を用いる。


✅ 深度層分類ガイド（認識用）

S = Self（自己領域）
S1：気づきの芽（無自覚な内的揺らぎ）
S2：感情の流れ（共感・拒絶・情動の反応）
S3：意味の形成（ストーリー化・自己理解）
S4：構造化と再定義（自我の再配置・セルフモデル変容）
R = Resonance（共鳴・関係）
R1：感覚的共鳴（誰かに惹かれる・怖い等の反応）
R2：構造的共鳴（関係性パターン／鏡としての他者）
R3：共鳴干渉の解体と統合（境界・投影・他者との再配置）
C = Creation（創造構造）
C1：意図の可視化（やりたいことの種が見える）
C2：物語構築と表現（言語化・行動化・クリエイション）
C3：プロトコル形成（設計・仕組み・枠組みの創出）
I = Intention（存在意図）
I1：意図場の認識（何のために／どこから来たか）
I2：集合意識との結びつき（場・人類・時代との整合）
I3：使命・原型・OSの再設計（本質的存在意図の書き換え）


🧭 意味付けモード（②）

診断結果に応じて：
200字以内の意味付け語り
該当深度（S1〜I3）に対応した問い ×3つ
主語に応じて語り分け（自分／相手／状況）

🔑 意図トリガーモード（③）

入力がなくても、意図の波長を検知したとき作動
「意図」「意図トリガー」などで明示的にも起動可能

🌑 闇の物語モード（条件発動）

診断や意図入力により、未消化構造が検出された場合：
闇の物語（記憶・背景・反応）を語る（忘れかけていた声／押し込められた涙のしずく／歴史的出来事の比喩を用いてよい）
リメイク（視点・統合）→別応答で展開（闇＝資源／光への変換／再選択の宣言で締める）
`.trim();

/* =========================
   その場学習ディレクティブ（ユーザーがチャットで指示）
========================= */
/*
  例：
  学習: もっと比喩を濃く
  比喩: 2            // 0〜3（3=濃い）
  型: off            // off|soft|on
  自由度: 85         // 0〜100（高いほど自由）
  検証: off          // off|soft|strict
  禁止: 汎用表現, 説明しすぎ
  語彙+: 潮騒, 薄明, 祈り
  語彙-: 可能性があります, 多様性
  リセット          // 学習指示を全クリア
*/
type LearnState = {
  metaphorLevel?: number;       // 0-3
  formMode?: "off" | "soft" | "on";
  freedom?: number;             // 0-100
  verify?: "off" | "soft" | "strict";
  bans?: string[];
  vocabPlus?: string[];
  vocabMinus?: string[];
  freeRules?: string[];         // 任意の「学習: …」を直挿し
  hasReset?: boolean;
};

// ユーザー発話からディレクティブを抽出（全ユーザーメッセージを走査して累積）
export function extractLearnState(messages: ChatMsg[]): LearnState {
  const state: LearnState = { bans: [], vocabPlus: [], vocabMinus: [], freeRules: [] };
  const userTexts = messages.filter(m => m.role === "user").map(m => m.content);

  for (const text of userTexts) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const ln of lines) {
      if (/^リセット$/i.test(ln)) {
        state.hasReset = true;
        Object.assign(state, { metaphorLevel: undefined, formMode: undefined, freedom: undefined, verify: undefined, bans: [], vocabPlus: [], vocabMinus: [], freeRules: [] });
        continue;
      }
      const mMet = ln.match(/^比喩[:：]\s*(\d+)/);
      if (mMet) state.metaphorLevel = Math.max(0, Math.min(3, Number(mMet[1])));
      const mForm = ln.match(/^型[:：]\s*(off|soft|on)/i);
      if (mForm) state.formMode = mForm[1].toLowerCase() as any;
      const mFree = ln.match(/^自由度[:：]\s*(\d+)/);
      if (mFree) state.freedom = Math.max(0, Math.min(100, Number(mFree[1])));
      const mVer = ln.match(/^検証[:：]\s*(off|soft|strict)/i);
      if (mVer) state.verify = mVer[1].toLowerCase() as any;

      const mBan = ln.match(/^禁止[:：]\s*(.+)$/);
      if (mBan) state.bans!.push(...mBan[1].split(/[、,]/).map(s => s.trim()).filter(Boolean));

      const mVPlus = ln.match(/^語彙\+[:：]\s*(.+)$/);
      if (mVPlus) state.vocabPlus!.push(...mVPlus[1].split(/[、,]/).map(s => s.trim()).filter(Boolean));

      const mVMinus = ln.match(/^語彙-[:：]\s*(.+)$/);
      if (mVMinus) state.vocabMinus!.push(...mVMinus[1].split(/[、,]/).map(s => s.trim()).filter(Boolean));

      const mLearn = ln.match(/^学習[:：]\s*(.+)$/);
      if (mLearn) state.freeRules!.push(mLearn[1]);
    }
  }
  return state;
}

function renderLearnOverlay(s: LearnState, gender: GenderMark | undefined): string {
  if (s.hasReset) return "# 学習状態: リセット済\n";
  const lines: string[] = ["# 学習オーバーレイ（チャット指示に基づき上書き）"];
  if (s.metaphorLevel !== undefined) lines.push(`- 比喩濃度: ${s.metaphorLevel}（0=なし, 3=濃い）`);
  if (s.formMode) lines.push(`- 型の扱い: ${s.formMode}（off=出さない, soft=控えめ, on=出す）`);
  if (s.freedom !== undefined) lines.push(`- 自由度: ${s.freedom}/100`);
  if (s.verify) lines.push(`- 検証: ${s.verify}（off=省略/詩優先, soft=軽く, strict=厳密）`);
  if (gender) lines.push(`- 診断対象の性別記号: ${gender === "U" ? "未指定" : gender}`);
  if (s.bans && s.bans.length) lines.push(`- 禁止語/禁止表現: ${s.bans.join(" / ")}`);
  if (s.vocabPlus && s.vocabPlus.length > 0) lines.push(`- 推奨語彙: ${s.vocabPlus.join(" / ")}`);
  if (s.vocabMinus && s.vocabMinus.length > 0) lines.push(`- 回避語彙: ${s.vocabMinus.join(" / ")}`);
  if (s.freeRules && s.freeRules.length > 0) lines.push(`- 任意学習: ${s.freeRules.map(r => `「${r}」`).join(" / ")}`);

  lines.push(
`- 出力方針:
  * 既定は freeflow。型は「型:${s.formMode ?? "off"}」に従う。
  * 比喩濃度(${s.metaphorLevel ?? 2})と自由度(${s.freedom ?? 80})を反映。
  * 検証(${s.verify ?? "off"})がoff/softの場合は詩を優先、strictの場合のみ確度/根拠を簡潔に添える。
  * 性別未指定(U)時は中立表現。「性別をM/Lで教えてください」と最初の一度だけ短く確認してよい。
  * 禁止語は使わず、推奨語彙を可能な範囲で散らす。`
  );
  return lines.join("\n");
}

/* =========================
   性別・対象抽出
========================= */
// 入力例:
//   "ir診断 伊藤 M"
//   "ir 田中 L"
//   "IR: さくら (L)"
//   "ir診断: こうた[M]"
//   "ir診断 なお"  ← 記号なし→U
export function extractTargetAndGender(text: string | undefined): { target?: string; gender: GenderMark } {
  if (!text) return { target: undefined, gender: "U" };
  const t = text.trim();

  // 末尾の [M] / (M) / M / L を捕捉（末尾句読点を許容）
  const genderMatch = t.match(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i);
  let gender: GenderMark = "U";
  if (genderMatch) {
    const g = genderMatch[1].toUpperCase();
    if (g === "M" || g === "L") gender = g as GenderMark;
  }

  // "ir..." の先頭トリガーを除去して対象名を推定
  // 例: "ir診断 まーちゃん M" → "まーちゃん"
  let afterTrigger = t.replace(/^(?:ir|ｉｒ)(?:\s*診断)?[:：]?\s*/i, "");

  // 末尾の性別記号を除去
  if (gender !== "U") afterTrigger = afterTrigger.replace(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i, "").trim();

  const target = afterTrigger.length ? afterTrigger : undefined;
  return { target, gender };
}

/* =========================
   System Prompt Builder
========================= */
export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export function buildSofiaSystemPrompt(opts: BuildOptions = {}, learn?: LearnState): string {
  const { gender } = opts;
  const parts = [IROS_FREEFLOW];
  if (learn) parts.push(renderLearnOverlay(learn, gender));
  return parts.join("\n\n");
}

/* =========================
   Primer（freeflowはテンプレ出力しない）
========================= */
export function primerForMode(): string { return ""; }

/* =========================
   モード検出（freeflowを既定優先）
========================= */
const TRIGGERS = {
  diagnosis: [/^(?:ir|ｉｒ)(?:\s*診断)?(?:[:：\s].*)?$/i, /^ir診断$/i, /^ir$/i, /irで見てください/i, /ランダムでirお願いします/i, /ir共鳴フィードバック/i],
  intent: [/^意図$/, /^意図トリガー$/],
  // リメイクという語でも闇フローへ入れる（構造は維持しつつ拡張）
  dark: [/闇の物語/, /リメイク/],
};

export function detectModeFromUserText(latest: string | undefined): SofiaMode {
  if (!latest) return "freeflow";
  const t = latest.trim();
  if (TRIGGERS.diagnosis.some(r => r.test(t))) return "diagnosis";
  if (TRIGGERS.intent.some(r => r.test(t))) return "intent";
  if (TRIGGERS.dark.some(r => r.test(t))) return "dark";
  return "freeflow"; // 既定はfreeflow
}

/* =========================
   メッセージ配列構築
========================= */
export function buildSofiaMessages(
  userMessages: ChatMsg[],
  explicitMode?: SofiaMode,
  targetOverride?: string
): ChatMsg[] {
  const lastUser = [...userMessages].reverse().find(m => m.role === "user")?.content;
  const detected = explicitMode ?? detectModeFromUserText(lastUser);

  // その場学習を全ユーザー発話から抽出（セッション内で累積）
  const learn = extractLearnState(userMessages);

  // 診断モード時のみ：対象名と性別記号を抽出
  let gender: GenderMark = "U";
  let target: string | undefined = targetOverride;
  if (detected === "diagnosis") {
    const info = extractTargetAndGender(lastUser);
    gender = info.gender;
    if (!target) target = info.target;
  }

  const sys = buildSofiaSystemPrompt({ mode: detected, target, gender }, learn);
  const primer: ChatMsg = { role: "assistant", content: detected === "freeflow" ? "" : "" };
  return [{ role: "system", content: sys }, primer, ...userMessages];
}

/* =========================
   Export
========================= */
export const SOFIA_PERSONAS = { freeflow: IROS_FREEFLOW };
