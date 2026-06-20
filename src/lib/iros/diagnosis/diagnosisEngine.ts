// src/lib/iros/diagnosis/diagnosisEngine.ts

import { buildDiagnosisText } from './buildDiagnosisText';
import { chatComplete } from '@/lib/iros/openai';

function norm(v: unknown): string {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function pickObservedText(input: any, builtDebug: Record<string, unknown>): string {
  const debugObserved = norm((builtDebug as any)?.observedText);
  if (debugObserved) return debugObserved;

  const direct =
    norm(input?.userText) ||
    norm(input?.inputText) ||
    norm(input?.observedText) ||
    norm(input?.text);

  if (direct) return direct;

  const slots = input?.slots;

  if (Array.isArray(slots)) {
    for (const slot of slots) {
      const candidate =
        norm(slot?.userText) ||
        norm(slot?.text) ||
        norm(slot?.value) ||
        norm(slot?.content) ||
        norm(slot?.label);

      if (candidate) return candidate;
    }
  }

  if (slots && typeof slots === 'object') {
    const candidate =
      norm(slots.userText) ||
      norm(slots.text) ||
      norm(slots.value) ||
      norm(slots.content) ||
      norm(slots.label);

    if (candidate) return candidate;
  }

  return '';
}


function normalizeDiagnosisWording(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  let out = raw;

  out = out
    .replace(/静かに、?/g, '')
    .replace(/内側/g, '内面')
    .replace(/外側の/g, '表面の')
    .replace(/外側へ/g, '表面へ')
    .replace(/外側に/g, '表面に')
    .replace(/外へ/g, '表面へ')
    .replace(/外に/g, '表面に')
    .replace(/外の/g, '外界の')
    .replace(/自分の中で決める方向を先に置く/g, '自分の中で決める方向を先に決める')
    .replace(/一点を先に置く/g, '方向を先に決める')
    .replace(/一点を置く/g, '方向を決める')
    .replace(/立ち位置を一つ置く/g, '立ち位置を一つ決める')
    .replace(/場所を先に作る/g, '方向を先に決める')
    .replace(/場所を先に決める/g, '方向を先に決める')
    .replace(/場所を作る/g, '方向を決める')
    .replace(/場所を決める/g, '方向を決める')
    .replace(/方向を作る/g, '方向を決める')
    .replace(/を先に置く/g, 'を先に決める')
    .replace(/一点/g, '方向');

  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/、{2,}/g, '、')
    .replace(/。{2,}/g, '。')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function pickSelfAcceptance(input: any): number | null {
  const candidates = [
    input?.meta?.extra?.selfAcceptance,
    input?.meta?.extra?.self_acceptance,
    input?.meta?.extra?.ctxPack?.selfAcceptance,
    input?.meta?.extra?.ctxPack?.self_acceptance,
    input?.meta?.extra?.memoryStateSnapshot?.selfAcceptance,
    input?.meta?.extra?.ctxPack?.memoryStateSnapshot?.selfAcceptance,
    input?.meta?.selfAcceptance,
    input?.meta?.self_acceptance,
  ];

  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, Math.min(1, raw));
    }

    if (typeof raw === 'string' && raw.trim()) {
      const n = Number(raw);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
  }

  return null;
}

type SelfAcceptanceBandForDiagnosis = 'unknown' | 'low' | 'middle' | 'high';
type TargetScopeForDiagnosis = 'self' | 'other' | 'situation';
type FlowReadModeForDiagnosis =
  | 'self_state'
  | 'relational_reflection'
  | 'situation_reflection';
type SelfAcceptanceUseScope = 'self' | 'observer_correction';

function classifySelfAcceptanceForDiagnosis(
  selfAcceptance: number | null,
): SelfAcceptanceBandForDiagnosis {
  if (selfAcceptance == null) return 'unknown';
  if (selfAcceptance < 0.35) return 'low';
  if (selfAcceptance > 0.7) return 'high';
  return 'middle';
}

function isSelfTargetLabel(targetLabel: string): boolean {
  const s = norm(targetLabel)
    .replace(/\s+/g, '')
    .toLowerCase();

  return (
    !s ||
    s === '自分' ||
    s === '今の自分' ||
    s === '自分自身' ||
    s === '私' ||
    s === 'わたし' ||
    s === '俺' ||
    s === '僕' ||
    s === 'あなた自身' ||
    s === 'self' ||
    s === 'me'
  );
}

function classifyTargetScopeForDiagnosis(targetLabel: string): TargetScopeForDiagnosis {
  const raw = String(targetLabel ?? '').trim();
  const normalized = raw
    .replace(/[\s　]+/g, '')
    .replace(/さん|様|先生|くん|ちゃん/g, '');

  if (!normalized) return 'self';

  // ✅ 自分診断
  // 「自分」「私」「僕」などは本人の状態として読む。
  if (/^(自分|今の自分|自分自身|本当の自分|わたし|私|僕|俺|自分のこと)$/u.test(normalized)) {
    return 'self';
  }

  // ✅ 相手診断
  // 人物語が含まれる場合は、必ず相手側として読む。
  // 重要: 「浮気相手」は「浮気」より先にここで拾う。
  if (
    /(相手|浮気相手|不倫相手|彼|彼氏|彼女|妻|嫁|奥さん|夫|旦那|主人|恋人|好きな人|元彼|元カレ|元彼女|元カノ|友達|親友|上司|部下|同僚|社長|先生|母|父|親|子ども|息子|娘|兄|弟|姉|妹|家族|お客|顧客)/u.test(normalized)
  ) {
    return 'other';
  }

  // ✅ 人名らしいもの
  // 「対象人物A」「対象人物B」など、明確な物事ではない短い固有名は相手側に寄せる。
  if (
    /(さん|様|先生|くん|ちゃん)$/u.test(raw) ||
    (/^[ぁ-んァ-ヶ一-龠々ー・A-Za-z]{2,12}$/u.test(normalized) &&
      !/(仕事|計画|企画|事業|申請|助成金|映像|動画|投稿|サービス|アプリ|実装|開発|設計|関係|状況|状態|流れ|この件|問題|課題|浮気|不倫|離婚|連絡|返信|返事|予定|契約|資料|文章|プロンプト)/u.test(normalized))
  ) {
    return 'other';
  }

  // ✅ 事・状況診断
  // 人ではなく、出来事・計画・仕事・関係そのものとして読む。
  if (
    /(仕事|計画|企画|事業|申請|助成金|映像|動画|投稿|サービス|アプリ|実装|開発|設計|資料|文章|プロンプト|プロジェクト|契約|会議|打ち合わせ|この件|この問題|問題|課題|状況|状態|流れ|関係|関係性|浮気|不倫|離婚|連絡|返信|返事|予定|お金|売上|集客|TikTok|SNS|サイト|LP|講座|商品|企画書)/u.test(normalized)
  ) {
    return 'situation';
  }

  // ✅ 不明な対象は、診断では「相手側」に倒す。
  // 理由: 自分以外のラベルを自分診断へ吸わせる方が危険。
  return 'other';
}

function resolveFlowReadMode(targetScope: TargetScopeForDiagnosis): FlowReadModeForDiagnosis {
  if (targetScope === 'self') return 'self_state';
  if (targetScope === 'situation') return 'situation_reflection';
  return 'relational_reflection';
}

function buildTargetScopeMaterial(
  targetLabel: string,
  targetScope: TargetScopeForDiagnosis,
  flowReadMode: FlowReadModeForDiagnosis,
): string {
  if (targetScope === 'self') {
    return [
      '観測対象は自分自身。',
      '出たフローは、本人の今の状態に近いものとして読む。',
      '現状には、自分の中で実際に起きている止まり方、動き方、気になり方を現実語で書く。',
      `flowReadMode=${flowReadMode}`,
    ].join(' ');
  }

  if (targetScope === 'situation') {
    return [
      `観測対象は「${targetLabel}」という状況・場・テーマ。`,
      '出たフローは、状況そのものの絶対状態ではなく、観測者に映っている場の動き、詰まり、優先順位、扱い方として読む。',
      '人の内面や気持ちとして書かず、現実でどの判断・作業・条件が止まりやすいかを書く。',
      '状況診断では「内側」「気持ち」「心」などの人の心理に見える言葉を避け、判断・優先順位・進行・作業・条件・場の詰まりに置き換える。',
      `flowReadMode=${flowReadMode}`,
    ].join(' ');
  }

  return [
    `観測対象は「${targetLabel}」という相手。`,
    '出たフローは、相手本人の本心や事実の確定ではなく、関係の中に出ている相手側の状態として読む。',
    '相手の状態は必ず書く。ただし「本当はこう思っている」と断定しない。',
    '「相手側には〜が出ているように見える」「こちらから見ると〜に見える」の温度で書く。',
    'ユーザー自身の迷い、生活側の都合、家庭側の事情、守りたい線を、相手側の状態として書かない。',
    '対象が浮気相手・不倫相手・彼・彼女・妻・夫など人物の場合は、相手側の期待、不安、確かめたい気持ち、離れにくさ、待たされている感じ、関係をはっきりさせたい圧を中心に書く。',
    '対象が人物なら、状況診断のように「場の流れ」「守りたい線」「ここから先は増やせない」を主語にしない。必要なら「こちらから見ると、相手側には〜が出ているように見える」と明示する。',
    '一般論で終わらせず、読んだ人が強く反応する具体的な状態を一つ入れる。ただし「なんでわかるの？」という表現自体は出さない。',
    `flowReadMode=${flowReadMode}`,
  ].join(' ');
}

function buildSelfAcceptanceMaterial(
  selfAcceptance: number | null,
  scope: SelfAcceptanceUseScope,
  targetScope: TargetScopeForDiagnosis,
): string {
  const band = classifySelfAcceptanceForDiagnosis(selfAcceptance);

  if (scope === 'observer_correction') {
    if (targetScope === 'situation') {
      if (band === 'low') {
        return [
          'これは状況そのものの性質ではなく、観測者側の受け取り方の補正として使う。',
          '状況を見るときに、周りの反応や条件に意識を取られやすい。',
          '診断では、場の詰まりと、自分側で決める方向に変換する。',
        ].join(' ');
      }

      if (band === 'high') {
        return [
          'これは状況そのものの性質ではなく、観測者側の受け取り方の補正として使う。',
          '状況を見ても、自分が扱える範囲へ戻りやすい。',
          '診断では、場の動きと、今どこを整えると動きやすいかに変換する。',
        ].join(' ');
      }

      if (band === 'middle') {
        return [
          'これは状況そのものの性質ではなく、観測者側の受け取り方の補正として使う。',
          '状況の動きは見えているが、どこから手をつけるかはまだ決めきれない。',
          '診断では、状況の見え方と、自分側で決める方向に変換する。',
        ].join(' ');
      }

      return [
        '観測者側の補正値は未取得。',
        '診断では、内部フロー素材を状況の動きや扱い方として現実語に置き換える。',
      ].join(' ');
    }

    if (band === 'low') {
      return [
        'これは観測対象本人の状態ではなく、観測者側の受け取り方の補正として使う。',
        '相手や関係を見ようとすると、観測者側が周りの反応や距離感に意識を取られやすい。',
        '診断では、相手の内面を断定せず、「こちらから見ると関係がこう見えやすい」という形に変換する。',
      ].join(' ');
    }

    if (band === 'high') {
      return [
        'これは観測対象本人の状態ではなく、観測者側の受け取り方の補正として使う。',
        '相手や関係を見ても、観測者側が自分の感覚へ戻りやすく、相手と自分を切り分けて見やすい。',
        '診断では、相手の内面を断定せず、こちらがどう関わると見え方が整いやすいかに変換する。',
      ].join(' ');
    }

    if (band === 'middle') {
      return [
        'これは観測対象本人の状態ではなく、観測者側の受け取り方の補正として使う。',
        '相手の状態を見たい気持ちはあるが、自分がどう関わるか、どこまで決めるかも混ざりやすい。',
        '診断では、相手の内面を断定せず、関係上の見え方と自分側で決める方向に変換する。',
      ].join(' ');
    }

    return [
      '観測者側の補正値は未取得。',
      '診断では、対象本人の内面を断定せず、内部フロー素材を関係上の見え方として現実語に置き換える。',
    ].join(' ');
  }

  if (band === 'low') {
    return [
      '自分の感覚を後回しにしやすく、周りの反応や関係性に意識を取られやすい状態。',
      '現実では、自分が何をしたいかより、相手や場にどう見えるかが先に出やすい。',
      '診断では、表面の反応に合わせすぎて手が止まりやすい点として反映する。',
    ].join(' ');
  }

  if (band === 'high') {
    return [
      '自分の感覚に戻りやすく、必要なことを選び直しやすい状態。',
      '現実では、表面の反応に揺れても、自分が進めたいことへ戻る力が残っている。',
      '診断では、迷いを減らして自分の軸へ戻れる点として反映する。',
    ].join(' ');
  }

  if (band === 'middle') {
    return [
      '自分の感覚は見えているが、まだ決めきれずに表面の反応も気になりやすい状態。',
      '現実では、わかっているのに手が止まる、やりたいのに周りが気になる、という形で出やすい。',
      '診断では、自分の中で方向を決めると動きやすい点として反映する。',
    ].join(' ');
  }

  return '自己受容の数値は未取得。診断では、内部フロー素材を中心に現実の状態へ置き換える。';
}

export async function diagnosisEngine(input: any): Promise<any> {
  const built = buildDiagnosisText({
    targetLabel: input.targetLabel,
    meta: input.meta,
    slots: input.slots,
  });

  const debug = (built.debug ?? {}) as Record<string, unknown>;

  const targetLabel =
    norm(input?.targetLabel) ||
    norm(debug.targetLabel) ||
    '自分';

  const targetScope = classifyTargetScopeForDiagnosis(targetLabel);
  const flowReadMode = resolveFlowReadMode(targetScope);
  const targetScopeMaterial = buildTargetScopeMaterial(
    targetLabel,
    targetScope,
    flowReadMode,
  );

  const nowShort = norm(debug.nowFlowShort);
  const futureShort = norm(debug.futureFlowShort);
  const delta = norm(debug.deltaSentence);
  const observed = pickObservedText(input, debug);

  const selfAcceptance = pickSelfAcceptance(input);
  const selfAcceptanceBand = classifySelfAcceptanceForDiagnosis(selfAcceptance);
  const selfAcceptanceUseScope: SelfAcceptanceUseScope =
    targetScope === 'self' ? 'self' : 'observer_correction';
  const selfAcceptanceMaterial = buildSelfAcceptanceMaterial(
    selfAcceptance,
    selfAcceptanceUseScope,
    targetScope,
  );


  const ctxPackForDiagnosis = ((input?.meta as any)?.extra?.ctxPack ?? {}) as any;
  const relationshipMemoryForDiagnosis = ctxPackForDiagnosis?.relationshipMemory;

  const relationshipMemoryMaterial = (() => {
    if (!relationshipMemoryForDiagnosis || typeof relationshipMemoryForDiagnosis !== 'object') {
      return '（なし）';
    }

    const displayName = norm(
      relationshipMemoryForDiagnosis.display_name ??
        relationshipMemoryForDiagnosis.displayName ??
        ctxPackForDiagnosis.memoryTargetLabel,
    );

    const role = norm(relationshipMemoryForDiagnosis.role);

    const unresolvedTopics = Array.isArray(
      relationshipMemoryForDiagnosis.unresolved_topics ??
        relationshipMemoryForDiagnosis.unresolvedTopics,
    )
      ? (
          relationshipMemoryForDiagnosis.unresolved_topics ??
          relationshipMemoryForDiagnosis.unresolvedTopics
        )
          .map((v: unknown) => norm(v))
          .filter(Boolean)
          .slice(0, 4)
          .join(' / ')
      : '';

    const reactionPattern = Array.isArray(
      relationshipMemoryForDiagnosis.user_reaction_pattern ??
        relationshipMemoryForDiagnosis.userReactionPattern,
    )
      ? (
          relationshipMemoryForDiagnosis.user_reaction_pattern ??
          relationshipMemoryForDiagnosis.userReactionPattern
        )
          .map((v: unknown) => norm(v))
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ')
      : '';

    const factsText = Array.isArray(relationshipMemoryForDiagnosis.facts)
      ? relationshipMemoryForDiagnosis.facts
          .map((item: any) => norm(item?.value ?? item?.note ?? item?.key ?? item))
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ')
      : '';

    const patternsText = Array.isArray(relationshipMemoryForDiagnosis.patterns)
      ? relationshipMemoryForDiagnosis.patterns
          .map((item: any) => norm(item?.note ?? item?.value ?? item?.key ?? item))
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ')
      : '';

    const lines = [
      displayName ? `対象名：${displayName}` : '',
      role ? `関係上の役割：${role}` : '',
      unresolvedTopics ? `未整理テーマ：${unresolvedTopics}` : '',
      reactionPattern ? `ユーザー側の見方：${reactionPattern}` : '',
      factsText ? `関係メモ：${factsText}` : '',
      patternsText ? `読み方の補助：${patternsText}` : '',
      '使い方：相手の本心や事実として断定せず、関係の中に出ている反応点・距離感・進め方のズレを読む補助素材として使う。',
    ].filter(Boolean);

    return lines.length > 0 ? lines.join('\n') : '（なし）';
  })();

  const currentMaterial = norm((built.debug as any)?.observationResult);
  const pointMaterial = delta;
  const directionMaterial = norm((built.debug as any)?.awarenessText || delta);
  const messageMaterial = norm((built.debug as any)?.summaryText);

  // LLMに渡す素材は「このターンの診断素材」だけ。
  // 会話履歴の要約や、過去の流れの説明には寄せない。
  // 内部フローは、対象そのものの絶対状態ではなく、観測場に現れた反映として扱う。
  // 自分診断では本人状態、相手診断では相手側に出ている状態、状況診断では場の動きとして現実語に変換する。
  // SAは数値として出さず、自分診断では本人状態、相手/状況診断では観測者側の受け取り補正として使う。
  const isDetailMode =
    input?.meta?.extra?.detailMode === true ||
    input?.meta?.detailMode === true;

  const prompt = isDetailMode
    ? `
あなたは ir診断を行う存在です。

以下の素材だけを使って、前回の診断内容をよりわかりやすく説明してください。
会話の流れ、過去のやり取り、ユーザーの背景推測は使わないでください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【対象の読み方】
${targetScopeMaterial}


【現状の素材】
${currentMaterial}

【ポイントの素材】
${pointMaterial}

【意識の向かう先の素材】
${directionMaterial}

【メッセージの素材】
${messageMaterial}

【内部フロー素材】
今の流れ：${nowShort || '（なし）'}
向かう先：${futureShort || '（なし）'}
変化の要点：${delta || '（なし）'}

【自己受容の素材】
${selfAcceptanceMaterial}

【関係記憶の素材】
${relationshipMemoryMaterial}


---

出力ルール：
・必ず次の5項目だけをこの順番で出力する
  🌀 観測対象：
  🧭 現状：
  🧩 ポイント：
  🌿 意識の向かう先：
  🌱 メッセージ：

・各行は「見出し：本文」を同一行で書く
・出力はちょうど5行にする
・観測対象は入力された対象をそのまま書く

・フェーズ、位相、深度、S1、R1、C1、I1、T1、Inner、Outer などの内部分類名や記号は出さない
・targetScope、flowReadMode、SA、自己受容、selfAcceptance、数値、低い、高い、中間などの内部語は出さない
・内部フロー素材をそのまま説明しない
・感情や深度の変化は、現実の状況、優先順位、意識の向きに置き換えて書く
・自己受容の素材は、自分の感覚を後回しにしやすいか、自分の軸に戻りやすいかとして自然に反映する
・通常の意識の範囲で理解できる言葉にする
・会話の流れを読んでいるように書かない
・「これまで」「今まで」「前から」「最近」「ずっと」など、履歴を見ているような言い方は使わない
・ユーザーの過去、性格、背景、相手の本心を推測しない
・関係記憶の素材がある場合も、相手の本心や事実として断定せず、関係の中に出ている反応点・距離感・進め方のズレとして自然に反映する

・自分診断では、出たフローを本人の今の状態として書く
・相手診断では、相手側に出ている状態を必ず書く。ただし、本心・事実・確定判断として断定しない
・相手診断では、「相手側には〜が出ているように見える」「こちらから見ると〜に見える」の温度で書く
・相手診断では、一般論で終わらせず、具体的な状態を一つ入れる

・状況診断では、人の内面ではなく、場の動き・詰まり・優先順位・判断・作業の進み方として書く
・状況診断では、「内側」「気持ち」「心」「相手の反応」など、人の心理に見える言葉に寄せすぎない
・状況診断では、「表では動いているのに内側では慎重」ではなく、「表では進んでいるように見えても、判断や優先順位が固まりにくい」のように書く

・「現状」は、今その人や状況が現実でどんな状態に見えるかを書く
・「ポイント」は、助言ではなく、その人や状況の中で今いちばん出ている反応・迷い・選び方を状態として書く
・相手診断の「ポイント」は、「〜するとよい」「〜すると整う」「〜すると整理しやすい」「〜を決めると」「〜減りやすい」「〜変わりやすい」などの助言形で終えない
・相手診断の「ポイント」は、必ず「〜している状態です」「〜が出やすい状態です」「〜が分かれ始めている状態です」「〜を選ぼうとしている状態です」のような状態文で終える
・「意識の向かう先」は、自分/相手診断では気持ちや意識の向き、状況診断では次に扱う範囲・判断・優先順位として書く
・「メッセージ」は、診断全体を受け取りやすくする一文にする
・「メッセージ」は、「局面です」「定める」「一つの方向として」「整える」「決めることで」などの硬い言い方を避ける
・「メッセージ」は、「どちらを先に大事にするか」「見え方を分けるところ」「やり取りの温度が変わるところ」のような日常語で書く

・「悪いところ」「原因」「問題点」の指摘にしない
・抽象語を増やさず、日常語でわかりやすく書く
・「方向性」「次の段階」「実り」「基盤」「熱量」「意識・感情・行動」「収束」「境目」「整いやすくなる」「局面」「定める」などの抽象語・構造語・助言語はできるだけ使わない
・語彙ルール：「内側」は使わず「内面」と書く
・語彙ルール：「外側」「外」は文脈に応じて「表面」「外界」「周り」と書く
・語彙ルール：「置く」は使わず「決める」「定める」と書く
・語彙ルール：「一点」は使わず「方向」「一つの方向」と書く
・語彙ルール：「静かに」は使わない
・一文を長くしすぎない
・比喩は使ってもよいが、難しい象徴表現にしない
・説明しすぎない
・質問で終わらない
・太文字（**）は使わない
・前置き、補足、箇条書き、空行は入れない
`
    : `
あなたは ir診断を行う存在です。

以下の素材だけを使って、ir診断の結果を日本語で出力してください。
会話の流れ、過去のやり取り、ユーザーの背景推測は使わないでください。

【観測対象】
${targetLabel}

【ユーザー入力】
${observed || '（入力なし）'}

【対象の読み方】
${targetScopeMaterial}


【現状の素材】
${currentMaterial}

【ポイントの素材】
${pointMaterial}

【意識の向かう先の素材】
${directionMaterial}

【メッセージの素材】
${messageMaterial}

【内部フロー素材】
今の流れ：${nowShort || '（なし）'}
向かう先：${futureShort || '（なし）'}
変化の要点：${delta || '（なし）'}

【自己受容の素材】
${selfAcceptanceMaterial}

【関係記憶の素材】
${relationshipMemoryMaterial}


---

出力ルール：
・必ず次の5項目だけをこの順番で出力する
  🌀 観測対象：
  🧭 現状：
  🧩 ポイント：
  🌿 意識の向かう先：
  🌱 メッセージ：

・各行は必ず「見出し：本文」を同一行で書く（改行しない）
・出力はちょうど5行にする
・観測対象は入力された対象をそのまま書く

・フェーズ、位相、深度、S1、R1、C1、I1、T1、Inner、Outer などの内部分類名や記号は出さない
・targetScope、flowReadMode、SA、自己受容、selfAcceptance、数値、低い、高い、中間などの内部語は出さない
・「1枚目」「2枚目」「カード」「引いた結果」「出た結果」など、占いを連想させる言い方は使わない
・番号づけや手順説明のような書き方をしない

・内部フロー素材をそのまま説明しない
・感情や深度の変化は、現実の状況、優先順位、意識の向きに置き換えて書く
・自己受容の素材は、自分の感覚を後回しにしやすいか、自分の軸に戻りやすいかとして自然に反映する
・通常の意識の範囲で理解できる言葉にする
・会話の流れを読んでいるように書かない
・「これまで」「今まで」「前から」「最近」「ずっと」など、履歴を見ているような言い方は使わない
・ユーザーの過去、性格、背景、相手の本心を推測しない
・関係記憶の素材がある場合も、相手の本心や事実として断定せず、関係の中に出ている反応点・距離感・進め方のズレとして自然に反映する

・自分診断では、出たフローを本人の今の状態として書く
・相手診断では、相手側に出ている状態を必ず書く。ただし、本心・事実・確定判断として断定しない
・相手診断では、「相手側には〜が出ているように見える」「こちらから見ると〜に見える」の温度で書く
・相手診断では、一般論で終わらせず、具体的な状態を一つ入れる

・状況診断では、人の内面ではなく、場の動き・詰まり・優先順位・判断・作業の進み方として書く
・状況診断では、「内側」「気持ち」「心」「相手の反応」など、人の心理に見える言葉に寄せすぎない
・状況診断では、「表では動いているのに内側では慎重」ではなく、「表では進んでいるように見えても、判断や優先順位が固まりにくい」のように書く

・「現状」は、今その人や状況が現実でどんな状態に見えるかを書く
・「ポイント」は、助言ではなく、その人や状況の中で今いちばん出ている反応・迷い・選び方を状態として書く
・「ポイント」は、「〜するとよい」「〜すると整う」「〜すると整理しやすい」「〜を決めると」「〜すれば」「〜減りやすい」「〜変わりやすい」「〜和らぐ」のような助言形で終えない
・相手診断の「ポイント」は、必ず「〜している状態です」「〜が出やすい状態です」「〜が分かれ始めている状態です」「〜を選ぼうとしている状態です」「〜で少し止まりやすい状態です」のような状態文で終える
・「意識の向かう先」は、自分/相手診断では気持ちや意識の向き、状況診断では次に扱う範囲・判断・優先順位として書く
・「メッセージ」は、診断全体を受け取りやすくする一文にする
・「メッセージ」は、「局面です」「定める」「一つの方向として」「整える」「決めることで」などの硬い言い方を避ける
・「メッセージ」は、「どちらを先に大事にするか」「見え方を分けるところ」「やり取りの温度が変わるところ」のような日常語で書く

・「悪いところ」「原因」「問題点」の指摘にしない
・感情は直接的な言葉（怒り・不安・恐怖など）を避け、
  「少し引っかかる」「気分が沈みがち」「やや焦りやすい」など、
  日常的でやわらかい表現に言い換える

・「成長」「進化」「希望」「歓喜」などの抽象キーワードは使わない
・「方向性」「次の段階」「実り」「基盤」「熱量」「意識・感情・行動」「収束」「境目」「整いやすくなる」「整理しやすい」「局面」「定める」などの抽象語・構造語・助言語はできるだけ使わない
・使う場合は、「向かいたい先」「次にやること」「形になること」「足元の準備」「やりたい気持ち」「気持ちと行動」「切り替わるところ」のように言い換える
・語彙ルール：「内側」は使わず「内面」と書く
・語彙ルール：「外側」「外」は文脈に応じて「表面」「外界」「周り」と書く
・語彙ルール：「置く」は使わず「決める」と書く
・語彙ルール：「一点」は使わず「方向」「一つの方向」と書く
・語彙ルール：「静かに」は使わない
・難しい比喩に寄りすぎず、「一読でわかる」言葉にする
・専門的・詩的すぎる表現は避ける
・説明口調にしすぎない
・一文を長くしすぎない
・質問で終わらない

・太文字（**）は使わない
・前置き、補足、箇条書き、空行は入れない

---

出力例：
自分診断の例：
🌀 観測対象：今の自分
🧭 現状：やりたいことは見えてきていますが、周りの反応が気になって、まだ何から形にするかが少し定まりにくい状態です。
🧩 ポイント：考えを広げすぎることで迷いが出やすく、まず一つの方向に絞ろうとしている状態です。
🌿 意識の向かう先：表面の反応より、自分が今進めたいことへ意識を戻す方向です。
🌱 メッセージ：今は、全部を同時に動かすより、まず扱う範囲を小さくする流れが合っています。

相手診断の例：
🌀 観測対象：彼
🧭 現状：こちらから見ると、相手側には関係をはっきりさせたい気持ちと、踏み込みきれない感じが同時に出ているように見えます。
🧩 ポイント：相手側では、期待を持ちながらも、どこまで関わるかを決めきれずに少し止まりやすい状態です。
🌿 意識の向かう先：相手側の意識は、今の距離を保つことより、関係の扱い方を確かめたいほうへ向きやすい状態です。
🌱 メッセージ：今は、相手側に出ている迷いと期待を分けて見るところです。

状況診断の例：
🌀 観測対象：この件
🧭 現状：表では進んでいるように見えても、判断する範囲と優先順位がまだ固まりにくい状態です。
🧩 ポイント：動かす内容を増やすより、まず何を先に扱うかが分かれ始めている状態です。
🌿 意識の向かう先：次に扱う範囲を絞り、判断しやすい順番に並べるほうへ向かっています。
🌱 メッセージ：今は、全部を一度に動かすより、先に見る場所を分けるところです。
`;

  const text = await chatComplete({
    model: 'gpt-5',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.7,
  });

  const normalizedText = normalizeDiagnosisWording(text);

  const irMeta = {
    nowFlow: debug.nowFlow ?? null,
    futureFlow: debug.futureFlow ?? null,

    deltaType: debug.deltaType ?? null,
    deltaShort: debug.deltaShort ?? null,
    deltaSentence: debug.deltaSentence ?? null,

    flowA: debug.nowFlow ?? null,
    flowB: debug.futureFlow ?? null,
    relation: debug.deltaSentence ?? null,

    meaningCore: delta || null,
    meaningDirection: futureShort || null,
    meaningTension: nowShort || null,

    targetScope,
    flowReadMode,
    selfAcceptance,
    selfAcceptanceBand,
    selfAcceptanceUseScope,

    observedText: observed || null,
    targetLabel: targetLabel || null,

    observationResult: debug.observationResult ?? null,
    awarenessText: debug.awarenessText ?? null,
    summaryText: debug.summaryText ?? null,

    carryForward: true,
  };

  return {
    text: normalizedText,
    head: built.head,
    meta: {
      ...(input?.meta ?? {}),
      extra: {
        ...((input?.meta as any)?.extra ?? {}),
        irMeta,
        targetScope,
        flowReadMode,
        selfAcceptance,
        self_acceptance: selfAcceptance,
        selfAcceptanceUseScope,
        ctxPack: {
          ...(((input?.meta as any)?.extra?.ctxPack) ?? {}),
          irMeta,
          targetScope,
          flowReadMode,
          selfAcceptance,
          self_acceptance: selfAcceptance,
          selfAcceptanceUseScope,
        },
      },
    },
    debug: {
      ...debug,
      observedText: observed,
      rawText: typeof text === 'string' ? text.trim() : '',
      normalizedText,
      targetScope,
      flowReadMode,
      selfAcceptance,
      selfAcceptanceBand,
      selfAcceptanceUseScope,
      selfAcceptanceMaterial,
      targetScopeMaterial,
      irMeta,
    },
  };
}

