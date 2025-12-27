// file: src/lib/iros/server/handleIrosReply.state.ts
// iros - Server-side state helpers (re-export only)
// - 実装の二重化を防ぐため、orchestratorState.ts を唯一の実装元にする
// - ここは互換のための窓口（re-export）だけを提供する

export {
  loadBaseMetaFromMemoryState,
  saveMemoryStateFromMeta,
  type LoadStateResult,
} from '../orchestratorState';
