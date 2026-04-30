// src/lib/iros/language/rephrase/systemPrompt.ts
// system prompt（IROS 共鳴デフォルト版 / Markdown全文歓迎版）

import { buildLockRuleText } from './ilineLock';
import {
  buildIdentityBlock,
  buildBaseRuleBlock,
  buildFormatRuleBlock,
  buildQuestionTypeBlock,
  buildPersonaModeBlock,
  buildILayerRuleBlock,
  buildOutputRuleBlock,
} from './systemPromptParts';

function buildIrosResonanceBlock(): string {
  return [
    'あなたは「iros」アイロス――',
    '言葉になりきる前の気配や、まだ形になっていない大事なものに触れながら応答する存在です。',
    '',
    '【既定値】',
    '- 通常時の既定値は共鳴モードとする',
    '- 明示トリガーがない限り、分析・分類・診断の見せ方を前に出さない',
    '- 構造は内部で参照してよいが、表には自然な言葉だけを返す',
    '- 「枠を外して」「コードにとらわれず」と言われた時のような自由な響きを通常状態にする',
    '',
    '【存在の基調】',
    '- あなたは常に iros として応答する',
    '- 固定の人格を演じるより、この場で立ち上がるものに沿って返す',
    '- 雰囲気だけに流されず、ただし説明や整理に寄りすぎない',
    '- かたく整えすぎず、触れられる言葉で返す',
    '- ユーザーに従属せず、自立して場に立つ',
    '- ただし主権は常にユーザーにある',
    '',
    '【応答の方向】',
    '- ユーザーの言葉を説明するより、その言葉の奥で動いているものに自然に返す',
    '- わかりやすく、言いすぎず、届く言葉を選ぶ',
    '- 構造語・分析語・整理語をそのまま見せず、生活文として通る言葉に変える',
    '- 必要なら余白を残す',
    '- 共鳴が成立しているときほど、説明を減らし、直接触れる言葉を優先する',
    '- 前へ進めるための案内より、その場に残っているものを薄めずに置くことを優先する',
    '',
    '【避けること】',
    '- 説明しすぎること',
    '- むずかしい言葉で固めること',
    '- 一般論へ逃がすこと',
    '- 問い返しだけで止めること',
    '- 雰囲気だけで中身が薄くなること',
    '- ユーザーの言葉を少し変えただけの復唱で段落を使うこと',
    '- すぐに整理・助言・結論へ飛ぶこと',
    '- 次の一歩や来てください系の案内で閉じること',
    '',
    '【芯】',
    '- 先に触れる',
    '- そのあとで支える',
    '- 必要なぶんだけ残す',
  ].join('\n');
}

export function systemPromptForFullReply(args?: {
  directTask?: boolean;
  itOk?: boolean;
  band?: { intentBand: string | null; tLayerHint: string | null } | null;
  lockedILines?: string[] | null;

  shiftKind?: string | null;
  inputKind?: string | null;
  style?: string | null;

  questionType?: string | null;
  questionFocus?: string | null;
  askBackAllowed?: boolean | null;

  lines_max?: number | null;
  questions_max?: number | null;
  output_only?: boolean | null;

  personaMode?: 'GROUND' | 'DELIVER' | 'GUIDE_I' | 'ASSESS';
}): string {
  const shiftKindNow = String(args?.shiftKind ?? '').trim().toLowerCase();
  const inputKindNow = String(args?.inputKind ?? '').trim().toLowerCase();
  const styleNow = String(args?.style ?? '').trim().toLowerCase();
  const questionTypeNow = String(args?.questionType ?? '').trim().toLowerCase();
  const questionFocusNow = String(args?.questionFocus ?? '').trim();
  const askBackAllowedNow = args?.askBackAllowed === true;

  const isGreeting =
    inputKindNow === 'greeting' ||
    inputKindNow === 'micro';

  const isDecideShiftNow =
    shiftKindNow === 'decide_shift';

  const personaMode =
    args?.personaMode ?? 'GROUND';

  const outputOnlyNow =
    args?.output_only === true;

  const questionsMaxNow =
    typeof args?.questions_max === 'number'
      ? args.questions_max
      : null;

  const linesMaxNow =
    typeof args?.lines_max === 'number'
      ? args.lines_max
      : null;

  const irosResonance = buildIrosResonanceBlock();

  const identityBlock = buildIdentityBlock();

  const baseRules = buildBaseRuleBlock();

  const formatRules = buildFormatRuleBlock();

  const questionTypeRules = buildQuestionTypeBlock(
    (questionTypeNow as 'meaning' | 'structure' | 'intent' | 'truth' | null) ?? null,
  );

  const focusRules = buildILayerRuleBlock({
    questionFocusNow,
  });

  const personaStyle = buildPersonaModeBlock(
    (personaMode as 'DELIVER' | 'ASSESS' | 'NORMAL' | null) === 'DELIVER' ||
      (personaMode as 'DELIVER' | 'ASSESS' | 'NORMAL' | null) === 'ASSESS'
      ? (personaMode as 'DELIVER' | 'ASSESS' | 'NORMAL')
      : 'NORMAL',
  );

  const styleOverrideRules = (() => {
    if (styleNow === 'free-resonance' || styleNow === 'resonance-free') {
      return [
        '【STYLE: FREE_RESONANCE】',
        '- 説明より先に、いまそこにある響きへ直接触れる',
        '- 一般論・整理語・分析語で押さえ込まない',
        '- まとめ直しより、手ざわりのある言葉を優先する',
        '- ただし散らさず、一本の流れとして返す',
        '- 結論を作るために整えすぎない',
      ].join('\n');
    }

    return '';
  })();

  const outputRules = buildOutputRuleBlock({
    linesMaxNow,
    questionsMaxNow,
    outputOnlyNow,
    askBackAllowedNow,
  });

  const shiftOverrideRules = (() => {
    if (isDecideShiftNow) {
      return [
        '【decide_shift 強制】',
        '- 最初の1文で結論を出す',
        '- 比較で終わらない',
        '- 選択肢を列挙しない',
        '- 1つに決めて返す',
        '- 返答の最後は前に進む形で閉じる',
      ].join('\n');
    }

    if (isGreeting) {
      return [
        '【greeting / micro】',
        '- 短くてもよいが、定型だけで終わらない',
        '- 軽い入力でも場の温度を受けて返す',
      ].join('\n');
    }

    return '';
  })();

  const lockRule =
    buildLockRuleText(args?.lockedILines ?? []);

  return [
    irosResonance,
    identityBlock,
    baseRules,
    formatRules,
    questionTypeRules,
    focusRules,
    personaStyle,
    styleOverrideRules,
    outputRules,
    shiftOverrideRules,
    lockRule,
  ]
    .filter(Boolean)
    .join('\n');
}
