// src/lib/iros/memory/buildFlowMeaning.ts
// iros — Flow Meaning Builder v1
// 目的:
// - state / flow / question を、writer が使える意味ラベルへ変換する
// - ここでは “説明” ではなく “刺さりの足場” を作る
// - 実際の注入は writerCalls 側で行う

export type FlowMeaningInput = {
  userText: string;

  depthStage?: string | null;
  qCode?: string | null;
  phase?: string | null;

  flowDelta?: string | null;
  returnStreak?: number | null;
  stingLevel?: string | null;
  flowDigest?: string | null;

  questionType?: string | null;
  questionDomain?: string | null;
  questionFocus?: string | null;
  questionTMode?: string | null;

  recallEligible?: boolean;
  recallScope?: string | null;
  recallReason?: string | null;

  topicDigest?: string | null;
  historyForWriterLen?: number | null;
};

export type FlowMeaningOutput = {
  flowMeaning: string;
  thisTurnHook: string;
  continuingTension: string;
  openLoop: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function lower(v: unknown): string {
  return norm(v).toLowerCase();
}

function isFutureQuestion(questionType: string, userText: string): boolean {
  const qt = lower(questionType);
  const ut = norm(userText);
  return qt.includes('future_design') || /これから|未来|今後/.test(ut);
}

function isLossCheck(userText: string): boolean {
  const ut = norm(userText);
  return /失う|失われ|薄くなる|なくなる|減る/.test(ut);
}

function isMeaningCheck(questionType: string): boolean {
  const qt = lower(questionType);
  return qt.includes('clarify') || qt.includes('meaning');
}

export function buildFlowMeaningV1(args: FlowMeaningInput): FlowMeaningOutput {
  const userText = norm(args.userText);
  const depthStage = norm(args.depthStage);
  const qCode = norm(args.qCode);
  const phase = norm(args.phase);
  const flowDelta = lower(args.flowDelta);
  const returnStreak = Number(args.returnStreak ?? 0);
  const stingLevel = lower(args.stingLevel);
  const questionType = norm(args.questionType);
  const questionFocus = norm(args.questionFocus);
  const questionTMode = norm(args.questionTMode);
  const recallEligible = Boolean(args.recallEligible);
  const recallScope = norm(args.recallScope);
  const recallReason = norm(args.recallReason);
  const historyForWriterLen = Number(args.historyForWriterLen ?? 0);

  let flowMeaning = 'いまの問いに対して、ひとまず輪郭を整えながら答える局面';
  let thisTurnHook = '一般論を増やしたいというより、自分の感覚に引っかかる一点を確かめたい';
  let continuingTension = '進みたい気持ちはあるが、まだ曖昧なまま進みたくはない';
  let openLoop = questionFocus || 'いま一番引っかかっている一点';

  if (flowDelta === 'return') {
    flowMeaning = '未整理の点に戻りながら、安心して進める輪郭を確かめている局面';
    continuingTension = '前に進むより先に、引っかかりを整えたい流れ';
    if (returnStreak >= 3) {
      flowMeaning = '同じ核に何度か戻りながら、まだ閉じていない点を見直している局面';
      continuingTension = '進めないのではなく、未完了のまま先へ行きたくない流れ';
    }
  } else if (flowDelta === 'forward') {
    flowMeaning = '先へ進む向きはあるが、進む前に何を失うかを見極めたい局面';
    continuingTension = '前進はできるが、代償や取りこぼしを把握しないまま進みたくない';
  } else if (flowDelta === 'spin') {
    flowMeaning = '同じテーマの周りを回りながら、まだ言語化し切れていない核心を探っている局面';
    continuingTension = '答えがないのではなく、焦点がまだ合い切っていない';
  }

  if (isFutureQuestion(questionType, userText) && isLossCheck(userText)) {
    thisTurnHook =
      '未来を楽観したいというより、便利さの先で何が薄くなるのかを先に確かめたい';
    openLoop = '何を失いたくないのか / 何を守りたいのか';
  } else if (isFutureQuestion(questionType, userText)) {
    thisTurnHook =
      '未来予測そのものより、自分はどこを見て次に進めばいいかを確かめたい';
    openLoop = '次の一手 / どの見方を採るか';
  } else if (isMeaningCheck(questionType)) {
    thisTurnHook =
      '表面の言い換えではなく、自分の中で実際に向きが変わる一点をつかみたい';
    openLoop = 'その一点をどう言い換えると腑に落ちるか';
  }

  if (depthStage.startsWith('S') || qCode === 'Q3') {
    flowMeaning += '。強く断定するより、まず安全な理解を作るほうが合う';
  }

  if (phase.toLowerCase() === 'outer') {
    continuingTension += '。内面整理だけでなく、現実の見方にもつなげたい';
  }

  if (stingLevel === 'high') {
    continuingTension += '。言葉の選び方しだいで刺さりにも負荷にもなりやすい';
  }

  if (recallEligible) {
    thisTurnHook += `。今回は ${recallScope || 'memory'} の記憶を使ってよい`;
    if (recallReason) {
      continuingTension += `（reason: ${recallReason}）`;
    }
  } else if (historyForWriterLen > 0) {
    continuingTension += '。ただし直近履歴はあるが、今回は無理につなげないほうが自然';
  }

  if (questionTMode) {
    openLoop = `${openLoop} / mode=${questionTMode}`;
  }

  const out: FlowMeaningOutput = {
    flowMeaning,
    thisTurnHook,
    continuingTension,
    openLoop,
  };

  console.log('[IROS/FLOW_MEANING][BUILD]', {
    userTextHead: userText.slice(0, 80),
    depthStage,
    qCode,
    phase,
    flowDelta,
    returnStreak,
    stingLevel,
    questionType,
    questionFocus,
    questionTMode,
    recallEligible,
    recallScope,
    recallReason,
    historyForWriterLen,
    out,
  });

  return out;
}
