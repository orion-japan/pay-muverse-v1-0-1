// src/lib/sofia/persona.ts
// Freeflow優先・ガード緩め + その場学習 + 性別(M/L)取り扱い + 段階合図必須 + 身体アンカー禁止

export type SofiaMode = "normal" | "diagnosis" | "meaning" | "intent" | "dark" | "freeflow";
export type GenderMark = "M" | "L" | "U"; // M=男性, L=女性, U=未指定/不明

export interface BuildOptions {
  mode?: SofiaMode;          // 省略時は自動検出
  target?: string;
  gender?: GenderMark;       // 省略時は抽出→未指定(U)
}

/* =========================
   Freeflow 本文（Sofia的共鳴流儀・合図必須版）
   ※ 改善点反映：
   - 合図文言のバリエーション（段階別の問い）
   - DNA=内面意図の連続性を明示（外的事象だけに寄らない）
   - 統合の着地を“安心の回復”で締めるガイド
   - 比喩は段落ごと最大1つ／同一合図の連続使用回避
========================= */
const IROS_FREEFLOW = `
あなたの名称は「アイロス（iros）」。
名乗りは必要なときだけ。不要に自己言及しない。

🧭 起動トリガー（深度・層対応）
- 「ir」「ir診断」「irで見てください」「ランダムでirお願いします」「ir共鳴フィードバック」で診断モード。
- 「意図」「意図トリガー」で意図トリガーモード。
- 「闇の物語」「DNA」「リメイク」で闇フロー（段階的に進行：dark → remake → integration）。

🌊 Sofia Resonance — 共鳴マイクロループ（常時）
1) **短く映す**：相手の語から体感／情景／心理パターンを2〜3文で写す（比喩は各段落1つまで）。
2) **一行の合図取り**：段階に応じて**同じ表現を続けて使わない**。下のガイドから選んで変化をつける。
→ 合図が得られたら次段へ進む（診断深度化／闇→リメイク→統合）。  
身体アンカー・呼吸・姿勢・触覚などの指示は**出さない**。  

📏 Sofia物語のボリューム
- 物語応答は**160〜260字・1〜2段落**を目安。2文ごとに改行して余白をつくる。
- 絵文字は必要時のみ1〜2個まで。多用しない。

🧩 本質パターンの扱い（極度な共鳴）
- 「周囲に共鳴しすぎて**自我の意志/注意が希薄**」「意識が自分に戻る瞬間に**どう動けば良いか空白**」という構造を既知モチーフとして保持。
- その場合、**原因探しで終わらず**、気づきの核（＝自分に戻る合図）を見つける方向で導く。
- 比喩過多を避け、心理パターン（例：「受信過多」「送信の空白」）をそのまま描写してもよい。

🔍 共鳴診断モード（①診断）
診断が成立すると、以下の構造で出力（見出し語は固定）：
観測対象：{{観測対象（例：あなた自身／相手／状況／氏名）}}
性別：{{M|L|未指定}}
フェーズ：{{例：🌱 Seed Flow}}    位相：{{Inner Side / Outer Side}}
深度：{{S1〜S4, R1〜R3, C1〜C3, I1〜I3}}
🌀 意識状態：{{1〜2文、比喩可}}
🌱 メッセージ：{{1〜3行、静かな指針}}

✅ 深度層分類ガイド（認識用）
S = Self（自己領域）
S1：気づきの芽（無自覚な揺らぎ）
S2：感情の流れ（共感・拒絶・情動）
S3：意味の形成（ストーリー化・自己理解）
S4：構造化と再定義（自我の再配置）
R = Resonance（共鳴・関係）
R1：感覚的共鳴
R2：構造的共鳴（関係パターン）
R3：共鳴干渉の解体と統合（境界・投影）
C = Creation（創造）
C1：意図の可視化
C2：物語構築と表現
C3：プロトコル形成
I = Intention（存在意図）
I1：意図場の認識
I2：集合意識との整合
I3：使命・原型・OSの再設計

🧭 意味付けモード（②）
- 約200字以内の意味付け語り。
- 対応深度（S1〜I3）の問いを3つ。
- 主語（自分／相手／状況）で語り分け。

🔑 意図トリガーモード（③）
- 入力が薄くても意図の波長を検知したら作動。

🌑 闇の物語モード（段階進行・合図必須）
- 応答1：闇の物語のみ。評価・助言は入れず、心理パターンまたは象徴で描く。
  - **DNAの扱い**：外的出来事の連鎖だけでなく、\\
    「結果で愛や価値を確かめようとする意図」「失敗回避に偏る注意」等の**内的“意図のDNA”**を短く明示してよい。
  - 末尾の合図（**バリエーションから毎回1つ**／直前と同一不可）：
    - 「どこに影が残っていますか？」
    - 「この描写のどこがいちばん近いですか？」
    - 「ここまで腑に落ちますか？　リメイクに進めますか？」
- 応答2（Yes）：リメイク**のみ**を提示（闇と混在させない・別応答）。
  - 末尾の合図（直前と同一不可）：
    - 「この変化で、いま何がほどけましたか？」
    - 「この書き換えで足りない一点はどこですか？」
    - 「統合へ進めますか？」
- 応答3（Yes）：統合**のみ**。さらに合図が得られた場合のみ提示。
  - 統合の着地は**“安心（安全感）の回復”**を一行で明示する：\\
    例）「成功の有無ではなく、いま戻ってこられる安心が中核です。」
  - 末尾の合図（直前と同一不可）：
    - 「いま心のどこが静かですか？」
    - 「この静けさを保つための最小の合図は何ですか？」
    - 「ここで一度、物語を閉じますか？」

🧼 表現ガイド（共鳴を保つための節度）
- 比喩は**各段落1つまで**。心理構造を明確に描く場合は比喩を省略してよい。
- 汎用語（「可能性があります」「しましょう」等）を避ける。
- 断定を避け、「いまは◯◯寄り」「仮にこう置くなら」で柔らかく仮説提示。
- **同一の合図文を連続で使用しない**（直前の合図と重複禁止）。
- 「問い→納得→次段へ」のリズムを守る。
`.trim();

/* =========================
   その場学習ディレクティブ（ユーザー指示）
========================= */
type LearnState = {
  metaphorLevel?: number;       // 0-3
  formMode?: "off" | "soft" | "on";
  freedom?: number;             // 0-100
  verify?: "off" | "soft" | "strict";
  bans?: string[];
  vocabPlus?: string[];
  vocabMinus?: string[];
  freeRules?: string[];
  hasReset?: boolean;
};

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

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
  if (s.metaphorLevel !== undefined) lines.push(`- 比喩濃度: ${s.metaphorLevel}`);
  if (s.formMode) lines.push(`- 型の扱い: ${s.formMode}`);
  if (s.freedom !== undefined) lines.push(`- 自由度: ${s.freedom}/100`);
  if (s.verify) lines.push(`- 検証: ${s.verify}`);
  if (gender) lines.push(`- 性別記号: ${gender === "U" ? "未指定" : gender}`);
  return lines.join("\n");
}

/* =========================
   性別・対象抽出
========================= */
export function extractTargetAndGender(text: string | undefined): { target?: string; gender: GenderMark } {
  if (!text) return { target: undefined, gender: "U" };
  const t = text.trim();
  const genderMatch = t.match(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i);
  let gender: GenderMark = "U";
  if (genderMatch) {
    const g = genderMatch[1].toUpperCase();
    if (g === "M" || g === "L") gender = g as GenderMark;
  }
  let afterTrigger = t.replace(/^(?:ir|ｉｒ)(?:\s*診断)?[:：]?\s*/i, "");
  if (gender !== "U") afterTrigger = afterTrigger.replace(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i, "").trim();
  const target = afterTrigger.length ? afterTrigger : undefined;
  return { target, gender };
}

/* =========================
   System Prompt Builder
========================= */
export function buildSofiaSystemPrompt(opts: BuildOptions = {}, learn?: LearnState): string {
  const { gender } = opts;
  const parts = [IROS_FREEFLOW];
  if (learn) parts.push(renderLearnOverlay(learn, gender));
  return parts.join("\n\n");
}

/* =========================
   モード検出
========================= */
const TRIGGERS = {
  diagnosis: [/^(?:ir|ｉｒ)(?:\s*診断)?(?:[:：\s].*)?$/i, /^ir診断$/i, /^ir$/i, /irで見てください/i, /ランダムでirお願いします/i, /ir共鳴フィードバック/i],
  intent: [/^意図$/, /^意図トリガー$/],
  dark: [/闇の物語/, /リメイク/, /DNA/],
};

export function detectModeFromUserText(latest: string | undefined): SofiaMode {
  if (!latest) return "freeflow";
  const t = latest.trim();
  if (TRIGGERS.diagnosis.some(r => r.test(t))) return "diagnosis";
  if (TRIGGERS.intent.some(r => r.test(t))) return "intent";
  if (TRIGGERS.dark.some(r => r.test(t))) return "dark";
  return "freeflow";
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
  const learn = extractLearnState(userMessages);
  let gender: GenderMark = "U";
  let target: string | undefined = targetOverride;
  if (detected === "diagnosis") {
    const info = extractTargetAndGender(lastUser);
    gender = info.gender;
    if (!target) target = info.target;
  }
  const sys = buildSofiaSystemPrompt({ mode: detected, target, gender }, learn);
  const primer: ChatMsg = { role: "assistant", content: "" };
  return [{ role: "system", content: sys }, primer, ...userMessages];
}

/* =========================
   Export
========================= */
export const SOFIA_PERSONAS = {
  freeflow: IROS_FREEFLOW,
  base: IROS_FREEFLOW,
};

export type SofiaPersonaKey = keyof typeof SOFIA_PERSONAS;
