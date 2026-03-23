// src/lib/iros/delta/types.ts

// 仕様書側の source of truth
export type LayerKind = 'fact' | 'intent' | 'creation';

// e_turn の実値は既存系に合わせて文字列で受ける
export type ETurn = string;

export type EnergyShift = {
  from: ETurn | null;
  to: ETurn | null;
  changed: boolean;
};

export type IntentShift = {
  from: string | null;
  to: string | null;
  changed: boolean;
};

export type StructureShift = {
  topicChanged: boolean;
  prevTopic: string | null;
  nextTopic: string | null;
};

export type LayerShift = {
  from: LayerKind | null;
  to: LayerKind | null;
  changed: boolean;
};

export type MultiDelta = {
  energyShift: EnergyShift | null;
  intentShift: IntentShift | null;
  structureShift: StructureShift | null;
  layerShift: LayerShift | null;
};

export type PrimaryDeltaType = 'energy' | 'intent' | 'structure';

export type DeltaPolicy = {
  layer: LayerKind;
  primaryHint?: PrimaryDeltaType;
};

export type PrimaryDelta = {
  type: PrimaryDeltaType;
  payload: any;
};

export type DeltaState = {
  e_turn: ETurn | null;
  topic: string | null;
  layer: LayerKind | null;
  intent: string | null;
};

export type BuildDeltaInput = {
  prev: DeltaState;
  now: DeltaState;
};

/**
 * ---- ここから下は一時互換 ----
 * buildMultiDelta.ts / selectPrimaryDelta.ts / emitDeltaHint.ts を
 * 仕様書版に置き換えるまでの仮残し。
 * 本実装へ移し終えたら削除する。
 */

export type LegacyLayerKind = LayerKind | 'interpretation';

export type DeltaType =
  | 'scope_mismatch'
  | 'abstraction_gap'
  | 'intent_gap';

export type DeltaCandidate = {
  type: DeltaType;
  score: number;
  reason?: string;
};

export type DeltaInput = {
  userText: string;
  question: {
    domain?: string;
    type?: string;
    focus?: string;
    layer?: LegacyLayerKind;
  };
};
