// src/lib/iros/question/detectPastResolve.ts
// IROS QuestionEngine v1
// Phase4: past resolve detection (rule-based / safe-first)

import type { DetectPastResolveInput, PastResolveState } from './types';

function normalizeText(input: string): string {
  return String(input ?? '').trim();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function pickCandidateThemes(text: string): string[] {
  const themes: string[] = [];

  if (/未完了|未消化|終わっていない|残っている/.test(text)) {
    themes.push('未完了テーマ');
  }
  if (/また同じ|繰り返す|戻ってきた|ループ/.test(text)) {
    themes.push('反復パターン');
  }
  if (/引っかかる|刺さる|気になる|離れない/.test(text)) {
    themes.push('残留反応');
  }
  if (/解消したい|手放したい|再配置したい|整理したい/.test(text)) {
    themes.push('再配置要求');
  }
  if (/過去|前の|以前|昔/.test(text)) {
    themes.push('過去参照');
  }
  if (/相手|あの人|彼|彼女|関係/.test(text)) {
    themes.push('関係テーマ');
  }
  if (/自分|私|僕|俺|気持ち|感情/.test(text)) {
    themes.push('自己テーマ');
  }

  return unique(themes).slice(0, 6);
}

export function detectPastResolve(input: DetectPastResolveInput): PastResolveState | null {
  const userText = normalizeText(input.userText ?? '');
  const topicHint = normalizeText(String(input.context?.topicHint ?? ''));
  const situationSummary = normalizeText(String(input.context?.situationSummary ?? ''));

  if (!userText && !topicHint && !situationSummary) return null;

  const cueList = [
    'また同じ',
    'まだ残っている',
    '未完了',
    '未消化',
    '引っかかる',
    '終わっていない',
    '解消したい',
    '再配置したい',
    '手放したい',
    '繰り返す',
    '戻ってきた',
    '離れない',
    'ずっと残る',
    '前にも',
    '過去',
    '以前',
  ];

  const collectCues = (text: string): string[] => {
    if (!text) return [];

    const cues = cueList.filter((cue) => text.includes(cue));

    const regexHits: string[] = [];
    if (/また.*同じ|同じ.*戻/.test(text)) regexHits.push('反復一致');
    if (/未完了|未消化|終わっていない/.test(text)) regexHits.push('未完了一致');
    if (/引っかかる|離れない|残っている/.test(text)) regexHits.push('残留一致');
    if (/解消したい|再配置したい|手放したい|整理したい/.test(text)) regexHits.push('解放要求一致');

    return unique([...cues, ...regexHits]);
  };

  const userCues = collectCues(userText);
  const contextText = [topicHint, situationSummary].filter(Boolean).join('\n');
  const contextCues = collectCues(contextText);

  // ✅ 原則：
  // - pastResolve は userText 主判定
  // - context だけで pastResolve を立てない
  // - ただし userText に最低1つでも手がかりがある場合のみ、context を補助に使う
  if (userCues.length === 0) return null;

  const mergedCues = unique([...userCues, ...contextCues]);
  const themeText = [userText, contextText].filter(Boolean).join('\n');

  return {
    detected: true,
    cues: mergedCues.slice(0, 8),
    candidateThemes: pickCandidateThemes(themeText),
  };
}
