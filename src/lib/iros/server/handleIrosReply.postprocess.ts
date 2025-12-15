// file: src/lib/iros/server/handleIrosReply.postprocess.ts
// iros - Postprocess (minimal first)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';

export type PostProcessReplyArgs = {
  supabase: SupabaseClient;
  userCode: string;
  conversationId: string;
  userText: string;

  effectiveStyle: IrosStyle | string | null;
  requestedMode: string | undefined;

  orchResult: any;
};

export type PostProcessReplyOutput = {
  assistantText: string;
  metaForSave: any;
};

export async function postProcessReply(
  args: PostProcessReplyArgs,
): Promise<PostProcessReplyOutput> {
  const { orchResult } = args;

  // orchestrator の返しから本文抽出（content/text が無い場合は JSON 化）
  const assistantText: string =
    orchResult && typeof orchResult === 'object'
      ? (() => {
          const r: any = orchResult;
          if (typeof r.content === 'string' && r.content.trim().length > 0)
            return r.content;
          if (typeof r.text === 'string' && r.text.trim().length > 0) return r.text;
          return JSON.stringify(r);
        })()
      : String(orchResult ?? '');

  // meta は result.meta をそのまま保存（なければ null）
  const metaRaw =
    orchResult && typeof orchResult === 'object' && (orchResult as any).meta
      ? (orchResult as any).meta
      : null;

  const metaForSave = metaRaw && typeof metaRaw === 'object' ? { ...metaRaw } : metaRaw;

  return { assistantText, metaForSave };
}
