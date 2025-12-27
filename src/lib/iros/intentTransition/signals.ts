// file: src/lib/iros/intentTransition/signals.ts
// iros - Intent Transition v1.0 (signals) — CONFIRMED
// - Extract ONLY evidence-like signals from user text
// - Do not "infer intent"; just detect requests and behavioral proofs
// - T opens only by choice/commit/repeat evidence (not positive vibes)

import type { IntentSignals } from './types';

function norm(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[　]/g, ' ')
    .trim();
}

function hasAny(t: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(t));
}

/** Idea generation request (I loop trigger) */
const RE_WANTS_IDEAS: RegExp[] = [
  /案(を|が)?(出|だ)して/,
  /アイディア/,
  /選択肢/,
  /候補/,
  /何が(いい|良い)/,
  /どうすれば/,
  /どうしたら/,
  /考えたい/,
  /整理したい/,
  /方向性/,
  /提案(して|を)/,
  /いくつか/,
  /複数/,
];

/** Execution request (C-side request; not allowed unless anchor set) */
const RE_WANTS_EXECUTION: RegExp[] = [
  /具体的に/,
  /次の(一手|手)/,
  /やり方/,
  /手順/,
  /実装/,
  /設計/,
  /どう(やる|やれば)/,
  /進め方/,
  /プラン/,
  /ステップ/,
  /ToDo|TODO|タスク/,
  /今日(なに|何)を/,
];

/** Choice evidence (points to one option) */
const RE_CHOICE_EVIDENCE: RegExp[] = [
  /これ(で|に|が)/,
  /それ(で|に|が)/,
  /(A|Ｂ|B|Ｃ|C)(にする|でいく|がいい|を選ぶ)/,
  /(1|１)(つ目|番目)/,
  /(2|２)(つ目|番目)/,
  /(3|３)(つ目|番目)/,
  /(前者|後者)/,
  /(こっち|そっち)(で|に)/,
  /選ぶ|選びます|採用/,
];

/** Commit evidence (decision / commitment / repetition plan) */
const RE_COMMIT_EVIDENCE: RegExp[] = [
  /やる/,
  /やります/,
  /やってみる/,
  /決めた/,
  /決めます/,
  /これにする/,
  /これでいく/,
  /続ける/,
  /継続/,
  /毎日/,
  /週[0-9０-９一二三四五六七]回/,
  /期限(を)?(決め|決ま)/,
  /今日から/,
];

/** Reset evidence (reject / cancel / hold / back) */
const RE_RESET_EVIDENCE: RegExp[] = [
  /違う/,
  /やめる/,
  /やめた/,
  /無理/,
  /保留/,
  /戻す/,
  /リセット/,
  /一旦やめ/,
  /今は(いい|やめ)/,
];

/** Repeat evidence (ask again / another angle) — v1.0 minimal */
const RE_REPEAT_EVIDENCE: RegExp[] = [
  /もう(一回|いっかい)/,
  /もう少し/,
  /別の/,
  /他の/,
  /他にも/,
  /もう(ちょっと|ちょい)/,
  /違う角度/,
  /もう一つ/,
  /もう(少し)?出して/,
];

export function extractIntentSignals(text: string): IntentSignals {
  const t = norm(text);

  const wantsIdeas = hasAny(t, RE_WANTS_IDEAS);
  const wantsExecution = hasAny(t, RE_WANTS_EXECUTION);

  const hasChoiceEvidence = hasAny(t, RE_CHOICE_EVIDENCE);
  const hasCommitEvidence = hasAny(t, RE_COMMIT_EVIDENCE);
  const hasRepeatEvidence = hasAny(t, RE_REPEAT_EVIDENCE);
  const hasResetEvidence = hasAny(t, RE_RESET_EVIDENCE);

  return {
    text: t,
    wantsIdeas,
    wantsExecution,
    hasChoiceEvidence,
    hasCommitEvidence,
    hasRepeatEvidence,
    hasResetEvidence,
  };
}
