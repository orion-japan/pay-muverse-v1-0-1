import type { BuildOutputPolicyInput, OutputPolicy } from './types';

export function buildOutputPolicy(input: BuildOutputPolicyInput): OutputPolicy {
  const { questionType, tMode, pastResolve } = input;

  let answerFirst = true;
  let askBackAllowed = false;
  let splitFactHypothesis = false;
  let usePastReframe = false;
  let avoidPrematureClosure = false;

  if (questionType === 'truth') {
    // 18日向け:
    // truth でも「即・整理で閉じる」を弱める
    // - 先に断定しすぎない
    // - 返しの余白を残す
    answerFirst = false;
    askBackAllowed = true;
    splitFactHypothesis = false;
    avoidPrematureClosure = true;
  }

  if (questionType === 'structure') {
    // ✅ 仕様確認・定義確認・理由説明は、まず答えを返す。
    //    ここで askBackAllowed=true だと、
    //    「名前は？」「何ができるの？」「なぜe3？」のような
    //    説明要求に対して、答えより先に深読み質問へ流れやすい。
    answerFirst = true;
    askBackAllowed = false;
    splitFactHypothesis = false;
    avoidPrematureClosure = false;
  }

  if (questionType === 'cause') {
    answerFirst = true;
    askBackAllowed = true;
    splitFactHypothesis = false;
  }

  if (questionType === 'choice') {
    answerFirst = true;
    askBackAllowed = true;
    splitFactHypothesis = true;
  }

  if (questionType === 'meaning') {
    answerFirst = true;
    askBackAllowed = true;
    avoidPrematureClosure = true;
  }

  if (questionType === 'future_design') {
    answerFirst = true;
    askBackAllowed = true;
    avoidPrematureClosure = false;
  }

  if (questionType === 'unresolved_release') {
    answerFirst = true;
    askBackAllowed = true;
    usePastReframe = true;
    avoidPrematureClosure = true;
  }

  if (tMode === 'compare_models') {
    splitFactHypothesis = true;
    askBackAllowed = true;
  }

  if (tMode === 'explore_future' || tMode === 'design_probe') {
    askBackAllowed = true;
  }

  if (tMode === 'reobserve_past') {
    usePastReframe = true;
    askBackAllowed = true;
    avoidPrematureClosure = true;
  }

  if (pastResolve?.detected) {
    usePastReframe = true;
  }

  return {
    answerFirst,
    askBackAllowed,
    splitFactHypothesis,
    usePastReframe,
    avoidPrematureClosure,
  };
}
