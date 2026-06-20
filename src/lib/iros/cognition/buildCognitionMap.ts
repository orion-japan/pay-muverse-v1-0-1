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

function inferRelationCode(text: string, targetLabel?: string | null): CognitionRelationCode {
  const t = text.trim();

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

function inferGodai(text: string): CognitionGodai {
  if (/形|構成|設計|仕様|実装|コード|画面|UI|保存|DB|ファイル/.test(text)) return 'earth';
  if (/関係|相手|距離|恋愛|家族|つながり|会話/.test(text)) return 'water';
  if (/意図|やる|進める|決める|願い|目的|方向/.test(text)) return 'fire';
  if (/変化|移行|切り替|流れ|動き|拡散|展開/.test(text)) return 'wind';
  if (/可能性|創造|未来|根源|空|余白|神話|宇宙/.test(text)) return 'void';

  return null;
}

function inferSanmitsu(text: string): CognitionSanmitsu {
  if (/行動|やる|進める|実装|作る|修正|コミット|push|保存/.test(text)) return 'body';
  if (/言葉|文章|返信|表現|プロンプト|説明|書く|文言/.test(text)) return 'speech';
  if (/認識|状態|気持ち|意図|意味|構造|理解|見て/.test(text)) return 'mind';

  return null;
}

function inferTrigger(text: string): { kind: CognitionTriggerKind; text: string | null } {
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

function inferGap(text: string): { state: CognitionMap['gap']['state']; text: string | null } {
  if (/違う|ズレ|足りない|惜しい|もったいない|迷う|わからない|分からない|止まって|進まない/.test(text)) {
    return { state: 'exists', text: '現在地と行き先の間に差分がある' };
  }

  if (/OK|了解|できた|完了|通った|成功/.test(text)) {
    return { state: 'resolved', text: '直前の差分は解消方向にある' };
  }

  return { state: 'unknown', text: null };
}

function inferCurrentPosition(text: string): string | null {
  if (/実装|コード|typecheck|コミット|push/.test(text)) return '実装確認';
  if (/仕様|設計|構成/.test(text)) return '構造設計';
  if (/診断|深め/.test(text)) return '診断深化';
  if (/状態|今の/.test(text)) return '状態確認';
  if (/拡散|課金|導線/.test(text)) return '事業導線確認';

  return null;
}

function inferDestination(text: string): string | null {
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
  const relationCode = inferRelationCode(userText, input.targetLabel);
  const trigger = inferTrigger(userText);
  const gap = inferGap(userText);

  const currentPosition = inferCurrentPosition(userText);
  const destination = inferDestination(userText);

  const progress = normalizeCognitionProgress(
    /完了|通った|成功/.test(userText)
      ? '完成'
      : /実装|開始|入口|作る/.test(userText)
        ? '開始'
        : /移行|途中|進め/.test(userText)
          ? '移行中'
          : null,
  );

  const confidence =
    relationCode !== 'U' ||
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
      godai: inferGodai(userText),
      sanmitsu: inferSanmitsu(userText),
      juushin: null,
    },

    confidence,

    source: {
      kind: input.sourceKind ?? 'user_text',
      text: sourceText,
    },

    debug: {
      ...(input.debug ?? {}),
      inferredBy: 'buildCognitionMap.v1',
      userTextHead: userText.slice(0, 160),
    },
  });
}
