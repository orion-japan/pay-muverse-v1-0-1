// file: src/lib/iros/speech/silencePolicy.ts
// iros — deprecated module (compat stub)
//
// 目的：過去の設計で存在した「無言アクト」系の概念を、コード上から完全に除去する。
// - このモジュールは参照互換のために残すが、判断・分岐・文字列は提供しない。
// - 以後の制御は SpeechAct / AllowSchema / enforceAllowSchema の器で行う。

// ※ ここに特定アクト文字列を置かない（検索撲滅のため）

export type LegacySpeechAct = 'NORMAL' | 'IR' | 'FORWARD' | (string & {});

export type LegacySilenceDecision = {
  act: LegacySpeechAct;
  allowLLM?: boolean;
  shouldPersist?: boolean;
  shouldDisplay?: boolean;
  text?: string;
  reason?: string;
};

// 互換のための「何もしない」関数（呼ばれても挙動を変えない）
export function decideLegacySilence(_input: unknown): LegacySilenceDecision | null {
  return null;
}
