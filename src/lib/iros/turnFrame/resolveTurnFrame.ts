// src/lib/iros/turnFrame/resolveTurnFrame.ts

export type IrosEventFrameKind =
  | 'normal'
  | 'operate_previous_event'
  | 'read_source'
  | 'external_lookup'
  | 'interpret_story'
  | 'transform_content'
  | 'expand_current_topic'
  | 'focus_current_topic';

export type IrosSeedMode =
  | 'normal'
  | 'previous_event_operation'
  | 'undigested_story'
  | 'undigested_emotion'
  | 'remake_story'
  | 'diagnosis'
  | 'diagnosis_followup'
  | 'line_image_read'
  | 'line_reply_advice'
  | 'web_research'
  | 'web_compare'
  | 'document_transform'
  | 'tone_rewrite'
  | 'expand_conversation'
  | 'focus_conversation';

export type IrosSourceKind =
  | 'user_text'
  | 'last_assistant_content'
  | 'current_topic'
  | 'image_line_chat'
  | 'uploaded_file'
  | 'web'
  | 'diagnosis_snapshot'
  | 'previous_undigested_story';

export type IrosTurnOperation =
  | 'none'
  | 'rewrite'
  | 'summarize'
  | 'expand'
  | 'focus'
  | 'read'
  | 'research'
  | 'compare'
  | 'transform'
  | 'reply_advice';

export type IrosTurnStyle =
  | 'none'
  | 'more_realistic'
  | 'more_natural'
  | 'more_concrete'
  | 'softer'
  | 'shorter'
  | 'longer'
  | 'easier_to_understand'
  | 'style_rewrite';

export type IrosTurnFrame = {
  kind: IrosEventFrameKind;
  seedMode: IrosSeedMode;
  sourceKind: IrosSourceKind;
  operation: IrosTurnOperation;
  target: string | null;
  style: IrosTurnStyle;
  sourceUserText: string;
  suppressMetaRead: boolean;
  suppressDeepReveal: boolean;
  suppressMemoryRecall: boolean;
  suppressStateInterpretation: boolean;
  targetPolicy: string | null;
  noInventPolicy: string | null;
};

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function detectPreviousEventStyle(text: string): IrosTurnStyle {
  if (/リアル|現実|生々/u.test(text)) return 'more_realistic';
  if (/自然|自然文|会話っぽく/u.test(text)) return 'more_natural';
  if (/具体/u.test(text)) return 'more_concrete';
  if (/柔らかく|やわらかく/u.test(text)) return 'softer';
  if (/短く/u.test(text)) return 'shorter';
  if (/長く|詳しく/u.test(text)) return 'longer';
  if (/わかりやすく|分かりやすく/u.test(text)) return 'easier_to_understand';
  return 'style_rewrite';
}

function isPreviousEventOperationText(text: string): boolean {
  return /(もう少しリアル|もっとリアル|リアルに書いて|現実味|生々しく|もっと自然|自然に|自然文寄り|会話っぽく|少し崩して|柔らかく|やわらかく|短くして|長くして|詳しく書いて|具体的に書いて|もっと具体的に|もう少し具体的に|わかりやすく|分かりやすく|短く|長く|要約して)/u.test(
    text,
  );
}

function isWebResearchText(text: string): boolean {
  return /(WEB|web|ネット|調べて|検索して|最新|公式|出典|ソース)/u.test(text);
}

function isLineImageReadText(text: string): boolean {
  return /(LINE|ライン|スクショ|スクリーンショット|画像.*読|画像.*見|この画像)/u.test(text);
}

function isExpandText(text: string): boolean {
  return /(広げて|展開して|もう少し広げて|膨らませて)/u.test(text);
}

function isFocusText(text: string): boolean {
  return /(絞って|要点|一点に|核心だけ|短くまとめて)/u.test(text);
}

function isDocumentTransformText(text: string): boolean {
  return /(提案書|資料|仕様書|レポート|文章にして|まとめて|整えて)/u.test(text);
}

export function resolveTurnFrame(input: {
  userText: unknown;
  hasImage?: boolean;
  hasUploadedFile?: boolean;
  previousSeedMode?: string | null;
  previousSourceKind?: string | null;
}): IrosTurnFrame {
  const sourceUserText = cleanText(input.userText);

  if (isPreviousEventOperationText(sourceUserText)) {
    return {
      kind: 'operate_previous_event',
      seedMode: 'previous_event_operation',
      sourceKind: 'last_assistant_content',
      operation: 'rewrite',
      target: 'last_assistant_content',
      style: detectPreviousEventStyle(sourceUserText),
      sourceUserText,
      suppressMetaRead: true,
      suppressDeepReveal: true,
      suppressMemoryRecall: true,
      suppressStateInterpretation: true,
      targetPolicy:
        '直前assistant返答だけを対象にする。現在のユーザー文そのものを分析・診断・深読みしない。',
      noInventPolicy:
        '直前assistant返答にない題材・人物・状況を足さない。恋愛・連絡待ち・スマホ・LINE・返事待ち文脈を元文にない限り足さない。',
    };
  }

  if (input.hasImage === true || isLineImageReadText(sourceUserText)) {
    return {
      kind: 'read_source',
      seedMode: 'line_image_read',
      sourceKind: 'image_line_chat',
      operation: 'read',
      target: 'image_line_chat',
      style: 'none',
      sourceUserText,
      suppressMetaRead: false,
      suppressDeepReveal: true,
      suppressMemoryRecall: true,
      suppressStateInterpretation: true,
      targetPolicy: '画像に写っている範囲だけを読む。画像外の事情を足さない。',
      noInventPolicy: '相手の本心・関係性・過去事情を画像外から断定しない。',
    };
  }

  if (isWebResearchText(sourceUserText)) {
    return {
      kind: 'external_lookup',
      seedMode: 'web_research',
      sourceKind: 'web',
      operation: 'research',
      target: 'web',
      style: 'none',
      sourceUserText,
      suppressMetaRead: false,
      suppressDeepReveal: true,
      suppressMemoryRecall: false,
      suppressStateInterpretation: true,
      targetPolicy: '外部情報を確認し、確認済み情報と推測を分ける。',
      noInventPolicy: '未確認情報を断定しない。',
    };
  }

  if (isExpandText(sourceUserText)) {
    return {
      kind: 'expand_current_topic',
      seedMode: 'expand_conversation',
      sourceKind: 'current_topic',
      operation: 'expand',
      target: 'current_topic',
      style: 'none',
      sourceUserText,
      suppressMetaRead: false,
      suppressDeepReveal: false,
      suppressMemoryRecall: false,
      suppressStateInterpretation: false,
      targetPolicy: '直前の主題から自然に広げる。',
      noInventPolicy: '関係ない具体例や別テーマへ飛ばない。',
    };
  }

  if (isFocusText(sourceUserText)) {
    return {
      kind: 'focus_current_topic',
      seedMode: 'focus_conversation',
      sourceKind: 'current_topic',
      operation: 'focus',
      target: 'current_topic',
      style: 'none',
      sourceUserText,
      suppressMetaRead: false,
      suppressDeepReveal: true,
      suppressMemoryRecall: false,
      suppressStateInterpretation: false,
      targetPolicy: '直前の主題から中心点だけを取り出す。',
      noInventPolicy: '新しい話題を足さない。',
    };
  }

  if (isDocumentTransformText(sourceUserText)) {
    return {
      kind: 'transform_content',
      seedMode: 'document_transform',
      sourceKind: 'current_topic',
      operation: 'transform',
      target: 'current_topic',
      style: 'none',
      sourceUserText,
      suppressMetaRead: false,
      suppressDeepReveal: true,
      suppressMemoryRecall: false,
      suppressStateInterpretation: true,
      targetPolicy: '直前または現在の内容を文書形式へ変換する。',
      noInventPolicy: '元の内容にない事実を足さない。',
    };
  }

  return {
    kind: 'normal',
    seedMode: 'normal',
    sourceKind: 'user_text',
    operation: 'none',
    target: 'user_text',
    style: 'none',
    sourceUserText,
    suppressMetaRead: false,
    suppressDeepReveal: false,
    suppressMemoryRecall: false,
    suppressStateInterpretation: false,
    targetPolicy: null,
    noInventPolicy: null,
  };
}
