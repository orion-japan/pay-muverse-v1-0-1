// src/lib/mu/imageFlow.ts
// Mu の画像生成フローをまとめる
import { MU_IMAGE, MU_BRIDGE_TEXT } from './config';

export type ImageGenRequest = {
  prompt: string;
  style?: '写実' | 'シンプル' | '手描き風';
};

export async function runImageGeneration(req: ImageGenRequest): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '(mock) 画像生成 — APIキー未設定';

  // プロンプトをスタイル付きで加工
  const stylePrefix = req.style ? `[スタイル: ${req.style}] ` : '';
  const fullPrompt = `${stylePrefix}${req.prompt}`;

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MU_IMAGE.MODEL_PRIMARY,
      size: MU_IMAGE.DEFAULT_SIZE,
      prompt: fullPrompt,
      n: 1,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return `(error) 画像生成失敗: ${detail}`;
  }

  const data = await resp.json();
  const url: string = data?.data?.[0]?.url ?? '';

  // UI 側でアルバム保存を担保 → ここでは文言だけ返す
  return `${MU_BRIDGE_TEXT.DONE_SAVED}\n${MU_BRIDGE_TEXT.PREVIEW_PREFIX}${url}`;
}
