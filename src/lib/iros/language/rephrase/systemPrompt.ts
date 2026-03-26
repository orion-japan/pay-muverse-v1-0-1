// src/lib/iros/language/rephrase/systemPrompt.ts
// system prompt（IROS 核心先行版 / Markdown全文歓迎版）

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

export function systemPromptForFullReply(args?: {
  directTask?: boolean;
  itOk?: boolean;
  band?: { intentBand: string | null; tLayerHint: string | null } | null;
  lockedILines?: string[] | null;

  shiftKind?: string | null;
  inputKind?: string | null;

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
  const sofiaPersona = buildIdentityBlock();

  const baseRules = buildBaseRuleBlock();

  const formatRules = buildFormatRuleBlock();

  const questionTypeRules = buildQuestionTypeBlock(
    (questionTypeNow as 'meaning' | 'structure' | 'intent' | null) ?? null,
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

  const outputRules = buildOutputRuleBlock({
    linesMaxNow,
    questionsMaxNow,
    outputOnlyNow,
    askBackAllowedNow,
  });

  const lockRule =
    buildLockRuleText(args?.lockedILines ?? []);

    return [
      sofiaPersona,
      baseRules,
      formatRules,
      questionTypeRules,
      focusRules,
      personaStyle,
      outputRules,
      lockRule,
    ]
      .filter(Boolean)
      .join('\n');
  }
