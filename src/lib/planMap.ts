export type ClickType =
  | 'free'
  | 'regular'
  | 'premium'
  | 'pro'
  | 'master'
  | 'partner'
  | 'admin'
  | 'paused'
  | 'canceled'
  | 'trial'
  | string;

export type PlanStatus = 'free' | 'pro' | 'master';

export const PLAN_MAP: Record<string, PlanStatus> = {
  free: 'free',
  trial: 'pro',
  regular: 'pro',
  premium: 'pro',
  pro: 'pro',
  master: 'master',
  partner: 'master',
  admin: 'master',
  paused: 'free',
  canceled: 'free',
};

export function mapClickToPlan(click_type?: ClickType | null): PlanStatus {
  if (!click_type) return 'free';
  return PLAN_MAP[click_type] ?? 'free';
}
