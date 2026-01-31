/* eslint-disable @typescript-eslint/no-explicit-any */

// src/lib/iros/language/rephraseEngine.ts
// thin re-export (moved implementation to ./rephrase/rephraseEngine.full.ts)

// types
export type {
  Slot,
  ExtractedSlots,
  RephraseOptions,
  RephraseResult,
} from './rephrase/rephraseEngine.full';

// functions
export {
  extractSlotsForRephrase,
  rephraseSlotsFinal,
} from './rephrase/rephraseEngine.full';
