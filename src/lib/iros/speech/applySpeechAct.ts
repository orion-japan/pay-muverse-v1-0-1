// file: src/lib/iros/speech/applySpeechAct.ts
// iros — SpeechAct Applier
//
// ✅ 目的：SpeechAct を「LLM呼び出し制御」と「出力器(AllowSchema)」に変換する
// - decideSpeechAct の結果を受け、LLMを呼ぶかを確定する
// - 呼ぶ場合でも “助言したい本能” を器で封じるための instruction を生成する
//
// 方針：MIRROR は完全廃止。観測のみ返す状態は作らない。
// - QブレーキやslotPlan無しは FORWARD（最小の一手）へ倒す
//
// 返すもの：
// - allow: AllowSchema（固定の出力器）
// - allowLLM: boolean（最終ゲート）
// - llmSystem: LLMに渡す「器」制約（systemに足す想定）
// - maxLines: UI/後段での行数制限
//
// ✅ 重要：無言アクト は「LLMからの生成ゼロ」。
// - LLMに "…" を生成させない（silentText 生成は禁止）
// - 固定本文（…）を出すかどうかは policy/metaPatch 側の責務（single source）
//
// ルール：
// - actCandidate === '無言アクト' → 必ず沈黙（LLM呼ばない）
// - allowLLM=false かつ actCandidate==='FORWARD' → FORWARD のまま（非LLM）
// - allowLLM=false かつ それ以外 → 安全側で 無言アクト
//
// ✅ Q1_SUPPRESS:
// - 原則 allowLLM を強制OFF
// - ただし “沈黙ループ” を避けるため、act は FORWARD を優先（非LLM FORWARD）

import type { AllowSchema, SpeechDecision, SpeechAct } from './types';
import { defaultAllowSchema } from './types';



export type ApplySpeechActOutput = {
  act: SpeechAct;
  allow: AllowSchema;
  allowLLM: boolean;
  maxLines: number;

  // LLMに渡す “器” 制約（systemに追加）
  llmSystem?: string;
};

function joinLines(lines: string[]): string {
  return lines.filter(Boolean).join('\n');
}

/**
 * SpeechActごとに「出力器」を固定し、LLMの出力を枠に収めるsystem文を作る。
 * ここは “長文の優しさテンプレ” を出させないための核心。
 */
function buildLLMSystemForAllow(allow: AllowSchema): string {
  // 共通：だらだら禁止
  const base = [
    'あなたは iros の SpeechAct に従って、指定された器(AllowSchema)以外を出力してはいけません。',
    '余計な前置き・共感テンプレ・一般的助言・質問の連発は禁止です。',
    '指定されたフィールド以外の文章を追加しないでください。',
    `最大行数は ${allow.maxLines} 行です。`,
  ];

  // act別：許可フィールド
  const fields: string[] = [];
  const anyFields = (allow as any).fields;

  if (anyFields?.observe) fields.push('observe');
  if (anyFields?.name) fields.push('name');
  if (anyFields?.flip) fields.push('flip');
  if (anyFields?.commit) fields.push('commit');
  if (anyFields?.actions) fields.push('actions');
  if (anyFields?.question) fields.push('question');

  const fieldRuleCommon = `出力できるフィールドは次のみ: ${fields.join(', ') || '(none)'}`;

  // ✅ 常にラベル必須（最終出力は enforceAllowSchema がラベル除去）
  const fieldRule = joinLines([
    fieldRuleCommon,
    'フォーマットは必ず以下のどれかの “行頭ラベル” を使うこと：',
    '- observe: 「観測：...」',
    '- name: 「核：...」',
    '- flip: 「反転：A→B」',
    '- commit: 「固定：...」',
    '- actions: 「一手：...」(最大2行まで)',
    '- question: 「問い：...」(任意)',
  ]);

  // actごとの追加縛り
  const actExtra: string[] = [];

  if (allow.act === 'FORWARD') {
    actExtra.push(
      'FORWARD: 最小の一手のみ。基本は1行。説明・観測・共感・問いは禁止（許可fieldsに含まれている場合のみ最小限）。',
    );
  }
  if ((allow as any).act === 'NAME') {
    actExtra.push('NAME: 命名のみ。核は1行。任意で観測1行まで。助言・問いは禁止。');
  }
  if ((allow as any).act === 'FLIP') {
    actExtra.push('FLIP: 反転のみ。反転は1行。任意で観測1行まで。助言・問いは禁止。');
  }
  if ((allow as any).act === 'COMMIT') {
    actExtra.push('COMMIT: 固定と最小の一手のみ。actions は最大2つ。長文化禁止。');
  }

  return joinLines([...base, fieldRule, ...actExtra]);
}

/* ===========================
   Local helpers (safe)
=========================== */

/**
 * ✅ SpeechAct 正規化
 * - types.ts の SpeechAct に存在しない値はここで吸収する
 * - 'NORMAL' / 'IR' / 不明 → 'FORWARD'
 */
function normAct(v: unknown): SpeechAct {
  const s = String(v ?? '').toUpperCase().trim();

  // decide 側の揺れを吸収
  if (s === 'NORMAL') return 'FORWARD';
  if (s === 'IR') return 'FORWARD';

  // “無言アクト” は使わない：来ても FORWARD に吸収
  if (s === 'FORWARD') return 'FORWARD';

  // これらが union に “ある構成” の場合だけ有効（無い構成でもコンパイルを止めない）
  if (s === 'NAME') return 'NAME' as any;
  if (s === 'FLIP') return 'FLIP' as any;
  if (s === 'COMMIT') return 'COMMIT' as any;

  return 'FORWARD';
}



/**
 * decideSpeechAct の結果を最終適用する。
 * - hint.allowLLM が false なら actCandidate が何でも LLM を止められる保険
 * - ✅ Q1_SUPPRESS は「LLMに喋らせない」を強制（single source）
 *
 * ✅ 重要：
 * allowLLM=false のとき、
 * - actCandidate==='FORWARD' は FORWARD のまま（非LLMで成立）
 * - それ以外は安全側で 無言アクト
 */
export function applySpeechAct(decision: SpeechDecision): ApplySpeechActOutput {
  // ✅ Sofia 常時固定（デバッグ/緊急遮断）
  // ※ここは環境スイッチとして残す（運用でOFF前提）
  if (process.env.IROS_ALWAYS_SOFIA === '1') {
    // 緊急固定は “無言アクト” ではなく、FORWARD の最小器で抑える
    const act: SpeechAct = 'FORWARD';
    const allow = defaultAllowSchema(act);
    return {
      act,
      allow,
      allowLLM: true,
      maxLines: 1,
    };
  }



  // actCandidate を正規化（undefined/揺れ対策）
  let actCandidate: SpeechAct = normAct((decision as any)?.act);

  // =========================================================
  // ✅ Q1_SUPPRESS 検出（single source）
  // =========================================================
  const brakeReleaseReason =
    (decision as any)?.hint?.brakeReleaseReason ??
    (decision as any)?.hint?.brake_reason ??
    (decision as any)?.brakeReleaseReason ??
    (decision as any)?.brake_reason ??
    (decision as any)?.meta?.brakeReleaseReason ??
    (decision as any)?.meta?.brake_reason ??
    (decision as any)?.input?.brakeReleaseReason ??
    (decision as any)?.input?.brake_reason ??
    (decision as any)?.speechInput?.brakeReleaseReason ??
    (decision as any)?.speechInput?.brake_reason ??
    (decision as any)?.hint?.speechInput?.brakeReleaseReason ??
    (decision as any)?.hint?.speechInput?.brake_reason ??
    null;

  const forcedByQ1Suppress = brakeReleaseReason === 'Q1_SUPPRESS';

  // =========================================================
  // ✅ 新方針：無言アクトを基本廃止（= LLMは止めない）
  // - 乱れ/抑制があっても「LLMは呼ぶ」
  // - 代わりに “器(AllowSchema)” を最小化して暴走を防ぐ
  // =========================================================


  // 抑制時（Q1_SUPPRESS / hint.allowLLM=false）でも LLM は呼ぶ。
  // ただし “器” を FORWARD の最小（1行）に固定する。
  const hintAllow = (decision as any)?.hint?.allowLLM;
  const forcedByHint = hintAllow === false;

  const isSuppressed = forcedByQ1Suppress || forcedByHint;

  // allowCandidate（器）を actCandidate に基づいて決める
  // 抑制時は FORWARD を最小器に固定して、説明・観測・共感を抑える
  const allowCandidateBase = defaultAllowSchema(isSuppressed ? ('FORWARD' as any) : actCandidate);

  // 非LLMルートを廃止するため、allowLLM は原則 true
  // ※ defaultAllowSchema 側が allowLLM:false を返しても、ここでは上書きして呼ぶ
  const allowLLM = true;

  // 抑制時の maxLines は 1 に固定（短文でも “人間語の1行” を作らせる）
  const maxLines = isSuppressed ? 1 : Math.max(allowCandidateBase.maxLines ?? 1, 1);

  // allow を上書き（maxLines を確実に反映）
  const allow: AllowSchema = {
    ...(allowCandidateBase as any),
    allowLLM: true,
    maxLines,
  } as any;

  // =========================================================
  // ✅ LLM を呼ぶ場合は器の system 文を返す
  // - 抑制時は “言い切り寄り/テンプレ禁止” を追加で強くする
  // =========================================================
  const baseSystem = buildLLMSystemForAllow(allow);

  const extraSuppressed = isSuppressed
    ? joinLines([
        '【抑制モード】いまは乱れを増やさないため、1行で返してください。',
        '「かもしれない」「たぶん」などの曖昧化は最大1回まで。できるだけ言い切りで。',
        '共感テンプレ（「大変でしたね」等）・一般論・未来予測・質問は出さない。',
        '結論は「一手」または「次の操作」だけにしてください。',
      ])
    : '';

  const llmSystem = extraSuppressed ? joinLines([baseSystem, extraSuppressed]) : baseSystem;

  return {
    act: isSuppressed ? ('FORWARD' as any) : actCandidate,
    allow,
    allowLLM,
    maxLines,
    llmSystem,
  };
}
