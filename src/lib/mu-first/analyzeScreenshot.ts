import type { AnalyzeScreenshotParams, AnalyzeScreenshotResult } from './types';
import { analyzeWithClaude } from './providers/claude';
import { analyzeWithGemini } from './providers/gemini';
import { analyzeWithOpenAI } from './providers/openai';

export async function analyzeScreenshot(
  params: AnalyzeScreenshotParams,
): Promise<AnalyzeScreenshotResult> {
  const { model } = params;

  switch (model) {
    case 'gemini-2.5-flash':
    case 'gemini-2.5-flash-lite':
      return analyzeWithGemini(params);

    case 'claude-haiku':
    case 'claude-sonnet':
      return analyzeWithClaude(params);

    case 'gpt-4.1-mini':
      return analyzeWithOpenAI(params);

    default: {
      const neverModel: never = model;
      throw new Error(`Unsupported model: ${neverModel}`);
    }
  }
}
