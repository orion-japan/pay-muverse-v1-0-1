// file: src/lib/iros/speech/types.ts
// iros — SpeechAct types
//
// ✅ 方針：MIRROR 完全廃止 → FORWARD に統一
// - FORWARD は「観測で止めない」ための器：核/反転/一手 を最小で許可
// - 旧 reason（Q_BRAKE_SUPPRESS 等）は互換で残しつつ、新 reason も追加

export type SpeechAct =
  | 'FORWARD' // ✅ MIRRORの完全置換（最小の一手へ）
  | 'NAME'    // 核の命名（助言禁止）
  | 'FLIP'    // 反転（助言禁止）
  | 'COMMIT'; // T条件成立時のみ固定（ここだけ最小の一手OK）


export type SpeechDecisionReason =
  | 'MICRO_INPUT'
  // ✅ 新：NO_MIRROR 方針
  | 'Q_BRAKE_SUPPRESS__NO_MIRROR'
  | 'NO_SLOT_PLAN__NO_MIRROR'
  | 'DEFAULT__NO_MIRROR'
  // 既存
  | 'IT_ACTIVE'
  | 'TLAYER_COMMIT'
  // 互換（参照が残っていても落とさない）
  | 'Q_BRAKE_SUPPRESS'
  | 'NO_SLOT_PLAN'
  | 'DEFAULT'
  // 予期せぬ文字列も許容（将来拡張用）
  | (string & {});

export type SpeechDecision = {
  act: SpeechAct;
  reason: SpeechDecisionReason;
  confidence?: number; // 0..1（任意）
  // render側で使う「追加ヒント」（LLM本文に流さない用途）
  hint?: {
    allowLLM?: boolean; // actに反してLLMを呼ばないための保険
    oneLineOnly?: boolean;
  };
};

// ✅ SpeechActごとの「許可される出力器」
// - FORWARD：核/反転/一手 を最小で許可（観測で止めない）
// - NAME/FLIP：助言系は封じる
// - COMMIT：固定 + 一手（最大2） + 問い(最大1) まで（enforce側で最終制限）
export type AllowSchema =


  | {
      act: 'FORWARD';
      allowLLM: true;
      maxLines: 4; // 最小構造（観測→核→反転→一手）を想定
      fields: {
        // 観測は任意（入ってもOKだが、観測だけで止まらない）
        observe?: true;
        name: true;
        flip: true;
        actions: true;
        // 問いは基本禁止（長文化の入口になるため）
        question?: false;
        commit?: false;
      };
    }
  | {
      act: 'NAME';
      allowLLM: true;
      maxLines: 2;
      fields: {
        name: true; // 「核：◯◯」の命名
        observe?: true; // 任意で補助1行（観測）
        flip?: false;
        commit?: false;
        actions?: false;
        question?: false;
      };
    }
  | {
      act: 'FLIP';
      allowLLM: true;
      maxLines: 2;
      fields: {
        flip: true; // 「反転：A→B」
        observe?: true; // 任意で補助1行（観測）
        name?: false;
        commit?: false;
        actions?: false;
        question?: false;
      };
    }
  | {
      act: 'COMMIT';
      allowLLM: true;
      maxLines: 14; // ここだけ少し長いのを許可（IT書式）
      fields: {
        commit: true;  // 固定文
        actions: true; // 最小の一手（最大2）
        // 問いは “任意”（enforce側で最大1に制限）
        question?: true;
        observe?: true;
        name?: true;
        flip?: true;
      };
    };

// SpeechAct → AllowSchema の最小デフォルト
export function defaultAllowSchema(act: SpeechAct): AllowSchema {
  switch (act) {
    case 'FORWARD':
      return {
        act,
        allowLLM: true,
        maxLines: 4,
        fields: { observe: true, name: true, flip: true, actions: true, question: false },
      };

    case 'NAME':
      return {
        act,
        allowLLM: true,
        maxLines: 2,
        fields: { name: true, observe: true },
      };

    case 'FLIP':
      return {
        act,
        allowLLM: true,
        maxLines: 2,
        fields: { flip: true, observe: true },
      };

    case 'COMMIT':
      return {
        act,
        allowLLM: true,
        maxLines: 14,
        fields: { commit: true, actions: true, question: true, observe: true, name: true, flip: true },
      };
  }
}
