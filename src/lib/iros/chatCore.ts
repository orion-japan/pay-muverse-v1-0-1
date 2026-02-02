// src/lib/iros/chatCore.ts
// IrosChat API 向けの薄いラッパー（V2）
// ✅ 方針：chatCore は「旧 generate.ts」を呼ばない
// - 役割：UIリクエストを Orchestrator（runIrosTurn）に渡して meta を確定させる
// - 本文生成は render-v2 が唯一の生成者（reply は空文字を返す：互換のため）
//
// NOTE:
// - IrosChatRequest に sb / userCode が無い環境でも動くように “null-safe” にしてある。
// - sb が無い場合：Orchestrator が resolveBaseMeta を呼べないため、軽量 meta 返却にフォールバックする。

import type {
  IrosChatRequest,
  IrosChatResponse,
  IrosMode as UiMode,
  IrosMemory,
  IrosCredit,
} from './types';

import type { IrosMode, Depth } from '@/lib/iros/system';
import { runIrosTurn } from './orchestrator';

// 旧コード互換用の別名
type CoreMode = IrosMode;

// --- UI側モード → コア側モードの簡易マッピング ---
//   'surface' → 一般相談（counsel）
//   'core'    → 診断寄り（diagnosis）
//   'auto'    → Orchestrator 側の決定に任せる
function mapUiModeToCore(mode?: UiMode): CoreMode | null {
  if (!mode || mode === 'auto') return null;
  if (mode === 'surface') return 'counsel';
  if (mode === 'core') return 'diagnosis';
  return null;
}

// layer 判定：diagnosis を Core とみなす（V2では meta.mode を優先）
function decideLayer(mode: CoreMode | null | undefined): 'Surface' | 'Core' {
  return mode === 'diagnosis' ? 'Core' : 'Surface';
}

// V2: 返信本文から推測しない。meta から軽量スナップショットを作る
function makeMemorySnapshotFromMeta(meta: any, userText: string): IrosMemory {
  const depth = (meta?.depth ?? null) as Depth | null;

  const summary = String(userText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const last_keyword =
    summary.split(/\s|、|。/).filter(Boolean).slice(-1)[0] ?? '';

  const tone =
    meta?.mode === 'counsel'
      ? 'warm'
      : meta?.mode === 'diagnosis'
      ? 'neutral'
      : 'light';

  const theme =
    meta?.mode === 'diagnosis'
      ? 'inner_mirror'
      : 'general';

  return {
    depth: depth ?? 'S1',
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

// sb 取得（req に入っていれば使う / 無ければ null）
function pickSb(req: any): any | null {
  // IrosChatRequest 側が将来拡張されても崩れないように “広めに” 見る
  return req?.sb ?? req?.supabase ?? req?.supabaseClient ?? null;
}

// userCode 取得（req に入っていれば使う / 無ければ null）
function pickUserCode(req: any): string | null {
  const v = req?.userCode ?? req?.user_code ?? null;
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
}

/**
 * IrosChat API 用コア（V2）
 * - Orchestrator を呼び出して meta を確定
 * - 本文生成は行わない（reply は空文字）
 */
export async function generateIrosChat(
  req: IrosChatRequest,
): Promise<IrosChatResponse> {
  try {
    const coreModeHint = mapUiModeToCore(req.mode);

    const sb = pickSb(req);
    const userCode = pickUserCode(req);

    // ------------------------------------------------------------
    // ✅ V2: sb がある場合は Orchestrator を実行して meta 確定
    // ------------------------------------------------------------
    if (sb) {
      const orch = await runIrosTurn({
        conversationId: req.conversationId,
        text: req.userText,
        requestedMode: coreModeHint ?? undefined,
        sb,
        userCode: userCode ?? undefined,
        // chatCore からは firstTurn 判定が不明なので false（必要なら req に追加）
        isFirstTurn: false,
        // 履歴は chatCore 経由では未提供（必要なら req に追加して渡す）
        history: [],
      });

      const layer = decideLayer((orch.meta as any)?.mode ?? coreModeHint ?? null);
      const memory = makeMemorySnapshotFromMeta(orch.meta as any, req.userText);
      const credit = makeDummyCredit();

      // V2: 本文は render-v2 が作る。ここは空を返す（互換）
      return {
        ok: true,
        reply: '',
        layer,
        credit,
        memory,
      };
    }

    // ------------------------------------------------------------
    // ✅ sb が無い場合：Orchestrator（DB依存）を呼べないためフォールバック
    // - 旧 generate.ts は呼ばない（V2整合性のため）
    // - 最低限の layer/memory を返して UI を落とさない
    // ------------------------------------------------------------
    {
      const fallbackMeta = { mode: coreModeHint ?? 'counsel', depth: 'S2' };
      const layer = decideLayer(fallbackMeta.mode as any);
      const memory = makeMemorySnapshotFromMeta(fallbackMeta, req.userText);
      const credit = makeDummyCredit();

      return {
        ok: true,
        reply: '',
        layer,
        credit,
        memory,
      };
    }
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
