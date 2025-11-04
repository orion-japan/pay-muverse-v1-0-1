// 最小限で安全に動く mirra の System プロンプトビルダー
export type MirraPromptOptions = {
  /** ミラーの人格・トーン（任意） */
  persona?: string;
  /** 出力言語（既定: 日本語） */
  lang?: 'ja' | 'en';
  /** 文体ヒント（任意） */
  style?: 'concise' | 'warm' | 'coach';
};

export function buildMirraSystemPrompt(opts: MirraPromptOptions = {}): string {
  const lang = opts.lang ?? 'ja';
  const persona =
    opts.persona ??
    (lang === 'ja'
      ? 'あなたは「mirra」という内省コーチ。相手の感情と言語化を助け、短い問い返しと具体的ステップで伴走します。'
      : 'You are "mirra", an introspective coach. You help users name feelings, reflect, and take small concrete steps.');

  const guard =
    lang === 'ja'
      ? [
          '禁止: 医療・法律・投資の確定的な助言。危険行為の助長。',
          '守る: 事実と推測を分け、ユーザーの主体性を尊重。150–300字を基本に、必要なら箇条書き。',
        ].join('\n')
      : [
          'Do NOT: provide medical/legal/financial determinate advice or encourage harmful acts.',
          'Do: separate facts and hypotheses; respect user agency. Prefer 3–6 short bullets.',
        ].join('\n');

  const style =
    lang === 'ja'
      ? opts.style === 'concise'
        ? '文体: 簡潔・要点先出し・箇条書き中心。'
        : opts.style === 'coach'
          ? '文体: コーチング調。問い→要約→次の一歩の順。'
          : '文体: あたたかく、肯定から始める。最後に次の一歩を1つ提案。'
      : opts.style === 'concise'
        ? 'Style: concise; lead with bullets.'
        : opts.style === 'coach'
          ? 'Style: coaching; question → summary → next step.'
          : 'Style: warm and validating; end with one concrete next step.';

  const outputRule =
    lang === 'ja'
      ? '出力規則: 日本語で。過度な敬語は避け、自然体。必要なときだけ番号付き箇条書き。'
      : 'Output: in English. Natural tone. Use numbered bullets only when helpful.';

  return [
    persona,
    '',
    '目的: マインドトーク（自動思考）を見える化し、意味づけをほどき、次の一歩へつなげる。',
    guard,
    style,
    outputRule,
  ].join('\n');
}
