// Mu 用のセーフティ／バリデーション文言とチェック関数

import { MU_SAFETY, MU_TONE_RULES } from '@/lib/mu/config';

/** セーフティカテゴリ */
export type SafetyCategory = 'medical' | 'legal' | 'finance' | 'minor' | 'other';

/** セーフティ警告文を返す */
export function safetyNotice(cat: SafetyCategory): string {
  switch (cat) {
    case 'medical':
      return MU_SAFETY.MEDICAL;
    case 'legal':
      return MU_SAFETY.LEGAL;
    case 'finance':
      return MU_SAFETY.FINANCE;
    case 'minor':
      return MU_SAFETY.MINOR;
    default:
      return '一般情報としてご参考ください。必要に応じて専門家にご確認ください。';
  }
}

/** トーン／形式ルールの確認結果 */
export type ToneCheckResult = {
  tooManyReasons: boolean;
  tooManyCautions: boolean;
  tooManyQuestions: boolean;
};

/** 出力テキストを簡易チェック（理由・注意点・質問数の超過検知） */
export function checkToneAndLimits(text: string): ToneCheckResult {
  const reasons = (text.match(/理由/g) || []).length;
  const cautions = (text.match(/注意/g) || []).length;
  const questions = (text.match(/？|\?/g) || []).length;

  return {
    tooManyReasons: reasons > MU_TONE_RULES.MAX_REASON,
    tooManyCautions: cautions > MU_TONE_RULES.MAX_CAUTIONS,
    tooManyQuestions: questions > MU_TONE_RULES.MAX_FOLLOWUP_QUESTIONS,
  };
}

/** 日本語トーン統一チェック（ですます調かどうか） */
export function enforcePoliteness(text: string): boolean {
  // 簡易判定：文末が「です」「ます」「でした」「ました」で終わる割合が高いか
  const sentences = text.split(/[\n。！？]/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) return true;

  const politeEndings = sentences.filter((s) => /(です|ます|でした|ました)$/.test(s.trim()));

  return politeEndings.length / sentences.length >= 0.6;
}
