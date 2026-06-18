export function buildScreenshotDiagnosisSeed(args: {
  displayId: number;
  userText: string;
  diagnosisText: string;
}): string {
  const displayId = Math.trunc(args.displayId);
  const userText = String(args.userText ?? '').trim();
  const diagnosisText = String(args.diagnosisText ?? '').trim();

  return [
    'SCREENSHOT_DIAGNOSIS_FOLLOWUP_SEED (DO NOT OUTPUT):',
    'source=mu_screenshot_diagnosis_logs',
    `displayId=${displayId}`,
    `userText=${userText}`,
    'rule=このターンはスクショ診断IDの続き相談。ir診断/lastIrDiagnosisではなく、このスクショ診断を正本にする。',
    'contextMode=diagnosis_context',
    'contextAuthority=screenshot_diagnosis',
    'writerSourceAuthority=diagnosisText',
    'mustAnswer=true',
    'mustUseDiagnosisText=true',
    'mustUseConcreteTermsFromDiagnosisText=2',
    'questionsMax=0',
    'doNotAskWhichPart=true',
    'doNotAskUserToPasteAgain=true',
    'doNotEndWithContinuePrompt=true',
    'doNotUseSimilarFlow=true',
    'doNotUseHistoryForWriter=true',
    'doNotUseNormalResonance=true',
    '',
    'diagnosisText:',
    diagnosisText,
  ].join('\n').trim();
}
