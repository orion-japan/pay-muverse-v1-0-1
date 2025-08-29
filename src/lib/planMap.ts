export type ClickType = 'free' | 'pro' | 'master' | 'paused' | 'canceled' | 'trial' | string
export type PlanStatus = 'free' | 'pro' | 'master'

export const PLAN_MAP: Record<string, PlanStatus> = {
  free: 'free',
  trial: 'pro',     // 運用に合わせて調整
  pro: 'pro',
  master: 'master',
  paused: 'free',   // 一時停止はUI上free扱いにする場合
  canceled: 'free',
}

export function mapClickToPlan(click_type?: ClickType | null): PlanStatus {
  if (!click_type) return 'free'
  return PLAN_MAP[click_type] ?? 'free'
}
