export type VisionModelKey =
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'claude-haiku'
  | 'claude-sonnet'
  | 'gpt-4.1-mini';

export type AnalyzeScreenshotParams = {
  model: VisionModelKey;
  imageBase64: string;
  mimeType: string;
};

export type AnalyzeScreenshotResult = {
  text: string;
  model: VisionModelKey;
};

export type MuFirstAnalyzeResponse =
  | {
      ok: true;
      result: string;
      model: VisionModelKey;
      screenshotCreditRemaining: number;
    }
  | {
      ok: false;
      error: string;
    };

export type MuFirstStatusResponse =
  | {
      ok: true;
      screenshotCreditCount: number;
      firstScreenshotCompleted: boolean;
      firstScreenshotUsedAt: string | null;
    }
  | {
      ok: false;
      error: string;
    };
