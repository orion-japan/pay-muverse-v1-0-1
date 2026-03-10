// src/lib/iros/question/buildIFrame.ts
// IROS QuestionEngine v1
// Phase3: iframe builder (safe-first / rule-based)

import type {
  BuildIFrameInput,
  DomainType,
  HypothesisModel,
  IFrame,
  QuestionType,
} from './types';

function normalizeText(input: string): string {
  return String(input ?? '').trim();
}

function buildTopic(text: string): string {
  const cleaned = normalizeText(text).replace(/\s+/g, ' ');
  return cleaned.slice(0, 120) || 'unknown';
}

function buildHypothesisSpace(domain: DomainType, questionType: QuestionType, text: string): HypothesisModel[] {
  const out: HypothesisModel[] = [];

  if (domain === 'cosmology') {
    out.push(
      {
        key: 'natural_evolution',
        label: '自然進化モデル',
        description: '自然環境・進化・文明発達の連続性で説明する仮説',
      },
      {
        key: 'external_intervention',
        label: '外部介入モデル',
        description: '地球外生命体や非人間知性の介入を含む仮説',
      },
      {
        key: 'myth_symbolic',
        label: '神話象徴モデル',
        description: '創造神話や象徴的語りとして読む仮説',
      },
    );
  }

  if (questionType === 'structure') {
    out.push({
      key: 'structural_mapping',
      label: '構造分解モデル',
      description: '主張・因果・検証窓・競合仮説に分けて整理する',
    });
  }

  if (questionType === 'truth') {
    out.push({
      key: 'evidence_comparison',
      label: '証拠比較モデル',
      description: '証拠の強さと説明可能性を比較する',
    });
  }

  if (questionType === 'cause') {
    out.push({
      key: 'causal_chain',
      label: '因果連鎖モデル',
      description: 'どの段階で何が作用したかを連鎖で追う',
    });
  }

  if (questionType === 'choice') {
    out.push(
      {
        key: 'self_vs_social_pressure',
        label: '自己意思と場の圧力モデル',
        description: '自分の意思決定と、その場の空気・圧力の影響を切り分ける',
      },
      {
        key: 'decision_speed_pressure',
        label: '決定速度圧モデル',
        description: '急いで決めさせる流れが判断を狭めた可能性をみる',
      },
      {
        key: 'group_conformity',
        label: '同調モデル',
        description: '周囲への同調が選択肢の幅を縮めた可能性をみる',
      },
    );
  }

  if (questionType === 'future_design') {
    out.push({
      key: 'design_path',
      label: '設計経路モデル',
      description: '次の実装・構成・進め方に分解する',
    });
  }

  if (questionType === 'unresolved_release') {
    out.push({
      key: 'unfinished_release',
      label: '未完了解放モデル',
      description: '残存テーマを観測し、再配置の糸口を探る',
    });
  }

  // テキスト補正
  if (/遺伝子|改変/.test(text)) {
    out.push({
      key: 'genetic_intervention',
      label: '遺伝子介入モデル',
      description: '生物学的改変の痕跡を検討する',
    });
  }

  if (/文明|文化|技術/.test(text)) {
    out.push({
      key: 'civilization_acceleration',
      label: '文明加速モデル',
      description: '知識移転や技術飛躍の可能性を検討する',
    });
  }

  // key重複除去
  const seen = new Set<string>();
  return out.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function buildFocusCandidate(domain: DomainType, questionType: QuestionType, text: string): string[] {
  const out: string[] = [];

  if (domain === 'cosmology') {
    out.push('介入点', '因果連鎖', '検証窓', '競合モデル');
  }

  if (questionType === 'structure') {
    out.push('主張の型', '前提の分解', '論点の切り分け');
  }

  if (questionType === 'truth') {
    out.push('証拠', '反証可能性', '説明可能性');
  }

  if (questionType === 'cause') {
    out.push('原因', 'きっかけ', '連鎖');
  }

  if (questionType === 'choice') {
    out.push(
      '自分の意思と場の圧力',
      '同調圧力',
      '決定の急かし',
      '空気圧',
    );
  }

  if (questionType === 'meaning') {
    out.push('意味', '受け取り方', '位置づけ');
  }

  if (questionType === 'future_design') {
    out.push('次の一手', '設計方針', '進行順');
  }

  if (questionType === 'unresolved_release') {
    out.push('未完了テーマ', '残留反応', '再配置');
  }

  if (/地球外生命体|非人間知性/.test(text)) {
    out.push('外部知性');
  }

  if (/人間|人類/.test(text)) {
    out.push('人間成立');
  }

  if (/遺伝子|改変/.test(text)) {
    out.push('遺伝子痕跡');
  }

  if (/文明|文化|技術/.test(text)) {
    out.push('文明飛躍');
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  }).slice(0, 8);
}

export function buildIFrame(input: BuildIFrameInput): IFrame {
  const text = normalizeText(input.userText ?? '');
  const topic = buildTopic(text);
  const hypothesisSpace = buildHypothesisSpace(input.domain, input.questionType, text);
  const focusCandidate = buildFocusCandidate(input.domain, input.questionType, text);

  return {
    domain: input.domain,
    questionType: input.questionType,
    topic,
    hypothesisSpace,
    focusCandidate,
  };
}
