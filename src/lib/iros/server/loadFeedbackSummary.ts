type SupabaseLike = {
  from: (table: string) => any;
};

export type IrosFeedbackSummary = {
  total: number;
  deepHitCount: number;
  goodCount: number;
  mismatchCount: number;
  lastLabels: string[];
  guidance: string;
};

export async function loadFeedbackSummary(
  supabase: SupabaseLike,
  userCode: string,
  limit = 20,
): Promise<IrosFeedbackSummary | null> {
  const normalizedUserCode = String(userCode ?? '').trim();

  if (!normalizedUserCode) return null;

  const { data, error } = await supabase
    .from('iros_message_feedback')
    .select('feedback_label, feedback_text, message_id, updated_at')
    .eq('user_code', normalizedUserCode)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[IROS/feedbackSummary] load failed', {
      userCode: normalizedUserCode,
      error: error.message,
    });
    return null;
  }

  const rows = Array.isArray(data) ? data : [];

  const deepHitCount = rows.filter((r: any) => r?.feedback_label === 'deep_hit').length;
  const goodCount = rows.filter((r: any) => r?.feedback_label === 'good').length;
  const mismatchCount = rows.filter((r: any) => r?.feedback_label === 'mismatch').length;

  const lastLabels = rows
    .map((r: any) => String(r?.feedback_label ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const guidanceParts: string[] = [];

  if (deepHitCount > 0) {
    guidanceParts.push(
      'deep_hit があるため、関係性・位置関係・言い当ての精度が高かった返答傾向を少し優先する。',
    );
  }

  if (goodCount > 0) {
    guidanceParts.push(
      'good があるため、現在の温度感・言葉の分かりやすさは維持する。',
    );
  }

  if (mismatchCount > 0) {
    guidanceParts.push(
      'mismatch があるため、断定しすぎ・関係の順序や由来の推測しすぎを避け、未確認の部分は分けて返す。',
    );
  }

  const guidance =
    guidanceParts.length > 0
      ? guidanceParts.join(' ')
      : 'まだ評価データが少ないため、通常の観測を優先する。';

  return {
    total: rows.length,
    deepHitCount,
    goodCount,
    mismatchCount,
    lastLabels,
    guidance,
  };
}
