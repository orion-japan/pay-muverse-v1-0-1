export type ObservationTargetKind =
  | 'Person'
  | 'Relationship'
  | 'Project'
  | 'Product'
  | 'Business'
  | 'Technical'
  | 'Creative'
  | 'Document'
  | 'Diagnosis'
  | 'CurrentSelf'
  | 'Unknown';

export type ObservationLock = {
  version: 'observation_lock_v1';
  active: boolean;
  targetKind: ObservationTargetKind;
  targetLabel: string | null;
  currentAsk: string | null;
  confidence: number;
  reason: string;
  blockedContextKinds: ObservationTargetKind[];
  allowedContextKinds: ObservationTargetKind[];
  source: 'current_user_text' | 'history_hint' | 'fallback';
};

type ResolveObservationTargetArgs = {
  userText: string;
  historyForTurn?: any[] | null;
  meta?: any;
};

function getTurnText(t: any): string {
  return String(
    t?.content ??
      t?.text ??
      t?.assistantText ??
      t?.message ??
      t?.body ??
      ''
  ).trim();
}

function normalizeText(v: unknown): string {
  return String(v ?? '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function compact(v: unknown): string {
  return String(v ?? '').replace(/[\s　]+/g, '').toLowerCase();
}

function getRecentHistoryText(historyForTurn: any[] | null | undefined): string {
  const tail = Array.isArray(historyForTurn) ? historyForTurn.slice(-6) : [];
  return tail.map(getTurnText).filter(Boolean).join('\n');
}

function pickProjectLabel(text: string): string | null {
  const s = normalizeText(text);
  const known = [
    'Muverse',
    'Mu',
    'IROS',
    'iros',
    'Sofia',
    'スクショ診断',
    'ステップメール',
    'TikTok',
    'SNS',
    'Moodle',
    'PAY.JP',
    'Supabase',
    'Firebase',
    'GitHub',
    'Vercel',
  ];

  for (const k of known) {
    if (s.includes(k)) return k;
  }

  const m = s.match(/([A-Za-z][A-Za-z0-9_-]{2,}|[一-龠ぁ-んァ-ンー]{2,12})(?:の)?(?:アプリ|サービス|事業|プロジェクト|導線|課金|実装|仕様|システム|サイト|LP|本線)/u);
  return m?.[1] ? m[1] : null;
}

function pickPersonLabel(text: string): string | null {
  const s = normalizeText(text);
  const m =
    s.match(/([一-龠ぁ-んァ-ンーA-Za-z]{2,16})(?:さん|ちゃん|くん|先生|氏)の/u) ??
    s.match(/([一-龠ぁ-んァ-ンーA-Za-z]{2,16})(?:について|との関係|とのこと|の状態|の気持ち)/u);

  const label = m?.[1] ? String(m[1]).trim() : null;
  if (!label) return null;
  if (/^(これ|それ|この|その|今|仕事|事業|アプリ|サービス|診断|スクショ診断|Muverse|IROS|Mu|Sofia)$/u.test(label)) return null;
  return label;
}

function inferCurrentAsk(text: string): string | null {
  const s = normalizeText(text);
  if (!s) return null;

  if (/(なんでわかるの|なぜわかる|理由|根拠|説明品質|返答品質|返信品質)/u.test(s)) {
    return '根拠説明・返信品質を確認したい';
  }
  if (/(課金|登録|導線|継続利用|ユーザー|拡散|SNS|投稿|ステップメール|分析|自動化)/iu.test(s)) {
    return '事業導線・継続利用・課金導線を整えたい';
  }
  if (/(実装|修正|改修|コード|バグ|エラー|ログ|typecheck|ビルド|デプロイ|Git|GitHub|PR|コミット|Supabase|SQL|API)/iu.test(s)) {
    return '実装・コード上の原因や修正方針を確認したい';
  }
  if (/(文章|文面|例文|返信文|LINE文|投稿文|台本|プロンプト|書いて|作って)/u.test(s)) {
    return '作成する文面・表現を整えたい';
  }
  if (/(今の僕|今の私|自分の状態|僕の状態|私の状態|状態見て|状態を見て)/u.test(s)) {
    return '現在の自分の状態を見たい';
  }
  if (/(診断|スクショ診断|IR診断|診断結果|診断内容)/u.test(s)) {
    return '診断内容の意味や続きを確認したい';
  }

  return null;
}

function makeLock(args: {
  targetKind: ObservationTargetKind;
  targetLabel: string | null;
  currentAsk: string | null;
  confidence: number;
  reason: string;
  blockedContextKinds: ObservationTargetKind[];
  allowedContextKinds: ObservationTargetKind[];
  source: ObservationLock['source'];
}): ObservationLock {
  return {
    version: 'observation_lock_v1',
    active: args.targetKind !== 'Unknown' && args.confidence >= 0.5,
    targetKind: args.targetKind,
    targetLabel: args.targetLabel,
    currentAsk: args.currentAsk,
    confidence: args.confidence,
    reason: args.reason,
    blockedContextKinds: args.blockedContextKinds,
    allowedContextKinds: args.allowedContextKinds,
    source: args.source,
  };
}

export function resolveObservationTarget(args: ResolveObservationTargetArgs): ObservationLock {
  const userText = normalizeText(args.userText);
  const recentHistoryText = getRecentHistoryText(args.historyForTurn);
  const combined = [recentHistoryText, userText].filter(Boolean).join('\n');
  const cUser = compact(userText);
  const cCombined = compact(combined);
  const currentAsk = inferCurrentAsk(userText);

  const hasTechnical = /(実装|修正|改修|コード|バグ|エラー|ログ|typecheck|typescript|ビルド|デプロイ|git|github|pr|コミット|supabase|sql|api|route\.ts|関数|ファイル)/iu.test(userText);
  if (hasTechnical) {
    return makeLock({
      targetKind: 'Technical',
      targetLabel: pickProjectLabel(userText) ?? '実装・コード',
      currentAsk,
      confidence: 0.92,
      reason: 'technical_terms_in_current_turn',
      blockedContextKinds: ['Person', 'Relationship', 'Diagnosis'],
      allowedContextKinds: ['Technical', 'Project', 'Product', 'Document'],
      source: 'current_user_text',
    });
  }

  const hasDocument = /(仕様書|書類|契約書|資料|PDF|docx|文書|章|原稿|レポート|特許書類)/iu.test(userText);
  if (hasDocument) {
    return makeLock({
      targetKind: 'Document',
      targetLabel: pickProjectLabel(userText) ?? '文書',
      currentAsk,
      confidence: 0.86,
      reason: 'document_terms_in_current_turn',
      blockedContextKinds: ['Person', 'Relationship'],
      allowedContextKinds: ['Document', 'Technical', 'Project', 'Creative'],
      source: 'current_user_text',
    });
  }

  const hasBusinessProject =
    /(アプリ|サービス|事業|プロジェクト|プロダクト|サイト|LP|導線|課金|登録|ユーザー|継続利用|拡散|SNS|投稿|分析|自動化|ステップメール|マーケ|集客|リリース|ローンチ|完成度|品質)/iu.test(userText) ||
    /(muverse|iros|sofia|moodle|pay\.jp|supabase|firebase|vercel|github)/iu.test(userText);

  if (hasBusinessProject) {
    const isBusiness = /(課金|登録|ユーザー|継続利用|拡散|SNS|投稿|分析|自動化|ステップメール|マーケ|集客|売上|プラン|サブスク)/iu.test(userText);
    return makeLock({
      targetKind: isBusiness ? 'Business' : 'Project',
      targetLabel: pickProjectLabel(combined) ?? 'プロジェクト',
      currentAsk,
      confidence: 0.9,
      reason: 'project_or_business_terms_in_current_turn',
      blockedContextKinds: ['Person', 'Relationship'],
      allowedContextKinds: ['Project', 'Product', 'Business', 'Technical', 'Document'],
      source: 'current_user_text',
    });
  }

  if (/(スクショ診断|スクリーンショット診断|画像診断|IR診断|診断結果|診断内容|診断ID)/u.test(userText)) {
    return makeLock({
      targetKind: 'Diagnosis',
      targetLabel: pickProjectLabel(userText) ?? '診断',
      currentAsk,
      confidence: 0.88,
      reason: 'diagnosis_terms_in_current_turn',
      blockedContextKinds: ['Person', 'Relationship', 'Project'].filter((k) => !/(人|相手|関係|みゆ|さん)/u.test(userText)) as ObservationTargetKind[],
      allowedContextKinds: ['Diagnosis', 'CurrentSelf', 'Relationship', 'Person'],
      source: 'current_user_text',
    });
  }

  if (/(画像|動画|プロンプト|VEO|Seedance|Kling|花火|台本|投稿文|コピー|デザイン|作って|描いて|生成)/iu.test(userText)) {
    return makeLock({
      targetKind: 'Creative',
      targetLabel: pickProjectLabel(userText) ?? '制作物',
      currentAsk,
      confidence: 0.84,
      reason: 'creative_task_terms_in_current_turn',
      blockedContextKinds: ['Person', 'Relationship', 'Diagnosis'],
      allowedContextKinds: ['Creative', 'Project', 'Document'],
      source: 'current_user_text',
    });
  }

  const personLabel = pickPersonLabel(userText);
  if (personLabel && /(関係|気持ち|状態|相手|彼|彼女|さん|ちゃん|くん|先生|氏|みゆ|リナ|畠山|田中|鬼木|浅野)/u.test(userText)) {
    const relationship = /(関係|恋愛|相手|彼|彼女|夫|妻|友達|仕事の関係|親子|家族)/u.test(userText);
    return makeLock({
      targetKind: relationship ? 'Relationship' : 'Person',
      targetLabel: personLabel,
      currentAsk,
      confidence: 0.82,
      reason: relationship ? 'relationship_terms_with_person_label' : 'person_label_in_current_turn',
      blockedContextKinds: ['Project', 'Technical', 'Document'],
      allowedContextKinds: ['Person', 'Relationship', 'Diagnosis', 'CurrentSelf'],
      source: 'current_user_text',
    });
  }

  if (/(今の僕|今の私|自分の状態|僕の状態|私の状態|状態見て|状態を見て|気分|不安|迷い|怖い|しんどい)/u.test(userText)) {
    return makeLock({
      targetKind: 'CurrentSelf',
      targetLabel: '現在の自分',
      currentAsk,
      confidence: 0.78,
      reason: 'current_self_state_terms',
      blockedContextKinds: ['Project', 'Technical', 'Document'],
      allowedContextKinds: ['CurrentSelf', 'Person', 'Relationship', 'Diagnosis'],
      source: 'current_user_text',
    });
  }

  const prevLock = args.meta?.extra?.observationLock ?? args.meta?.extra?.ctxPack?.observationLock ?? args.meta?.observationLock ?? null;
  if (prevLock && typeof prevLock === 'object' && prevLock.active === true && prevLock.targetKind) {
    const followupLike = /(それ|これは|この話|その話|先ほど|さっき|続き|同じ|比較|つまり|なんで|なぜ|理由|根拠|詳しく|もう少し)/u.test(userText);
    if (followupLike) {
      return makeLock({
        targetKind: prevLock.targetKind,
        targetLabel: prevLock.targetLabel ?? null,
        currentAsk: currentAsk ?? prevLock.currentAsk ?? null,
        confidence: Math.min(0.78, Number(prevLock.confidence ?? 0.7)),
        reason: 'followup_to_previous_observation_lock',
        blockedContextKinds: Array.isArray(prevLock.blockedContextKinds) ? prevLock.blockedContextKinds : [],
        allowedContextKinds: Array.isArray(prevLock.allowedContextKinds) ? prevLock.allowedContextKinds : [prevLock.targetKind],
        source: 'history_hint',
      });
    }
  }

  // 直近会話が強くプロジェクト/技術文脈で、現在入力が短い追質問なら維持する。
  if (/(muverse|アプリ|サービス|事業|プロジェクト|導線|課金|実装|コード|github|supabase|スクショ診断品質|なんでわかるの)/iu.test(cCombined) && /(それ|これ|同じ|比較|なんで|なぜ|理由|根拠|詳しく|もう少し|品質)/u.test(cUser)) {
    return makeLock({
      targetKind: /(実装|コード|github|supabase|エラー|修正)/iu.test(cCombined) ? 'Technical' : 'Project',
      targetLabel: pickProjectLabel(combined) ?? '直近プロジェクト',
      currentAsk,
      confidence: 0.72,
      reason: 'short_followup_to_recent_project_context',
      blockedContextKinds: ['Person', 'Relationship'],
      allowedContextKinds: ['Project', 'Business', 'Technical', 'Product'],
      source: 'history_hint',
    });
  }

  return makeLock({
    targetKind: 'Unknown',
    targetLabel: null,
    currentAsk,
    confidence: 0.2,
    reason: 'no_stable_observation_target_detected',
    blockedContextKinds: [],
    allowedContextKinds: [],
    source: 'fallback',
  });
}

export function shouldSuppressMemoryKindByObservationLock(args: {
  observationLock?: ObservationLock | null;
  memoryIntent?: string | null;
}): boolean {
  const lock = args.observationLock;
  const memoryIntent = String(args.memoryIntent ?? '').trim();
  if (!lock?.active || !memoryIntent) return false;

  const blocksPerson = lock.blockedContextKinds.includes('Person');
  const blocksRelationship = lock.blockedContextKinds.includes('Relationship');
  const blocksDiagnosis = lock.blockedContextKinds.includes('Diagnosis');

  if (blocksPerson && /person_state_recall|person_reference/u.test(memoryIntent)) return true;
  if (blocksRelationship && /relationship_recall/u.test(memoryIntent)) return true;
  if (blocksDiagnosis && /diagnosis_recall|ir_diagnosis_recall/u.test(memoryIntent)) return true;

  return false;
}
