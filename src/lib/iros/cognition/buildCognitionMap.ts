import {
  CognitionMap,
  CognitionRelationCode,
  CognitionGodai,
  CognitionSanmitsu,
  CognitionTriggerKind,
  createEmptyCognitionMap,
  normalizeCognitionProgress,
  relationCodeToDomain,
} from './cognitionMap';

export type BuildCognitionMapInput = {
  userText: string;
  targetLabel?: string | null;
  targetKey?: string | null;
  sourceKind?:
    | 'user_text'
    | 'diagnosis_text'
    | 'relationship_memory'
    | 'person_context'
    | 'preseed'
    | 'unknown';
  sourceText?: string | null;
  debug?: Record<string, any>;
};

function inferRelationCode(
  text: string,
  targetLabel?: string | null,
  sourceKind?: BuildCognitionMapInput['sourceKind'],
): CognitionRelationCode {
  const t = text.trim();

  if (sourceKind === 'diagnosis_text') return 'F';
  if (sourceKind === 'relationship_memory') return 'F';
  if (sourceKind === 'person_context') return targetLabel ? 'F' : 'U';

  if (/自分|僕|私|俺|わたし|自分自身|今の僕|今の私/.test(t)) return 'S';

  if (/母|父|親|子供|息子|娘|家族|兄|姉|弟|妹|祖母|祖父/.test(t)) return 'R';

  if (/会社|組織|チーム|社員|仕事|事業|社会|学校|コミュニティ/.test(t)) return 'C';

  if (/弟子|先生|師匠|専門家|共創|パートナー|創造|プロジェクト|実装|仕様|コード|Muverse|iros|IROS|Mu\b/.test(t)) {
    return /プロジェクト|実装|仕様|コード|Muverse|iros|IROS/.test(t) ? 'P' : 'I';
  }

  if (/彼|彼女|恋人|好き|相手|友達|友人|みゆ|リナ|畠山|田中|浅野|鬼木/.test(t)) return 'F';

  if (targetLabel && targetLabel.trim()) return 'F';

  return 'U';
}

function inferGodai(text: string, sourceKind?: BuildCognitionMapInput['sourceKind']): CognitionGodai {
  if (sourceKind === 'diagnosis_text' || sourceKind === 'relationship_memory') return 'water';
  if (sourceKind === 'person_context') return 'water';

  if (/形|構成|設計|仕様|実装|コード|画面|UI|保存|DB|ファイル/.test(text)) return 'earth';
  if (/関係|相手|距離|恋愛|家族|つながり|会話/.test(text)) return 'water';
  if (/意図|やる|進める|決める|願い|目的|方向/.test(text)) return 'fire';
  if (/変化|移行|切り替|流れ|動き|拡散|展開/.test(text)) return 'wind';
  if (/可能性|創造|未来|根源|空|余白|神話|宇宙/.test(text)) return 'void';

  return null;
}

function inferSanmitsu(text: string, sourceKind?: BuildCognitionMapInput['sourceKind']): CognitionSanmitsu {
  if (sourceKind === 'diagnosis_text') return 'mind';
  if (sourceKind === 'person_context' || sourceKind === 'relationship_memory') return 'mind';

  if (/行動|やる|進める|実装|作る|修正|コミット|push|保存/.test(text)) return 'body';
  if (/言葉|文章|返信|表現|プロンプト|説明|書く|文言/.test(text)) return 'speech';
  if (/認識|状態|気持ち|意図|意味|構造|理解|見て/.test(text)) return 'mind';

  return null;
}

function inferTrigger(
  text: string,
  sourceKind?: BuildCognitionMapInput['sourceKind'],
): { kind: CognitionTriggerKind; text: string | null } {
  if (sourceKind === 'diagnosis_text') {
    return { kind: 'clarification_needed', text: '診断結果の続きとして、相手の状態や意図を確認したい' };
  }

  if (sourceKind === 'person_context') {
    return { kind: 'clarification_needed', text: '対象人物について、既存文脈から現在地を確認したい' };
  }

  if (sourceKind === 'relationship_memory') {
    return { kind: 'expectation_gap', text: '関係の中で起きている期待差を確認したい' };
  }

  if (/惜しい|もったいない/.test(text)) {
    return { kind: 'potential_gap', text: '可能性との差分が見えている' };
  }

  if (/違う|ズレ|そうじゃない|戻って/.test(text)) {
    return { kind: 'direction_gap', text: '方向のズレを修正したい' };
  }

  if (/なぜ|なんで|どうして|理由/.test(text)) {
    return { kind: 'clarification_needed', text: '理由を明確にしたい' };
  }

  if (/止まって|詰まって|進まない|迷う|わからない|分からない/.test(text)) {
    return { kind: 'stuck_point', text: '進行を止めている点を見たい' };
  }

  if (/まだ|足りない|未完成|統合/.test(text)) {
    return { kind: 'unintegrated', text: 'まだ統合されていない部分がある' };
  }

  return { kind: 'unknown', text: null };
}

function inferGap(
  text: string,
  sourceKind?: BuildCognitionMapInput['sourceKind'],
): { state: CognitionMap['gap']['state']; text: string | null } {
  if (sourceKind === 'diagnosis_text') {
    return { state: 'exists', text: '診断本文の状況と、ユーザーが次に知りたい焦点の間に差分がある' };
  }

  if (sourceKind === 'person_context' || sourceKind === 'relationship_memory') {
    return { state: 'exists', text: '対象人物の既存文脈と、今回確認したい焦点の間に差分がある' };
  }

  if (/違う|ズレ|足りない|惜しい|もったいない|迷う|わからない|分からない|止まって|進まない/.test(text)) {
    return { state: 'exists', text: '現在地と行き先の間に差分がある' };
  }

  if (/OK|了解|できた|完了|通った|成功/.test(text)) {
    return { state: 'resolved', text: '直前の差分は解消方向にある' };
  }

  return { state: 'unknown', text: null };
}

function inferCurrentPosition(text: string, sourceKind?: BuildCognitionMapInput['sourceKind']): string | null {
  if (sourceKind === 'diagnosis_text') return '診断本文を正本にした続き相談';
  if (sourceKind === 'person_context') return '人物文脈の再参照';
  if (sourceKind === 'relationship_memory') return '関係記憶の再参照';

  if (/実装|コード|typecheck|コミット|push/.test(text)) return '実装確認';
  if (/仕様|設計|構成/.test(text)) return '構造設計';
  if (/診断|深め/.test(text)) return '診断深化';
  if (/状態|今の/.test(text)) return '状態確認';
  if (/拡散|課金|導線/.test(text)) return '事業導線確認';

  return null;
}

function inferDestination(text: string, sourceKind?: BuildCognitionMapInput['sourceKind']): string | null {
  if (sourceKind === 'diagnosis_text') return '診断の正本から、次に見るべき焦点へ着地する';
  if (sourceKind === 'person_context') return '対象人物の現在地・関係性・扱い方を整理する';
  if (sourceKind === 'relationship_memory') return '関係のズレと次の接し方を整理する';

  if (/実装|コード|修正|typecheck|コミット|push/.test(text)) return '動く形にする';
  if (/仕様|設計|構成/.test(text)) return '再現可能な構造にする';
  if (/診断|深め/.test(text)) return '読み解きを深める';
  if (/拡散|課金|導線/.test(text)) return '使われる導線にする';
  if (/創造|未来/.test(text)) return '創造方向へ進める';

  return null;
}

export function buildCognitionMap(input: BuildCognitionMapInput): CognitionMap {
  const userText = String(input.userText ?? '').trim();
  const sourceText = input.sourceText ?? userText;
  const sourceKind = input.sourceKind ?? 'user_text';
  const textForInference = sourceKind === 'user_text' || sourceKind === 'preseed'
    ? userText
    : [userText, sourceText].filter(Boolean).join('\n');

  const relationCode = inferRelationCode(textForInference, input.targetLabel, sourceKind);
  const trigger = inferTrigger(textForInference, sourceKind);
  const gap = inferGap(textForInference, sourceKind);

  const currentPosition = inferCurrentPosition(textForInference, sourceKind);
  const destination = inferDestination(textForInference, sourceKind);

  const progress = normalizeCognitionProgress(
    sourceKind === 'diagnosis_text' || sourceKind === 'person_context' || sourceKind === 'relationship_memory'
      ? '移行中'
      : /完了|通った|成功/.test(userText)
        ? '完成'
        : /実装|開始|入口|作る/.test(userText)
          ? '開始'
          : /移行|途中|進め/.test(userText)
            ? '移行中'
            : null,
  );

  const confidence =
    sourceKind === 'diagnosis_text' || sourceKind === 'person_context' || sourceKind === 'relationship_memory'
      ? 0.82
      : relationCode !== 'U' ||
          currentPosition ||
          destination ||
          gap.state !== 'unknown' ||
          trigger.kind !== 'unknown'
        ? 0.72
        : 0.35;

  return createEmptyCognitionMap({
    targetLabel: input.targetLabel ?? null,
    targetKey: input.targetKey ?? null,

    relationCode,
    relationDomain: relationCodeToDomain(relationCode),

    currentPosition,
    destination,
    progress,

    gap,
    trigger,

    worldTags: {
      godai: inferGodai(textForInference, sourceKind),
      sanmitsu: inferSanmitsu(textForInference, sourceKind),
      juushin: null,
    },

    confidence,

    source: {
      kind: sourceKind,
      text: sourceText,
    },

    debug: {
      ...(input.debug ?? {}),
      inferredBy: 'buildCognitionMap.v2',
      sourceKind,
      userTextHead: userText.slice(0, 160),
      sourceTextHead: String(sourceText ?? '').slice(0, 160),
    },
  });
}
