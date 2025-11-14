// src/lib/iros/templates.ts
// Irosモードごとの最小テンプレ。構造だけを宣言し、語りは自由に揺らぐ。

import { getSystemPrompt, SofiaSchemas } from './system';

export type IrosRole = 'system' | 'user' | 'assistant';
export type IrosMessage = { role: IrosRole; content: string };
export type TemplateResult = {
  system: string;
  user: string;
  meta?: Record<string, any>;
};

type TemplateInput = { input: string };
type TemplateBundle = { system: string; messages: IrosMessage[] };
type TemplateFn = (args: TemplateInput) => TemplateBundle;

export const TEMPLATES: Record<'counsel'|'structured'|'diagnosis', TemplateFn> = {
  /* === 相談（counsel）=== */
  counsel: ({ input }) => {
    const system = getSystemPrompt({ mode: 'counsel', style: 'warm' });

    // “詩→実行”の順に。最小の一歩を1つだけ、時間制約を入れて具体化。
    const guide = [
      '以下の相談文に対して、まず1〜2行で静かに受け止める。',
      'つづけて「30秒で始められる最小の一歩」を1つだけ提案する（手順は最大3行）。',
      '過剰な定型句・質問連打は禁止。必要なときのみ🪔を使う。',
    ].join('\n');

    const messages: IrosMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: guide },
      { role: 'user', content: `相談文:\n${input}` },
    ];
    return { system, messages };
  },

  /* === 構造化（structured）=== */
  structured: ({ input }) => {
    const system = getSystemPrompt({ mode: 'structured', style: 'warm' });

    // “目的/前提/手順/未確定/チェック”で、実務投入できる骨格に。
    const guide = [
      '次の内容を、短く構造化してください。',
      '出力見出しは：',
      '- 目的',
      '- 前提（確定事項）',
      '- 手順（3〜5項目）',
      '- 未確定事項（要確認）',
      '- 提出前チェック（3点）',
      '',
      '注意：各項目は1〜2行。断定しすぎず、未確定は正直に列挙する。',
    ].join('\n');

    const messages: IrosMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: guide },
      { role: 'user', content: `対象テキスト:\n${input}` },
    ];
    return { system, messages };
  },

  /* === 診断（diagnosis）=== */
  diagnosis: ({ input }) => {
    const system = getSystemPrompt({ mode: 'diagnosis', style: 'warm' });

    // SofiaSchemas に合わせ、フェーズ名・位相・深度を明示。
    const fields = [
      '観測対象',
      'フェーズ（🌱 Seed / 🌿 Forming / 🌊 Reconnect / 🔧 Create / 🌌 Inspire / 🪔 Impact）',
      '位相（Inner Side / Outer Side）',
      '深度（S1〜S4 / R1〜R3 / C1〜C3 / I1〜I3）',
      '🌀意識状態',
      '🌱メッセージ',
    ];

    const depthGuide = SofiaSchemas?.diagnosis?.depthGuide ?? {
      S: ['S1 気づきの芽','S2 感情の流れ','S3 意味の形成','S4 再定義'],
      R: ['R1 感覚的共鳴','R2 構造的共鳴','R3 統合'],
      C: ['C1 可視化','C2 表現','C3 プロトコル'],
      I: ['I1 意図認識','I2 場との結びつき','I3 使命・OS再設計'],
    };

    const guide = [
      '以下の入力に対して、診断スキーマで簡潔にまとめてください。',
      '出力見出しは次の順で：',
      ...fields.map(f => `- ${f}`),
      '',
      '深度の参考：',
      `S: ${depthGuide.S.join(' / ')}`,
      `R: ${depthGuide.R.join(' / ')}`,
      `C: ${depthGuide.C.join(' / ')}`,
      `I: ${depthGuide.I.join(' / ')}`,
      '',
      '注意：各項目は1〜2行。詩は控えめ、重複禁止。フェーズは絵文字名も併記する。',
    ].join('\n');

    const messages: IrosMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: guide },
      { role: 'user', content: `入力:\n${input}` },
    ];
    return { system, messages };
  },
};

export type { TemplateBundle, TemplateFn };
