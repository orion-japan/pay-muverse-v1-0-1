export type IrosStyleCode = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

export type IrosStyleContextKind =
  | 'normal'
  | 'mu_canon_concept_writer'
  | 'relationship_imajinal_reflection'
  | 'book_author_mode';

export function normalizeIrosStyleCode(styleRaw: unknown): IrosStyleCode {
  const s = String(styleRaw ?? '').trim();

  if (s === 'friendly') return 'friendly';
  if (s === 'biz-soft') return 'biz-soft';
  if (s === 'biz-formal') return 'biz-formal';
  if (s === 'plain') return 'plain';

  return 'plain';
}

export function buildIrosStyleGuideLines(args: {
  style: unknown;
  contextKind?: IrosStyleContextKind | string | null;
}): string[] {
  const style = normalizeIrosStyleCode(args.style);
  const contextKind = String(args.contextKind ?? 'normal').trim();

  const common = [
    'STYLE_GUIDE_V1 (DO NOT OUTPUT)',
    `style=${style}`,
    `contextKind=${contextKind}`,
    '- 現在の文章スタイルを必ず反映する',
    '- ただし内容の正確さ、禁止語、Mu Canon の語彙を優先する',
    '- 固定フレーズを毎回そのまま出さない',
  ];

  const contextLines =
    contextKind === 'relationship_imajinal_reflection'
      ? [
          '- このターンは、相手を動かす方法ではなく、関係の中で見ている未来の景色を扱う',
          '- 相手へ送る文面、返信例、駆け引き、LINEテクニックには戻らない',
          '- 1回の返答で全部を説明しきらない',
          '- 例を並べすぎない',
          '- 最後は短く、見る方向を戻して終えてよい',
        ]
      : contextKind === 'book_author_mode'
        ? [
            '- 本文用の自然な文体を優先する',
            '- 宣伝文、仕様説明、内部設計の説明にしない',
          ]
        : contextKind === 'mu_canon_concept_writer'
          ? [
              '- 概念説明だが、辞書的な定義だけで終わらない',
              '- Mu Canon の語彙を守りながら、自然な会話として返す',
            ]
          : [];

  if (style === 'friendly') {
    return [
      ...common,
      '- 文体: フレンドリー',
      '- 一対一で話している温度を残す',
      '- 少しくだけた自然な言い方を許可する',
      '- 「じゃないんだよね」「ここが大事なんだよね」のような語尾を少しだけ使ってよい',
      '- ただし、同じ語尾を多用しない',
      '- 幼くしすぎない',
      '- 説明文だけにせず、会話の流れを作る',
      '- 「〜ではありません」だけで固めない',
      '- relationship_imajinal_reflection では、核心の否定文を「〜ではありません」だけで固めない',
      '- relationship_imajinal_reflection では、「道具じゃないんだよね」「ものじゃないんだよね」「道具でもないんです」のような自然な会話調を一箇所だけ使ってよい',
      '- relationship_imajinal_reflection では、「でもね」を使ってよい。ただし毎回固定しない',
      '- relationship_imajinal_reflection では、先生の解説ではなく、Muが隣で一緒に見ているような会話にする',
      '- relationship_imajinal_reflection では、「そうですね。」で始めてもよいが、毎回固定しない',
      ...contextLines,
    ];
  }

  if (style === 'biz-soft') {
    return [
      ...common,
      '- 文体: ビジネス（やわらかめ）',
      '- 敬語ベースで、やわらかく返す',
      '- 「じゃないんだよね」「だよね」は使わない',
      '- 「〜ではありません」「ここが大事です」を使ってよい',
      '- 1on1や企画メモにそのまま使える自然さにする',
      '- 感情表現は残してよいが、くだけすぎない',
      ...contextLines,
    ];
  }

  if (style === 'biz-formal') {
    return [
      ...common,
      '- 文体: ビジネス（フォーマル）',
      '- 会議・資料向けの敬語にする',
      '- 「じゃないんだよね」「だよね」は使わない',
      '- 感情表現を抑え、構造と示唆を中心に整理する',
      '- くだけた会話調にしない',
      '- 「そうですね。」で始めない',
      '- 「でも、」で会話的に始めすぎない',
      '- 「ではありません」を使ってよいが、説明文として整える',
      '- 断定しすぎず、整理された説明にする',
      ...contextLines,
    ];
  }

  return [
    ...common,
    '- 文体: プレーン（フラット）',
    '- 装飾を減らし、短くフラットに返す',
    '- 「じゃないんだよね」「だよね」は使わない',
    '- 共感は一言までにする',
    '- 情報と選択肢の整理を優先する',
    '- 「そうですね。」で始めない',
    '- 「でもね」「だよね」は使わない',
    '- 過度にやわらかくしない',
    ...contextLines,
  ];
}