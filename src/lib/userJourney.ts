import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type UserJourneyEventInput = {
  userCode: string;
  eventName: string;
  source?: string;
  pagePath?: string | null;
  campaign?: string | null;
  mauticContactId?: string | number | null;
  mauticEmailId?: string | number | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string | null;
};

export type UserJourneySummary = {
  first_screenshot_completed: boolean;
  first_screenshot_used_at: string | null;
  screenshot_credit_count: number;
  last_page_path: string | null;
  last_page_viewed_at: string | null;
  last_mautic_event_name: string | null;
  last_mautic_event_at: string | null;
  mautic_email_sent: boolean;
  mautic_email_opened: boolean;
  mautic_button_clicked: boolean;
  recent_events: Array<{
    event_name: string;
    source: string | null;
    page_path: string | null;
    campaign: string | null;
    occurred_at: string | null;
  }>;
};

export async function recordUserJourneyEvent(input: UserJourneyEventInput) {
  const userCode = input.userCode?.trim();
  const eventName = input.eventName?.trim();

  if (!userCode || !eventName) return { ok: false, error: 'missing userCode or eventName' };

  const row = {
    user_code: userCode,
    event_name: eventName,
    source: input.source ?? 'app',
    page_path: input.pagePath ?? null,
    campaign: input.campaign ?? null,
    mautic_contact_id:
      input.mauticContactId == null ? null : String(input.mauticContactId),
    mautic_email_id: input.mauticEmailId == null ? null : String(input.mauticEmailId),
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt ?? new Date().toISOString(),
  };

  const { error } = await supabaseAdmin.from('user_journey_events').insert(row);

  if (error) {
    console.warn('[userJourney] insert failed', { userCode, eventName, message: error.message });
    return { ok: false, error: error.message };
  }

  return { ok: true };
}

export async function getUserJourneySummary(userCode: string): Promise<UserJourneySummary> {
  const code = userCode?.trim();
  const fallback: UserJourneySummary = {
    first_screenshot_completed: false,
    first_screenshot_used_at: null,
    screenshot_credit_count: 0,
    last_page_path: null,
    last_page_viewed_at: null,
    last_mautic_event_name: null,
    last_mautic_event_at: null,
    mautic_email_sent: false,
    mautic_email_opened: false,
    mautic_button_clicked: false,
    recent_events: [],
  };

  if (!code) return fallback;

  const [{ data: user }, { data: diag }, { data: events, error: eventsError }] = await Promise.all([
    supabaseAdmin
      .from('users')
      .select('screenshot_credit_count')
      .eq('user_code', code)
      .maybeSingle(),
    supabaseAdmin
      .from('mu_screenshot_diagnosis_logs')
      .select('used_at')
      .eq('user_code', code)
      .order('used_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('user_journey_events')
      .select('event_name, source, page_path, campaign, occurred_at')
      .eq('user_code', code)
      .order('occurred_at', { ascending: false })
      .limit(20),
  ]);

  const recent = eventsError ? [] : ((events ?? []) as UserJourneySummary['recent_events']);
  const lastPage = recent.find((e) => e.event_name === 'page_view' && e.page_path);
  const lastMautic = recent.find((e) => String(e.source ?? '').startsWith('mautic'));

  const hasEvent = (name: string) => recent.some((e) => e.event_name === name);

  return {
    first_screenshot_completed: !!diag?.used_at || hasEvent('first_screenshot_diagnosed'),
    first_screenshot_used_at: diag?.used_at ?? null,
    screenshot_credit_count: Number((user as any)?.screenshot_credit_count ?? 0),
    last_page_path: lastPage?.page_path ?? null,
    last_page_viewed_at: lastPage?.occurred_at ?? null,
    last_mautic_event_name: lastMautic?.event_name ?? null,
    last_mautic_event_at: lastMautic?.occurred_at ?? null,
    mautic_email_sent: hasEvent('mautic_email_sent'),
    mautic_email_opened: hasEvent('mautic_email_opened'),
    mautic_button_clicked: hasEvent('mautic_button_clicked'),
    recent_events: recent.slice(0, 10),
  };
}
