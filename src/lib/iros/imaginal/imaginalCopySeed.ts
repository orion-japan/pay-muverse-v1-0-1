export type ImaginalIntentionLayer = {
  received_meaning?: string;
  seen_future?: string;
  hidden_intention?: string;
  future_distortion?: string;
};

export type ImaginalCopySeedLike = {
  imaginal_copy?: string;
  seen_future?: string;
  intention_layer?: ImaginalIntentionLayer;
};

function clean(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s || undefined;
}

function normalizeCopyFromSeenFuture(value: unknown): string | undefined {
  let s = clean(value);
  if (!s) return undefined;

  s = s
    .replace(/^この人は、?/, '')
    .replace(/^ユーザーは、?/, '')
    .replace(/^あなたは、?/, '')
    .replace(/を先に見ている[。.]?$/, '未来')
    .replace(/を見続けている[。.]?$/, '未来')
    .replace(/を見ている[。.]?$/, '未来')
    .replace(/[。.]$/u, '')
    .trim();

  if (!s) return undefined;

  if (s.length > 54) {
    s = s.slice(0, 54).trim();
  }

  return s;
}

function looksLikeStateOrActionCopy(value: unknown): boolean {
  const s = clean(value);
  if (!s) return true;

  const stateMarkers = [
    '確認の空白',
    '主導権',
    '確認している',
    '求めている',
    '促している',
    '決めに行っている',
    '送信している',
    '共有している',
    '予定を押さえている',
    '段取りしている',
  ];

  const intentionMarkers = [
    '未来',
    '見ている',
    '見続けている',
    '先に',
    '背負う',
    '残される',
    '失われる',
    '測る',
    '閉じる',
    '終わり',
    '置いている',
  ];

  const hasStateMarker = stateMarkers.some((m) => s.includes(m));
  const hasIntentionMarker = intentionMarkers.some((m) => s.includes(m));

  return hasStateMarker || !hasIntentionMarker;
}

export function enforceImaginalCopyFromIntention<T extends ImaginalCopySeedLike>(seed: T): T {
  const seenFuture =
    clean(seed.intention_layer?.seen_future) ||
    clean(seed.seen_future);

  if (!seenFuture) return seed;

  const copyFromIntention = normalizeCopyFromSeenFuture(seenFuture);
  if (!copyFromIntention) return seed;

  const currentCopy = clean(seed.imaginal_copy);

  return {
    ...seed,
    seen_future: clean(seed.seen_future) || seenFuture,
    imaginal_copy:
      !currentCopy || looksLikeStateOrActionCopy(currentCopy)
        ? copyFromIntention
        : copyFromIntention,
  };
}
