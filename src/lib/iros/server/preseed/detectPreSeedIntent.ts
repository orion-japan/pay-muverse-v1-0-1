export type DetectedPreSeedIntent =
  | {
      kind: 'screenshot_diagnosis_boot';
      displayId: number;
      matchedPattern: string;
    }
  | {
      kind: 'normal_chat';
      matchedPattern: null;
    };

export function detectPreSeedIntent(userText: string): DetectedPreSeedIntent {
  const text = String(userText ?? '').trim();

  const compact = text.replace(/[ \t\r\n　]/g, '');

  const m =
    compact.match(/スクショ診断ID[:：]?(\d+)/u) ??
    compact.match(/スクショ診断(\d+)/u);

  if (m?.[1]) {
    const displayId = Number.parseInt(m[1], 10);

    if (Number.isFinite(displayId) && displayId > 0) {
      const isContinuationLike =
        /続き|相談|見て|みて|解説|詳しく|もう少し|この前|診断/u.test(compact);

      if (isContinuationLike) {
        return {
          kind: 'screenshot_diagnosis_boot',
          displayId,
          matchedPattern: 'screenshot_diagnosis_id_continuation',
        };
      }
    }
  }

  return {
    kind: 'normal_chat',
    matchedPattern: null,
  };
}
