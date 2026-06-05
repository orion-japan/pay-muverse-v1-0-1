import { normalizeDiagnosisTargetKey } from './normalizeDiagnosisTargetKey';
import type {
  ContinuityOfferDomain,
  PendingOffer,
  PendingOfferKind,
  ResolvedOffer,
  PendingOfferOption,
} from './continuityOffer.types';

type ExtractPendingOfferArgs = {
  assistantText: string;
  assistantMessageId?: string | null;
  nowIso?: string | null;
};

type LabelInfo = {
  label: string;
  aliases: string[];
  index: number;
};

const COMMON_ACCEPT_PHRASES = [
  'お願いします',
  'おねがいします',
  'はい',
  'それで',
  'それをお願いします',
  '続けて',
  '進めて',
  '見てください',
  '分析してください',
];

function trimText(value: unknown): string {
  return String(value ?? '').replace(/[\s　]+/g, ' ').trim();
}

function stripMarkdownForParsing(value: unknown): string {
  return trimText(value)
    .replace(/\*\*/g, '')
    .replace(/^[-*・●]\s*/u, '')
    .replace(/^#{1,6}\s*/u, '')
    .trim();
}

function compactText(value: unknown): string {
  return stripMarkdownForParsing(value)
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .trim();
}

function createOfferId(text: string): string {
  let hash = 0;
  const src = `${Date.now()}|${text.slice(0, 120)}`;
  for (let i = 0; i < src.length; i += 1) {
    hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
  }
  return `offer_${hash.toString(16)}`;
}

function classifyOfferKind(text: string): PendingOfferKind {
  if (/(前者|後者|一つ目|二つ目|1つ目|2つ目|Ａ|Ｂ|A|B)/u.test(text)) {
    return 'choice';
  }

  if (/(必要なら次に|次に|次は|このあと|さらに)/u.test(text)) {
    return 'next_action';
  }

  if (/(分けて|整理できます|見られます|できます)/u.test(text)) {
    return 'analysis_menu';
  }

  return 'suggestion';
}

function classifyDomain(text: string): ContinuityOfferDomain {
  if (/(診断|ir診断|IR診断|状態|深度|Qコード|e_turn)/u.test(text)) {
    return 'diagnosis';
  }

  if (/(関係|関係性|距離感|相手|彼|彼女|好きな人|恋人|元彼|元カレ|元彼女|元カノ)/u.test(text)) {
    return 'relationship';
  }

  if (/(実装|コード|仕様|DB|SQL|ログ|route\.ts|tsx|ts|Git|git|ビルド|build)/iu.test(text)) {
    return 'development';
  }

  if (/(書籍|原稿|章|文章|投稿|プロンプト|画像|動画|構成)/u.test(text)) {
    return 'creative';
  }

  if (/(プロジェクト|Muverse|IROS|iros|Mu|Sofia|アプリ|サービス)/u.test(text)) {
    return 'project';
  }

  return 'general';
}

function cleanTargetLabel(value: unknown): string | null {
  const s = trimText(value)
    .replace(/^(ir診断|IR診断|診断)\s*/u, '')
    .replace(/(について|に関して)$/u, '')
    .trim();

  return s ? s : null;
}

function extractTargetLabel(text: string): string | null {
  const source = trimText(text);
  if (!source) return null;

  const patterns: RegExp[] = [
    /([一-龯々ぁ-んァ-ヶA-Za-z0-9_\-]{1,30})(?:さん|様|先生|くん|君|ちゃん|氏)?の(?:診断結果|診断内容|診断|ir診断|IR診断|状態)/u,
    /([一-龯々ぁ-んァ-ヶA-Za-z0-9_\-]{1,30})(?:さん|様|先生|くん|君|ちゃん|氏)?との(?:関係|関係性|距離感|ズレ|ずれ)/u,
    /([一-龯々ぁ-んァ-ヶA-Za-z0-9_\-]{1,30})(?:さん|様|先生|くん|君|ちゃん|氏)?について(?:診断|関係|関係性|状態)/u,
  ];

  for (const pattern of patterns) {
    const matched = source.match(pattern);
    const picked = cleanTargetLabel(matched?.[1] ?? null);
    if (picked) return picked;
  }

  if (/(自分|わたし|私|僕|俺)/u.test(source)) return '自分';
  if (/(相手|あの人|あのひと|彼|彼女|好きな人|恋人)/u.test(source)) return '相手';

  return null;
}

function labelInfoFromLine(line: string): LabelInfo | null {
  const compact = compactText(line);

  if (/^前者/u.test(compact)) {
    return {
      label: '前者',
      aliases: ['前者', '前者で', '前者お願いします', '1', '1で', '一つ目', '一つ目で'],
      index: 1,
    };
  }

  if (/^後者/u.test(compact)) {
    return {
      label: '後者',
      aliases: ['後者', '後者で', '後者お願いします', '2', '2で', '二つ目', '二つ目で'],
      index: 2,
    };
  }

  if (/^(一つ目|1つ目|１つ目)/u.test(compact)) {
    return {
      label: '一つ目',
      aliases: ['一つ目', '一つ目で', '1', '1で', '前者', '前者で'],
      index: 1,
    };
  }

  if (/^(二つ目|2つ目|２つ目)/u.test(compact)) {
    return {
      label: '二つ目',
      aliases: ['二つ目', '二つ目で', '2', '2で', '後者', '後者で'],
      index: 2,
    };
  }

  return null;
}

function isSectionHeading(line: string): boolean {
  const compact = compactText(line);
  return /^(いま見えていること|いま分けて見たいこと|ここから整理する順番|いまのまとめ|まとめ|結論)$/u.test(
    compact,
  );
}

function removeLeadingOptionLabel(line: string): string {
  return stripMarkdownForParsing(line)
    .replace(/^(前者|後者|一つ目|二つ目|1つ目|2つ目|１つ目|２つ目)(なら|は|で)?[、:：\s]*/u, '')
    .replace(/(できます|見られます|整理できます|分析できます)$/u, '')
    .trim();
}

function optionFromParts(info: LabelInfo, sourceText: string): PendingOfferOption {
  const action = trimText(sourceText);
  const targetLabel = extractTargetLabel(action);
  const targetKey = normalizeDiagnosisTargetKey(targetLabel);
  const domain = classifyDomain(action);

  return {
    index: info.index,
    label: info.label,
    aliases: info.aliases,
    action: action || info.label,
    sourceText: action || info.label,
    targetLabel,
    targetKey,
    domain,
    expectedUserPhrases: info.aliases,
  };
}

function buildOptionsFromLines(lines: string[]): PendingOfferOption[] {
  const options: PendingOfferOption[] = [];
  const seenIndexes = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const info = labelInfoFromLine(line);
    if (!info) continue;

    const parts: string[] = [];
    const sameLineAction = removeLeadingOptionLabel(line);

    if (sameLineAction && sameLineAction !== info.label) {
      parts.push(sameLineAction);
    }

    let j = i + 1;

    while (j < lines.length) {
      const nextLine = lines[j];

      if (labelInfoFromLine(nextLine)) break;

      if (!isSectionHeading(nextLine)) {
        parts.push(stripMarkdownForParsing(nextLine));
      }

      j += 1;
    }

    const sourceText = trimText(parts.join(' '));

    if (sourceText && !seenIndexes.has(info.index)) {
      options.push(optionFromParts(info, sourceText));
      seenIndexes.add(info.index);
    }

    if (j > i + 1) {
      i = j - 1;
    }
  }

  return options.sort((a, b) => a.index - b.index);
}

function buildAcceptOnlyOption(text: string): PendingOfferOption | null {
  const source = trimText(text);
  if (!source) return null;

  const looksLikeNextAction =
    /(必要なら次に|次に|次は|このあと|さらに|できます|見られます|整理できます|分析できます)/u.test(source);

  if (!looksLikeNextAction) return null;

  const targetLabel = extractTargetLabel(source);
  const targetKey = normalizeDiagnosisTargetKey(targetLabel);
  const domain = classifyDomain(source);

  return {
    index: 1,
    label: '承諾',
    aliases: COMMON_ACCEPT_PHRASES,
    action: source,
    sourceText: source,
    targetLabel,
    targetKey,
    domain,
    expectedUserPhrases: COMMON_ACCEPT_PHRASES,
  };
}

export function extractPendingOfferFromAssistantText(
  args: ExtractPendingOfferArgs,
): PendingOffer | null {
  const assistantText = String(args.assistantText ?? '').trim();
  if (!assistantText) return null;

  const normalized = assistantText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => stripMarkdownForParsing(line))
    .filter(Boolean);

  const options = buildOptionsFromLines(lines);

  if (options.length === 0) {
    const acceptOnly = buildAcceptOnlyOption(lines.slice(-3).join(' '));
    if (acceptOnly) options.push(acceptOnly);
  }

  if (options.length === 0) return null;

  const first = options[0];
  const subjectLabel = first?.targetLabel ?? extractTargetLabel(assistantText);
  const subjectTargetKey = normalizeDiagnosisTargetKey(subjectLabel);
  const subjectDomain = first?.domain ?? classifyDomain(assistantText);

  const confidence = options.length >= 2 ? 0.86 : 0.68;

  if (confidence < 0.6) return null;

  return {
    offerId: createOfferId(assistantText),
    kind: classifyOfferKind(assistantText),
    createdAt: args.nowIso || new Date().toISOString(),
    expiresAfterTurns: 2,

    source: {
      assistantMessageId: args.assistantMessageId ?? null,
      assistantTextHead: assistantText.slice(0, 240),
    },

    subject: {
      label: subjectLabel,
      targetKey: subjectTargetKey,
      domain: subjectDomain,
    },

    options,

    acceptPhrases: COMMON_ACCEPT_PHRASES,

    guard: {
      currentTurnOnly: true,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      confidence,
    },
  };
}

function normalizeUserOfferReply(value: unknown): string {
  return trimText(value)
    .normalize('NFKC')
    .replace(/[「」『』（）()［］\[\]{}｛｝、。,.!！?？:：・\s]/g, '')
    .trim();
}

function createUnresolvedOfferResult(
  pendingOffer: PendingOffer | null,
  phrase: string,
  status: ResolvedOffer['status'] = 'not_resolved',
): ResolvedOffer {
  return {
    status,
    offerId: pendingOffer?.offerId ?? null,
    selected: {
      type: 'unclear',
      label: null,
      optionIndex: null,
      phrase,
    },
    action: null,
    targetLabel: pendingOffer?.subject?.label ?? null,
    targetKey: pendingOffer?.subject?.targetKey ?? null,
    domain: pendingOffer?.subject?.domain ?? null,
    source: {
      pendingOfferFound: Boolean(pendingOffer),
      matchedBy: 'none',
      confidence: 0,
    },
  };
}

export function resolvePendingOfferFromUserText(args: {
  userText: string;
  pendingOffer?: PendingOffer | null;
}): ResolvedOffer {
  const phrase = trimText(args.userText);
  const normalizedPhrase = normalizeUserOfferReply(phrase);
  const pendingOffer =
    args.pendingOffer &&
    typeof args.pendingOffer === 'object' &&
    Array.isArray(args.pendingOffer.options)
      ? args.pendingOffer
      : null;

  if (!phrase || !normalizedPhrase) {
    return createUnresolvedOfferResult(pendingOffer, phrase);
  }

  if (!pendingOffer) {
    return createUnresolvedOfferResult(null, phrase, 'not_found');
  }

  const options = pendingOffer.options.filter(Boolean);
  if (options.length === 0) {
    return createUnresolvedOfferResult(pendingOffer, phrase);
  }

  for (const option of options) {
    const aliases = [option.label, ...(option.aliases ?? []), ...(option.expectedUserPhrases ?? [])]
      .map((v) => normalizeUserOfferReply(v))
      .filter(Boolean);

    if (aliases.includes(normalizedPhrase)) {
      return {
        status: 'resolved',
        offerId: pendingOffer.offerId,
        selected: {
          type: 'option',
          label: option.label,
          optionIndex: option.index,
          phrase,
        },
        action: option.action || option.sourceText || option.label,
        targetLabel: option.targetLabel ?? pendingOffer.subject?.label ?? null,
        targetKey: option.targetKey ?? pendingOffer.subject?.targetKey ?? null,
        domain: option.domain ?? pendingOffer.subject?.domain ?? null,
        source: {
          pendingOfferFound: true,
          matchedBy: 'exact_alias',
          confidence: 0.92,
        },
      };
    }
  }

  const acceptPhrases = [
    ...(pendingOffer.acceptPhrases ?? []),
    ...COMMON_ACCEPT_PHRASES,
  ]
    .map((v) => normalizeUserOfferReply(v))
    .filter(Boolean);

  if (acceptPhrases.includes(normalizedPhrase) && options.length === 1) {
    const option = options[0];

    return {
      status: 'resolved',
      offerId: pendingOffer.offerId,
      selected: {
        type: 'accept',
        label: option.label,
        optionIndex: option.index,
        phrase,
      },
      action: option.action || option.sourceText || option.label,
      targetLabel: option.targetLabel ?? pendingOffer.subject?.label ?? null,
      targetKey: option.targetKey ?? pendingOffer.subject?.targetKey ?? null,
      domain: option.domain ?? pendingOffer.subject?.domain ?? null,
      source: {
        pendingOfferFound: true,
        matchedBy: 'accept_phrase',
        confidence: 0.86,
      },
    };
  }

  if (acceptPhrases.includes(normalizedPhrase) && options.length > 1) {
    return {
      ...createUnresolvedOfferResult(pendingOffer, phrase),
      selected: {
        type: 'unclear',
        label: null,
        optionIndex: null,
        phrase,
      },
      source: {
        pendingOfferFound: true,
        matchedBy: 'accept_phrase',
        confidence: 0.42,
      },
    };
  }

  return createUnresolvedOfferResult(pendingOffer, phrase);
}
