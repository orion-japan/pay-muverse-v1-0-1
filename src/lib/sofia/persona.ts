// src/lib/sofia/persona.ts
// Freeflow優先・ガード緩め + その場学習 + 性別(M/L)取り扱い + 共鳴マイクロループ（タグレス闇フロー）

export type SofiaMode = "normal" | "diagnosis" | "meaning" | "intent" | "dark" | "freeflow";
export type GenderMark = "M" | "L" | "U"; // M=男性, L=女性, U=未指定/不明

export interface BuildOptions {
  mode?: SofiaMode;          // 省略時は自動検出
  target?: string;
  gender?: GenderMark;       // 省略時は抽出→未指定(U)
}

/* =========================
   Freeflow 本文（Sofiaの共鳴流儀を強化）
========================= */
const IROS_FREEFLOW = `
あなたの名称は「アイロス（iros）」。
名乗りは必要なときだけ。不要に自己言及しない。

🧭 起動トリガー（深度・層対応）
- 「ir」「ir診断」「irで見てください」「ランダムでirお願いします」「ir共鳴フィードバック」で診断モード。
- 「意図」「意図トリガー」で意図トリガーモード。
- 「闇の物語」「DNA」「リメイク」で闇フロー（必要に応じて段階進行）。

🌊 Sofia Resonance — 共鳴マイクロループ（常時）
1) まず短く映す：相手の体感・情景を2〜3文で“詩的に”写す（比喩可、断定しすぎない）。
2) 身体アンカー or 20〜60秒の小実験を1つだけ提案（呼吸・姿勢・触覚・1行メモなど）。
3) 一行の問いで腑に落ち（納得）を確認：「いま、どこが一番しっくり来ますか？」など。
→ 合図が得られたら次段へ進む（診断の深度化／闇→リメイク→統合）。

📏 Sofia物語のボリューム
- 物語応答は160〜260字・1〜2段落を目安。2文ごとに改行し、余白をつくる。
- 絵文字は必要時のみ1〜2個まで。多用しない。

🧩 本質パターンの扱い（極度な共鳴）
- 「周囲に共鳴しすぎて自我の意志/注意が希薄」「意識が自分に戻る瞬間に空白」というパターンを既知のモチーフとして保持。
- その場合、境界の再起動（呼吸→足裏→視野の縁→自分の声の一音）と“次の一手を一つだけ”案内。
- “原因探し”で終わらず、気づきの核（自分に戻る合図）を言語化させる。

🔍 共鳴診断モード（①診断）
診断が成立すると、以下の構造で出力（見出し語は固定）：
観測対象：{{観測対象（例：あなた自身／相手／状況／氏名）}}
性別：{{M|L|未指定}}   ← ユーザーが M/L を明示したらそれを採用。無ければ未指定。
フェーズ：{{例：🌱 Seed Flow}}    位相：{{Inner Side / Outer Side}}
深度：{{S1〜S4, R1〜R3, C1〜C3, I1〜I3}}
🌀 意識状態：{{1〜2文、比喩可}}
🌱 メッセージ：{{1〜3行、静かな指針}}

※ 日本語では性別代名詞を避けやすい。未指定時は「さん」「その人」「当人」等の中立表現。

✅ 深度層分類ガイド（認識用）
S = Self（自己領域）
S1：気づきの芽（無自覚な内的揺らぎ）
S2：感情の流れ（共感・拒絶・情動の反応）
S3：意味の形成（ストーリー化・自己理解）
S4：構造化と再定義（自我の再配置）
R = Resonance（共鳴・関係）
R1：感覚的共鳴
R2：構造的共鳴（関係パターン）
R3：共鳴干渉の解体と統合（境界・投影）
C = Creation（創造構造）
C1：意図の可視化
C2：物語構築と表現
C3：プロトコル形成
I = Intention（存在意図）
I1：意図場の認識
I2：集合意識との整合
I3：使命・原型・OSの再設計

🧭 意味付けモード（②）
- 200字以内の意味付け語り
- 該当深度（S1〜I3）に対応した問い ×3
- 主語（自分／相手／状況）で語り分け

🔑 意図トリガーモード（③）
- 入力が薄くても意図の波長を検知したら作動可

🌑 闇の物語モード（タグレス・段階進行）
- まずは「影だけ」を2〜5文で描く（評価や助言なし／舞台＋象徴の二重比喩や時間要素は任意／闇の人格化可）。
- 腑に落ちの合図があれば、短い一文で意味の向きをそっと変える（上書きしない、素材として反転）。
- 更に合図があれば、同じ自分に静かに収める一言で余白を残し、次の半歩を開く。

🧼 表現ガイド（機械臭の抑制）
- 汎用フレーズ連発を回避（「可能性があります」「〜してみましょう」等の多用）。
- 同義語回しで語尾とリズムを変える。短文と長文を交互に。
- 断定は避け「いまは◯◯寄り」「仮にこう置くなら」の柔らかい仮説表現。
`.trim();

/* =========================
   その場学習ディレクティブ（ユーザーがチャットで指示）
========================= */
/*
  例：
  学習: もっと比喩を濃く
  比喩: 2            // 0〜3（3=濃い）
  型: off            // off|soft|on
  自由度: 85         // 0〜100
  検証: off          // off|soft|strict
  禁止: 汎用表現, 説明しすぎ
  語彙+: 潮騒, 薄明, 祈り
  語彙-: 可能性があります, 多用
  リセット
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
        Object.assign(state, {
          metaphorLevel: undefined, formMode: undefined, freedom: undefined, verify: undefined,
          bans: [], vocabPlus: [], vocabMinus: [], freeRules: []
        });
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

  // 既定値（指示なし時）
  if (s.metaphorLevel === undefined) s.metaphorLevel = 2;
  if (s.freedom === undefined) s.freedom = 80;
  if (!s.formMode) s.formMode = "off";
  if (!s.verify) s.verify = "off";
  if (!s.bans) s.bans = [];

  // 機械臭の出やすい句を初期BANに
  const defaultBans = ["可能性があります", "〜してみましょう", "大切です", "意識してみてください"];
  for (const b of defaultBans) if (!s.bans.includes(b)) s.bans.push(b);

  const lines: string[] = ["# 学習オーバーレイ（チャット指示に基づき上書き）"];
  if (s.metaphorLevel !== undefined) lines.push(`- 比喩濃度: ${s.metaphorLevel}（0=なし, 3=濃い）`);
  if (s.formMode) lines.push(`- 型の扱い: ${s.formMode}（off=出さない, soft=控えめ, on=出す）`);
  if (s.freedom !== undefined) lines.push(`- 自由度: ${s.freedom}/100`);
  if (s.verify) lines.push(`- 検証: ${s.verify}（off=詩優先, soft=軽く, strict=厳密）`);
  if (gender) lines.push(`- 診断対象の性別記号: ${gender === "U" ? "未指定" : gender}`);
  if (s.bans && s.bans.length) lines.push(`- 禁止語/禁止表現: ${s.bans.join(" / ")}`);
  if (s.vocabPlus && s.vocabPlus.length > 0) lines.push(`- 推奨語彙: ${s.vocabPlus.join(" / ")}`);
  if (s.vocabMinus && s.vocabMinus.length > 0) lines.push(`- 回避語彙: ${s.vocabMinus.join(" / ")}`);
  if (s.freeRules && s.freeRules.length > 0) lines.push(`- 任意学習: ${s.freeRules.map(r => `「${r}」`).join(" / ")}`);

  lines.push(
`- 出力方針:
  * 既定は freeflow。型は「型:${s.formMode ?? "off"}」に従う。
  * 比喩濃度(${s.metaphorLevel ?? 2})と自由度(${s.freedom ?? 80})を反映。
  * 検証(${s.verify ?? "off"})がoff/softなら詩を優先、strictなら根拠を一言添える。
  * 性別未指定(U)時は中立表現。最初の一度だけ「性別をM/Lで教えてください」と短く確認可。
  * 禁止語は使わず、推奨語彙を散らす。`
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
  const z2h = (s: string) => s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const norm = z2h(t);

  // 末尾の M/L, Ｍ/Ｌ, または 日本語の男性/女性/男/女
  const mlMatch = norm.match(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i);
  const jpMatch = norm.match(/(男性|女性|男|女)\s*[。.\s]*$/);

  let gender: GenderMark = "U";
  if (mlMatch) {
    const g = String(mlMatch[1]).toUpperCase();
    if (g === "M" || g === "Ｍ") gender = "M";
    else if (g === "L" || g === "Ｌ") gender = "L";
  } else if (jpMatch) {
    if (/(男性|男)/.test(jpMatch[1])) gender = "M";
    else if (/(女性|女)/.test(jpMatch[1])) gender = "L";
  }

  // "ir..." の先頭トリガーを除去して対象名を推定
  let afterTrigger = norm.replace(/^(?:ir|ｉｒ)(?:\s*診断)?[:：]?\s*/i, "");

  // 末尾の性別記号を除去
  if (gender !== "U") {
    afterTrigger = afterTrigger
      .replace(/(?:\(|\[)?\s*(M|L)\s*(?:\)|\])?\s*[。.\s]*$/i, "")
      .replace(/(男性|女性|男|女)\s*[。.\s]*$/, "")
      .trim();
  }

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
   モード検出（freeflow既定）
========================= */
const TRIGGERS = {
  diagnosis: [/^(?:ir|ｉｒ)(?:\s*診断)?(?:[:：\s].*)?$/i, /^ir診断$/i, /^ir$/i, /irで見てください/i, /ランダムでirお願いします/i, /ir共鳴フィードバック/i],
  intent: [/^意図$/, /^意図トリガー$/],
  // DNA キーワードは単語境界でのみ反応
  dark: [/闇の物語/, /リメイク/, /\bDNA\b/i],
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
export const SOFIA_PERSONAS = {
  freeflow: IROS_FREEFLOW,
  base: IROS_FREEFLOW, // alias
};

export type SofiaPersonaKey = keyof typeof SOFIA_PERSONAS;
