// src/lib/iros/chatCore.ts
// IrosChat API 向けの薄いラッパー
// - 既存の generate.ts（シンプル Iros コア）をそのまま利用
// - types.ts の IrosChatRequest / IrosChatResponse と接続
// - layer: 'Surface' | 'Core' を簡易判定で付与

import type {
  IrosChatRequest,
  IrosChatResponse,
  IrosMode as UiMode,
  IrosMemory,
  IrosCredit,
} from './types';

import generate, {
  type IrosMode as CoreMode,
} from './generate';

// --- UI側モード → コア側モードの簡易マッピング ---
//   'surface' → 一般相談（counsel）
//   'core'    → 診断寄り（diagnosis）
//   'auto'    → generate.ts 側の検出に任せる
function mapUiModeToCore(mode?: UiMode): CoreMode | null {
  if (!mode || mode === 'auto') return null;
  if (mode === 'surface') return 'counsel';
  if (mode === 'core') return 'diagnosis';
  return null;
}

// layer 判定：とりあえず diagnosis を Core とみなす
function decideLayer(mode: CoreMode): 'Surface' | 'Core' {
  return mode === 'diagnosis' ? 'Core' : 'Surface';
}

// ざっくりしたメモリ要約（DB 保存版とは別の軽量ビュー）
// → IrosMemory 型に合わせて最低限の値を埋める
function makeMemorySnapshot(
  reply: string,
  coreMode: CoreMode,
): IrosMemory {
  const summary = reply.slice(0, 120);
  const last_keyword = summary.split(/\s|、|。/).filter(Boolean).slice(-1)[0] ?? '';

  const depth =
    coreMode === 'diagnosis'
      ? 'I1'
      : coreMode === 'structured'
      ? 'C1'
      : 'S1';

  const tone =
    coreMode === 'counsel'
      ? 'warm'
      : coreMode === 'structured'
      ? 'neutral'
      : 'light';

  const theme =
    coreMode === 'diagnosis'
      ? 'inner_mirror'
      : 'general';

  return {
    depth,
    tone,
    theme,
    summary,
    last_keyword,
  };
}

// クレジット情報はここではまだ本格運用しないのでダミー
function makeDummyCredit(): IrosCredit {
  return {
    ok: true,
    balance: -1,
    tx_id: 'local-dummy',
    error: null,
  };
}

/**
 * IrosChat API 用コア
 * - 既存の generate() を呼び出して、
 *   IrosChatResponse 形式に整形して返す。
 */
export async function generateIrosChat(
  req: IrosChatRequest,
): Promise<IrosChatResponse> {
  try {
    const coreModeHint = mapUiModeToCore(req.mode);

    const coreRes = await generate({
      conversationId: req.conversationId,
      text: req.userText,
      modeHint: coreModeHint ?? 'auto',
      extra: {
        // 将来ここに hintText や Qコードなどを渡せる
      },
    });

    const layer = decideLayer(coreRes.mode);
    const memory = makeMemorySnapshot(coreRes.text, coreRes.mode);
    const credit = makeDummyCredit();

    return {
      ok: true,
      reply: coreRes.text,
      layer,
      credit,
      memory,
    };
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : 'generateIrosChat: unknown error';
    return {
      ok: false,
      error: msg,
      code: 'IROSCHAT_INTERNAL',
    };
  }
}
