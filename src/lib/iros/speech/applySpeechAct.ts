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
// ✅ 重要：SILENCE は「完全無出力」。
// - silentText（"…"）は禁止
// - allowLLM=false の場合も SILENCE に収束させる（下流の誤解を防ぐ）

import type { AllowSchema, SpeechDecision, SpeechAct } from './types';
import { defaultAllowSchema } from './types';

// ✅ ラベル(観測/核/反転/一手/問い)を “LLM出力に要求するか” のスイッチ
// - 1: 従来通りラベル必須
// - 0/未設定: ラベル禁止（中身だけ出す）
const KEEP_SLOT_LABELS = process.env.IROS_KEEP_SLOT_LABELS === '1';

console.log('[IROS/SpeechAct][env]', {
  IROS_ALWAYS_SOFIA: process.env.IROS_ALWAYS_SOFIA,
  IROS_KEEP_SLOT_LABELS: process.env.IROS_KEEP_SLOT_LABELS,
});

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

  if (allow.act === 'SILENCE') {
    // ここは通常使われない（LLM呼ばない）
    return joinLines([...base, 'SILENCE: 何も生成しないでください。']);
  }

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

  // ✅ ラベル方針：KEEP_SLOT_LABELS=1 のときだけ「行頭ラベル」を要求
  const fieldRule = KEEP_SLOT_LABELS
    ? joinLines([
        fieldRuleCommon,
        'フォーマットは必ず以下のどれかの “行頭ラベル” を使うこと：',
        '- observe: 「観測：...」',
        '- name: 「核：...」',
        '- flip: 「反転：A→B」',
        '- commit: 「固定：...」',
        '- actions: 「一手：...」(最大2行まで)',
        '- question: 「問い：...」(任意)',
      ])
    : joinLines([
        fieldRuleCommon,
        'フォーマットはラベル禁止。行頭に「観測：/核：/反転：/固定：/一手：/問い：」を付けない。',
        '各行は “中身だけ” を出力すること（例：一手の文だけ）。',
      ]);

  // actごとの追加縛り
  const actExtra: string[] = [];

  if (allow.act === 'FORWARD') {
    actExtra.push(
      'FORWARD: 最小の一手のみ。基本は1行。説明・観測・共感・問いは禁止（許可fieldsに含まれている場合のみ最小限）。',
    );
  }
  if (allow.act === 'NAME') {
    actExtra.push('NAME: 命名のみ。核は1行。任意で観測1行まで。助言・問いは禁止。');
  }
  if (allow.act === 'FLIP') {
    actExtra.push('FLIP: 反転のみ。反転は1行。任意で観測1行まで。助言・問いは禁止。');
  }
  if (allow.act === 'COMMIT') {
    actExtra.push('COMMIT: 固定と最小の一手のみ。actions は最大2つ。長文化禁止。');
  }

  return joinLines([...base, fieldRule, ...actExtra]);
}

/**
 * decideSpeechAct の結果を最終適用する。
 * - hint.allowLLM が false なら act が何でも LLM を止められる保険
 * - ✅ Q1_SUPPRESS は「LLMに喋らせない」を強制（single source）
 *
 * ✅ 重要：
 * allowLLM=false のときは act を SILENCE に収束させる。
 * （下流が act を見て「沈黙じゃない」と誤解するのを防ぐ）
 */
export function applySpeechAct(decision: SpeechDecision): ApplySpeechActOutput {
  // ✅ Sofia 常時固定（最短・最終ゲート）
  if (process.env.IROS_ALWAYS_SOFIA === '1') {
    const act: SpeechAct = 'SILENCE';
    const allow = defaultAllowSchema(act);
    return {
      act,
      allow,
      allowLLM: false,
      maxLines: 1,
    };
  }

  const actCandidate = decision.act;
  const allowCandidate = defaultAllowSchema(actCandidate);

  // =========================================================
  // ✅ Q1_SUPPRESS 強制OFF（ここが本丸）
  // - 実際のログでは speechInput.brakeReleaseReason に入っている
  // - なので decision.input / decision.speechInput 系も拾う
  // =========================================================
  const brakeReleaseReason =
    // hint / meta / 直下
    (decision as any)?.hint?.brakeReleaseReason ??
    (decision as any)?.hint?.brake_reason ??
    (decision as any)?.brakeReleaseReason ??
    (decision as any)?.brake_reason ??
    (decision as any)?.meta?.brakeReleaseReason ??
    (decision as any)?.meta?.brake_reason ??

    // ✅ 追加：input に入るケース（今回これ）
    (decision as any)?.input?.brakeReleaseReason ??
    (decision as any)?.input?.brake_reason ??

    // ✅ 追加：speechInput に入るケース（今回これ）
    (decision as any)?.speechInput?.brakeReleaseReason ??
    (decision as any)?.speechInput?.brake_reason ??
    (decision as any)?.hint?.speechInput?.brakeReleaseReason ??
    (decision as any)?.hint?.speechInput?.brake_reason ??
    null;

  const forcedOffByQ1Suppress = brakeReleaseReason === 'Q1_SUPPRESS';

  // 最終 allowLLM
  const forcedOff = decision.hint?.allowLLM === false || forcedOffByQ1Suppress;
  const allowLLM = !forcedOff && allowCandidate.allowLLM === true;

  // =========================================================
  // ✅ SILENCE or allowLLM=false は “完全沈黙” に収束
  // =========================================================
  if (actCandidate === 'SILENCE' || allowLLM === false) {
    const act: SpeechAct = 'SILENCE';
    const allow = defaultAllowSchema(act);
    return {
      act,
      allow,
      allowLLM: false,
      maxLines: 1,
    };
  }

  // LLM を呼ぶ場合は器の system 文を返す
  const llmSystem = buildLLMSystemForAllow(allowCandidate);

  return {
    act: actCandidate,
    allow: allowCandidate,
    allowLLM: true,
    maxLines: allowCandidate.maxLines,
    llmSystem,
  };
}
