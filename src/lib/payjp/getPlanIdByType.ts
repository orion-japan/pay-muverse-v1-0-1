import Payjp from 'payjp';

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

/**
 * plan_type から Pay.jp 上の plan.id を検索して返す
 */
export async function getPlanIdByType(planType: string): Promise<string | null> {
  try {
    const plans = await payjp.plans.list({ limit: 100 }); // 最大取得
    const matched = plans.data.find(
      (plan) => plan.metadata?.plan_type === planType || plan.id.includes(planType),
    );
    return matched?.id || null;
  } catch (error) {
    console.error('🔴 getPlanIdByType エラー:', error);
    return null;
  }
}
