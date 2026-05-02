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
  | 'certainty_pressure'
  | 'business_pressure'
  | 'receiver_mismatch'
  | 'future_gap'
  | 'future_placement'
  | 'market_competition';

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
    hasBusinessPressure: boolean;
    hasReceiverMismatch: boolean;
    hasFutureGap: boolean;
    hasFuturePlacement: boolean;
    hasMarketCompetition: boolean;
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

  const hasBusinessPressure =
    /(仕事|事業|案件|提案|営業|商談|相手先|取引先|顧客|クライアント|プロジェクト|開発|実装|進め|進ま|進捗|成果|結果|売上|導入|採用)/u.test(
      currentUserText,
    );

  if (hasBusinessPressure) reasons.push('business_pressure');

  const hasReceiverMismatch =
    /(理解されない|理解してくれない|伝わらない|届かない|刺さらない|受け取ってもらえない|必要でない|必要な所|必要なところ|どこも理解|相手先がいる|思うように行かない|思うようにいかない)/u.test(
      currentUserText,
    );

  if (hasReceiverMismatch) reasons.push('receiver_mismatch');

  const hasFutureGap =
    /(先進的|新しい|先に見える|先が見える|先に進んで|未来|まだ早い|早すぎる|受け皿|追いついていない|追いつかない|分かる人がいない|わかる人がいない)/u.test(
      currentUserText,
    );

  if (hasFutureGap) reasons.push('future_gap');

  const hasFuturePlacement =
    /(この先|この先進的なもの|先進的なもの|見えている未来|未来).*(どこ|場所|相手|誰|持っていけば|置けば|置く|届きやすい|受け取られ|動き始め|現実として動く)/u.test(
      currentUserText,
    ) ||
    /(どこに持っていけば|どこに置けば|誰に持っていけば|どんな場所|どんな相手|一番届きやすい|ちゃんと受け取られ|現実として動き始め)/u.test(
      currentUserText,
    );

  if (hasFuturePlacement) reasons.push('future_placement');

  const hasMarketCompetition =
    /(競合|競争|市場|ライバル|先を越され|先越され|遅れる|置いていかれる|スピード|急がないと|進めないと|止まれない)/u.test(
      currentUserText,
    );

  if (hasMarketCompetition) reasons.push('market_competition');

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

  if (reasons.includes('business_pressure')) {
    hints.push(
      '仕事や事業の文脈で、止まっていること自体が焦りを強めている可能性がある',
    );
  }

  if (reasons.includes('receiver_mismatch')) {
    hints.push(
      '内容そのものより、必要な場所や受け取れる相手に届いていないことが苦しさを作っている可能性がある',
    );
  }

  if (reasons.includes('future_gap')) {
    hints.push(
      '先に見えているものと、相手側の受け皿や理解の速度に差があり、手応えが消えやすくなっている可能性がある',
    );
  }

  if (reasons.includes('future_placement')) {
    hints.push(
      '未来を予測せず、最初に現実化する場所・相手・入口として扱う必要がある',
    );
  }

  if (reasons.includes('market_competition')) {
    hints.push(
      '競合や市場の圧があり、進めたい力が強いほど伝達や判断が重くなりやすい可能性がある',
    );
  }

  const shouldOpen = reasons.length > 0;

  const hasBusinessDeepRead =
    hasBusinessPressure ||
    hasReceiverMismatch ||
    hasFutureGap ||
    hasFuturePlacement ||
    hasMarketCompetition;

  const level: DeepReadLevel =
    !shouldOpen
      ? 'off'
      : (reasons.includes('sting_high') && hasCertaintyPressure) ||
          (hasBusinessDeepRead && reasons.includes('sting_high')) ||
          (hasReceiverMismatch && hasFutureGap) ||
          hasFuturePlacement
        ? 'middle'
        : reasons.includes('sting_high') ||
            reasons.includes('return_streak') ||
            reasons.includes('repeat_signal') ||
            hasBusinessDeepRead
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
      hasBusinessPressure,
      hasReceiverMismatch,
      hasFutureGap,
      hasFuturePlacement,
      hasMarketCompetition,
    },
  };
}
