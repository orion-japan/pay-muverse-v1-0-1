// src/lib/iros/deepRead/detectDeepRead.ts
// iros — Deep Read detector v1
// - 発話・ctxPack・履歴から、deep_read を開くかを安全側で判定する
// - 出力文そのものは作らない。writer に渡すための検出結果だけ返す

export type DeepReadLevel = 'off' | 'light' | 'middle' | 'strong';

export type DeepReadReason =
  | 'sting_high'
  | 'return_streak'
  | 'repeat_signal'
  | 'avoidance'
  | 'projection'
  | 'deictic_followup'
  | 'certainty_pressure';

export type DeepReadDetection = {
  shouldOpen: boolean;
  level: DeepReadLevel;
  reasons: DeepReadReason[];
  hints: string[];
  meta: {
    stingLevel: string;
    returnStreak: number;
    hasRepeatSignal: boolean;
    hasCertaintyPressure: boolean;
    hasAvoidanceSignal: boolean;
    hasProjectionSignal: boolean;
    hasDeicticFollowup: boolean;
  };
};

export type DetectDeepReadInput = {
  currentUserText: string;
  previousUserText?: string | null;
  previousAssistantText?: string | null;
  ctxPack?: any;
  args?: any;
};

function normalizeText(input: unknown): string {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickCtxPack(input: DetectDeepReadInput): any | null {
  const args = input.args as any;
  const ctxPack = input.ctxPack as any;

  return (
    (args?.userContext?.ctxPack && typeof args.userContext.ctxPack === 'object'
      ? args.userContext.ctxPack
      : null) ??
    (args?.userContext?.meta?.extra?.ctxPack &&
    typeof args.userContext.meta.extra.ctxPack === 'object'
      ? args.userContext.meta.extra.ctxPack
      : null) ??
    (args?.meta?.extra?.ctxPack && typeof args.meta.extra.ctxPack === 'object'
      ? args.meta.extra.ctxPack
      : null) ??
    (args?.extra?.ctxPack && typeof args.extra.ctxPack === 'object'
      ? args.extra.ctxPack
      : null) ??
    (ctxPack && typeof ctxPack === 'object' ? ctxPack : null)
  );
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function detectDeepRead(input: DetectDeepReadInput): DeepReadDetection {
  const currentUserText = normalizeText(input.currentUserText);
  const previousUserText = normalizeText(input.previousUserText);

  const deepCtxPack = pickCtxPack(input);
  const args = input.args as any;
  const ctxPack = input.ctxPack as any;

  const stingLevel = String(
    deepCtxPack?.stingLevel ??
      args?.stingLevel ??
      args?.extra?.stingLevel ??
      ctxPack?.stingLevel ??
      '',
  )
    .trim()
    .toUpperCase();

  const returnStreakRaw =
    deepCtxPack?.flow?.returnStreak ??
    deepCtxPack?.returnStreak ??
    args?.flow?.returnStreak ??
    args?.extra?.flow?.returnStreak ??
    ctxPack?.flow?.returnStreak ??
    ctxPack?.returnStreak ??
    0;

  const returnStreak = toNumber(returnStreakRaw, 0);

  const repeatSignalRaw =
    deepCtxPack?.repeatSignal ??
    deepCtxPack?.repeatSignalSame ??
    args?.repeatSignal ??
    args?.repeatSignalSame ??
    ctxPack?.repeatSignal ??
    ctxPack?.repeatSignalSame ??
    null;

  const hasRepeatSignal =
    repeatSignalRaw === true || String(repeatSignalRaw ?? '').trim().length > 0;

  const reasons: DeepReadReason[] = [];

  if (stingLevel === 'HIGH') reasons.push('sting_high');
  if (returnStreak >= 2) reasons.push('return_streak');
  if (hasRepeatSignal) reasons.push('repeat_signal');

  const hasCertaintyPressure =
    /(答え|正解|はっきり|どうしたら|どうすれば|解決|本当は|ほんとうは|なぜ|どうして|意味|わかりますか|分かりますか)/u.test(
      currentUserText,
    );

  if (hasCertaintyPressure) reasons.push('certainty_pressure');

  const hasAvoidanceSignal =
    /(わからない|分からない|言えない|言葉にできない|避けたい|見たくない|怖い|こわい|無理|しんどい)/u.test(
      currentUserText,
    );

  if (hasAvoidanceSignal) reasons.push('avoidance');

  const hasProjectionSignal =
    /(彼|彼女|相手|あの人|周り|みんな|親|家族|上司|部下|友達).*(はず|かも|たぶん|きっと|どう思って|どう見て|嫌われ|冷めた|怒って)/u.test(
      currentUserText,
    );

  if (hasProjectionSignal) reasons.push('projection');

  const hasDeicticFollowup =
    /^(これ|それ|この|その|あれ|あの|ここ|そこ|今の|さっき|この状況|その状況)/u.test(
      currentUserText,
    ) ||
    (!!previousUserText &&
      currentUserText.length <= 24 &&
      /(どうしたら|なぜ|どういうこと|意味|解決|わかりますか|分かりますか)/u.test(
        currentUserText,
      ));

  if (hasDeicticFollowup) reasons.push('deictic_followup');

  const hints: string[] = [];

  if (reasons.includes('certainty_pressure')) {
    hints.push(
      '答えを探しているようで、見えないまま置かれる苦しさが強く出ている可能性がある',
    );
  }

  if (reasons.includes('projection')) {
    hints.push(
      '相手そのものより、相手をどう見ているかが重くなっている可能性がある',
    );
  }

  if (reasons.includes('return_streak')) {
    hints.push(
      '同じ地点へ戻る反応があり、表の問いより奥の引っかかりが残っている可能性がある',
    );
  }

  if (reasons.includes('avoidance')) {
    hints.push(
      '言い切れなさや避けたい感じがあり、表の言葉より手前で止まっている可能性がある',
    );
  }

  if (reasons.includes('deictic_followup')) {
    hints.push(
      '参照語で前の文脈へ戻っており、直前の相談の奥にある未解決点を引き継ぐ必要がある',
    );
  }

  const shouldOpen = reasons.length > 0;

  const level: DeepReadLevel =
    !shouldOpen
      ? 'off'
      : reasons.includes('sting_high') && hasCertaintyPressure
        ? 'middle'
        : reasons.includes('sting_high') ||
            reasons.includes('return_streak') ||
            reasons.includes('repeat_signal')
          ? 'light'
          : 'light';

  return {
    shouldOpen,
    level,
    reasons: Array.from(new Set(reasons)),
    hints,
    meta: {
      stingLevel,
      returnStreak,
      hasRepeatSignal,
      hasCertaintyPressure,
      hasAvoidanceSignal,
      hasProjectionSignal,
      hasDeicticFollowup,
    },
  };
}
