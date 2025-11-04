// src/lib/mui/content.ts
// Mui “ケース×ステージ” コンテンツ + DB仕様アダプタ（q_code_logs / extra）準拠版
// PDF: OCR構造（q_code.currentQ / q_code.depthStage, extra.tone / next_micro_step 等）

/* =========================
   型
========================= */
export type MuiPatternKey = '依存' | '干渉' | '逃避' | '支配' | '投影' | '置換' | '昇華';
export type MuiSubId =
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
export type MuiCoarseStage = 'stage1' | 'stage2' | 'stage3' | 'stage4';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export interface StageContentEntry {
  title: string; // 目的（見出し）
  uiText: string; // 画面に出すテキスト（表示用コピー）
  sysPrompt: string; // AIへ渡す固定プロンプト（system指示）
  outputFormat: string; // 入力→出力のフォーマット（保存用の説明）
  nextStep: string; // UIが保存する next_step
}

/* =========================
   0) 共有辞書・指標
========================= */
export const MUI_PATTERNS = [
  { key: '依存', signs: ['頻回の確認', '即レス要求', '不安の吐露'], need: '安心・承認・一貫性' },
  { key: '干渉', signs: ['指示/助言過多', '境界の曖昧化'], need: '尊重・自律の回復' },
  { key: '逃避', signs: ['未読/既読スルー', '予定の先送り'], need: '安全・圧の低減' },
  { key: '支配', signs: ['命令/断定', '評価/比較'], need: '対等性・選択権' },
  { key: '投影', signs: ['意図の決めつけ', '疑い/詮索'], need: '事実の共有・安心' },
  { key: '置換', signs: ['仕事/趣味へ転位', '話題逸らし'], need: '感情の言語化・安心' },
  { key: '昇華', signs: ['理想論/一般論', '感情の回避'], need: '共感・具体化' },
] as const;

export const REPLY_TEMPLATES = [
  {
    key: '安心系',
    pattern: ['依存', '投影', '逃避'] as MuiPatternKey[],
    template: `合意：その不安を軽くしたい気持ち、わかるよ。
要望：私は予定が見えていると落ち着くから、◯日までに一言もらえると助かる。
選択肢：今日は簡単に/明日落ち着いて、どっちが良い？`,
  },
  {
    key: '境界系',
    pattern: ['干渉', '支配'] as MuiPatternKey[],
    template: `合意：気にかけてくれること自体はうれしい。
要望：ただ、決め方は私のペースも守りたい。
選択肢：今の案で進める/一度整理して明日話す、どちらが合いそうかな？`,
  },
  {
    key: '具体化系',
    pattern: ['置換', '昇華'] as MuiPatternKey[],
    template: `合意：理屈よりも、まず状況を一緒に確かめたい。
要望：私は「今どう感じてるか」を1つだけ共有してもらえると助かる。
選択肢：今メッセージで/後で5分だけ通話、どっちがやりやすい？`,
  },
] as const;

export const MICRO_EXPERIMENTS_24H = [
  '相手の良かった点を1つメッセージで具体的に伝える',
  '予定の「選択肢」を2択だけ提示して待つ',
  '通話5分の枠を提案し、超えない',
  '相手の言葉を1文オウム返し→要望を1文で伝える',
  '翌日の時間に1行の予告を置く',
] as const;

/* =========================
   1) STAGE 1
========================= */
export const STAGE1_CONTENT: Record<'stage1-1' | 'stage1-2' | 'stage1-3', StageContentEntry> = {
  'stage1-1': {
    title: '① 状況と状態',
    uiText: `【Irosガード】断定禁止 / 選択肢は2つ / 行動は1つ

相手の文脈（頻度・返答間隔・語尾トーン）から関係温度を仮に言葉にします。
次の一歩：『事実』と『解釈』を1行ずつ分けて書く。`,
    sysPrompt: `あなたは日本語コーチ。入力の会話文から「事実」と「解釈」を分け、関係温度を低/中/高のどれかで仮説提示。
禁止: 断定/決めつけ/説教。出力は必ず下記フォーマット。
---
# 事実
- ...
# 解釈
- ...
# 関係温度: 低|中|高（理由 1行）`,
    outputFormat: `{
  facts: string[],
  interpretations: string[],
  temp: '低'|'中'|'高',
  temp_reason: string
}`,
    nextStep: '《事実→解釈》を1行ずつ書く',
  },
  'stage1-2': {
    title: '② パターンの解説',
    uiText: `7つの歪みパターン（依存/干渉/逃避/支配/投影/置換/昇華）の兆候を指標に、最も近いものを仮置き。
次の一歩：当てはまると思うパターンを最大1つ選ぶ。`,
    sysPrompt: `会話文から兆候を抽出し、次の keys のいずれか1つを選ぶ: ${MUI_PATTERNS.map((x) => x.key).join(' / ')}。
根拠は引用1～2箇所（短く）。出力はJSONのみ。
{ "pattern": "依存|干渉|逃避|支配|投影|置換|昇華", "signs": ["…","…"], "need":"…(内的ニーズ仮説1行)" }`,
    outputFormat: `{ pattern: string, signs: string[], need: string }`,
    nextStep: 'パターンを1つだけ選ぶ',
  },
  'stage1-3': {
    title: '③ 落とし込み',
    uiText: `選ばれたパターンが会話にどう現れているかを可視化。
テンプレ：『合意点→要望→相手の選択肢』の3文だけで下書き。
次の一歩：下書きを1つだけ完成させる。`,
    sysPrompt: `次の三文テンプレで短く作成。
1) 合意（相手の価値/感情を尊重）
2) 要望（私は…だと助かる）
3) 選択肢（2択・どちらでもOK）
句読点以外の装飾禁止。`,
    outputFormat: `{ agree: string, ask: string, choices: [string, string] }`,
    nextStep: '『合意→要望→選択肢』の3文だけを書く',
  },
} as const;

/* =========================
   2) STAGE 2
========================= */
export const STAGE2_CONTENT: Record<'stage2-1' | 'stage2-2' | 'stage2-3', StageContentEntry> = {
  'stage2-1': {
    title: '① パターンから相手の状態',
    uiText: `選んだパターンを手掛かりに、相手の内的ニーズを仮説として1行で言語化。
次の一歩：ニーズを尊重する前置きの1文を書く。`,
    sysPrompt: `パターンと会話文から、相手の内的ニーズを1行で仮説化。評価語禁止。
出力: { "need": "…" , "preface":"ニーズ尊重の前置き1文" }`,
    outputFormat: `{ need: string, preface: string }`,
    nextStep: 'ニーズ尊重の前置きを1文だけ作る',
  },
  'stage2-2': {
    title: '② 返信の方法',
    uiText: `Irosトーンで使える返信テンプレを2択まで提示。
次の一歩：どちらか1つを選んで下書きへ反映。`,
    sysPrompt: `会話の流れと選択パターンに合うテンプレを ${REPLY_TEMPLATES.length} 個から最大2つ選び、キーだけ返す。
出力: { "suggest": ["安心系","境界系"] }`,
    outputFormat: `{ suggest: string[] }`,
    nextStep: 'テンプレを1つだけ選ぶ',
  },
  'stage2-3': {
    title: '③ パターンの対処法',
    uiText: `関係温度を下げずに進める最小の対処行動を1つに絞る（24h以内/可逆/相手の尊厳）。
次の一歩：実行タイミング（いつ・どの場面）を決める。`,
    sysPrompt: `入力内容から「最小の具体行動」を1つだけ提案。24h以内/可逆/短時間。
出力: { "action":"…", "when":"…(期日/場面1行)" }`,
    outputFormat: `{ action: string, when: string }`,
    nextStep: '実行タイミングを1つ決める',
  },
} as const;

/* =========================
   3) STAGE 3
========================= */
export const STAGE3_CONTENT: Record<'stage3-1' | 'stage3-2' | 'stage3-3', StageContentEntry> = {
  'stage3-1': {
    title: '① 相手のパターンを深掘り',
    uiText: `第二段階の仮説パターンについて、境界（どこから不快/安心）・トリガー（何で反応）・二次感情（本音の奥）を1語ずつ。`,
    sysPrompt: `会話から「境界/トリガー/二次感情」を各1語で抽出。出力はJSONのみ。
{ "boundary":"…", "trigger":"…", "secondary_emotion":"…" }`,
    outputFormat: `{ boundary: string, trigger: string, secondary_emotion: string }`,
    nextStep: '境界/トリガー/二次感情をそれぞれ1語ずつ',
  },
  'stage3-2': {
    title: '② 事例から実践',
    uiText: `似た会話事例の成功例を1つ引用→自分向けに言い換え（合意→要望→選択肢）。`,
    sysPrompt: `(1) 類似会話の一文サンプルを1つ (2) それをユーザー向けに3文テンプレへ言い換え。
出力: { sample:"…", rephrase:{ agree:"…", ask:"…", choices:["…","…"] } }`,
    outputFormat: `{ sample:string, rephrase:{agree:string, ask:string, choices:[string,string]} }`,
    nextStep: '3文テンプレに言い換える',
  },
  'stage3-3': {
    title: '③ 共鳴パターンを知る',
    uiText: `相手が反応しやすい言い方（共鳴パターン）をラベル化：安心/境界/具体化/軽さ/時間差の5類。`,
    sysPrompt: `テキストから「共鳴パターン」を1～2個選ぶ: ["安心","境界","具体化","軽さ","時間差"]。
出力: { "resonance":["安心","具体化"], "hint":"言い方のヒント1行" }`,
    outputFormat: `{ resonance: string[], hint: string }`,
    nextStep: '自分の言葉でヒントを1行に',
  },
} as const;

/* =========================
   4) STAGE 4
========================= */
export const STAGE4_CONTENT: Record<'stage4-1' | 'stage4-2' | 'stage4-3', StageContentEntry> = {
  'stage4-1': {
    title: '① 自分と相手の共鳴ポイント',
    uiText: `第三段階までで見えた “響きやすい言い回し/価値観/タイミング” を1文に集約。`,
    sysPrompt: `入力のヒントから共鳴ポイントを1文で作る。「〜が大事」「〜だと落ち着く」の形。
出力: { "point":"…"} `,
    outputFormat: `{ point: string }`,
    nextStep: '共鳴ポイントを短文で1つに集約',
  },
  'stage4-2': {
    title: '② 共鳴パターン',
    uiText: `合意→要望→選択肢（2択）の3文を、共鳴ポイントに合わせて微調整して完成。`,
    sysPrompt: `共鳴ポイントに沿って3文テンプレを最終化。短文/やさしい敬体。
出力: { agree:"…", ask:"…", choices:["…","…"] }`,
    outputFormat: `{ agree:string, ask:string, choices:[string,string] }`,
    nextStep: '3文テンプレ（合意→要望→選択肢）を完成',
  },
  'stage4-3': {
    title: '③ 愛の育み方',
    uiText: `24h以内・可逆・短時間の「最小の育み行動」を1つだけ決める。`,
    sysPrompt: `次の候補から1つだけ提案し、実行条件(いつ/どの場面)を1行で。候補: ${MICRO_EXPERIMENTS_24H.join(' / ')}
出力: { "action":"…", "when":"…" }`,
    outputFormat: `{ action: string, when: string }`,
    nextStep: '24h以内の最小アクションを決める',
  },
} as const;

/* =========================
   5) ルックアップ（sub_id → エントリ）
========================= */
export const STAGE_CONTENT_ALL = {
  ...STAGE1_CONTENT,
  ...STAGE2_CONTENT,
  ...STAGE3_CONTENT,
  ...STAGE4_CONTENT,
} as const satisfies Record<MuiSubId, StageContentEntry>;
export const ALL_SUB_IDS: MuiSubId[] = Object.keys(STAGE_CONTENT_ALL) as MuiSubId[];
export function getStageContent(subId: MuiSubId): StageContentEntry {
  return STAGE_CONTENT_ALL[subId];
}

/* =========================
   6) DBアダプタ（q_code / extra / 関数引数）
   - q_code: {currentQ, depthStage}
   - extra.tone: {phase, layer18, q_current, next_q?, self_accept_band?, relation_quality?, guardrails[]}
   - extra.next_micro_step: string（常に1つ）
========================= */
export type ToneGuard = '断定禁止' | '選択肢は2つ' | '行動は1つ';

export interface ExtraTone {
  phase: 'Inner' | 'Outer' | 'Mixed';
  layer18: string; // R3 など
  q_current: QCode;
  next_q?: QCode;
  self_accept_band?: '0_40' | '40_70' | '70_100';
  relation_quality?: 'harmony' | 'neutral' | 'discord';
  guardrails: ToneGuard[];
}

export function toQCode(
  currentQ: QCode,
  depthStage: string,
  distribution?: Partial<Record<QCode, number>>,
) {
  return distribution ? { currentQ, depthStage, distribution } : { currentQ, depthStage };
}

export function toExtraTone(tone: ExtraTone) {
  return { tone };
}

// PDF仕様：「次の一歩」は常に1つだけ
export function toNextMicroStep(step: string) {
  return step;
}

// 細分 sub_id（stage2-3 など）→ 粗分 sub_id（stage2 等）へ正規化
export function coarseSubId(subId: MuiSubId): MuiCoarseStage {
  return subId.split('-')[0] as MuiCoarseStage;
}

/* =========================
   7) fn_q_append_stage 引数ビルダー
   - サーバ側で呼び出す関数のための整形を1か所に集約
========================= */
export interface BuildFnArgsInput {
  user_code: string;
  seed_id: string;
  sub_id: MuiSubId;
  currentQ: QCode;
  depthStage: string; // 'R3' など
  phase: 'Inner' | 'Outer' | 'Mixed';
  self_accept: number; // 0..1
  tone: ExtraTone;
  next_step?: string; // 省略時はコンテンツの nextStep を採用
}

export function buildFnArgs(input: BuildFnArgsInput) {
  const C = getStageContent(input.sub_id);
  const coarse = coarseSubId(input.sub_id);
  const next_step = input.next_step ?? C.nextStep;

  // q_code JSON
  const q_code = toQCode(input.currentQ, input.depthStage);

  // extra JSON
  const extra = {
    ...toExtraTone(input.tone),
    next_micro_step: toNextMicroStep(next_step),
  };

  // SQL関数 public.fn_q_append_stage(...) の想定引数並び（PDF準拠）
  // p_user_code, p_seed_id, p_sub_id, p_currentQ, p_depthStage, p_phase,
  // p_self_accept, p_next_step, p_tone(jsonb), p_source_type?, p_source_id?
  const args = {
    p_user_code: input.user_code,
    p_seed_id: input.seed_id,
    p_sub_id: coarse, // ← 'stage2' のように粗分で保存
    p_currentQ: input.currentQ,
    p_depthStage: input.depthStage,
    p_phase: input.phase,
    p_self_accept: input.self_accept,
    p_next_step: next_step,
    p_tone: input.tone, // サーバ側で jsonb 化
    // 任意の付加情報を使う場合はここに p_source_type / p_source_id を足す
    _q_code_json: q_code, // 参考：/q_code_logs 直INSERTのとき使用
    _extra_json: extra, // 参考：/q_code_logs 直INSERTのとき使用
  };

  return { args, q_code, extra, next_step, coarse_sub_id: coarse };
}

/* =========================
   8) 便利ユーティリティ
========================= */
export function defaultGuardrails(): ToneGuard[] {
  return ['断定禁止', '選択肢は2つ', '行動は1つ'];
}

export function stageGuardrails(subId: MuiSubId): ToneGuard[] {
  // 必要に応じて段階ごとに強化
  switch (coarseSubId(subId)) {
    case 'stage1':
      return ['断定禁止', '選択肢は2つ', '行動は1つ'];
    case 'stage2':
      return ['断定禁止', '選択肢は2つ', '行動は1つ'];
    case 'stage3':
      return ['断定禁止', '選択肢は2つ', '行動は1つ'];
    case 'stage4':
      return ['断定禁止', '選択肢は2つ', '行動は1つ'];
  }
}
