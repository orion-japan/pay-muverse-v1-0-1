import type { BuildOutputPolicyInput, OutputPolicy } from './types';

export function buildOutputPolicy(
  questionType: BuildOutputPolicyInput['questionType'],
  tMode: BuildOutputPolicyInput['tMode'],
  pastResolve?: BuildOutputPolicyInput['pastResolve'],
  sameTopicTurns?: number,
): OutputPolicy {
  let answerFirst = true;
  let askBackAllowed = false;
  let splitFactHypothesis = false;
  let usePastReframe = false;
  let avoidPrematureClosure = false;

  if (questionType === 'truth') {
    answerFirst = false;
    askBackAllowed = true;
    splitFactHypothesis = false;
    avoidPrematureClosure = true;
  }

  if (questionType === 'structure') {
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

  if (
    questionType === 'structure' &&
    (pastResolve?.detected === true || (sameTopicTurns ?? 0) >= 3)
  ) {
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
