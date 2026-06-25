export type MoodleTargetType = 'book' | 'course' | 'session' | 'message' | 'quiz' | 'assignment';

export type MoodleRole = 'student' | 'teacher' | 'editingteacher';

export type MoodleTarget = {
  target_key: string;
  target_type: MoodleTargetType;
  course_id: number;
  role: MoodleRole;
  redirect_path: string;
  volume?: number;
  title: string;
  subtitle?: string;
  free_url?: string;
};

export type MoodleUserAccessRecord = {
  user_code?: string | null;
  click_username?: string | null;
  click_type?: string | null;
  plan?: string | null;
  plan_status?: string | null;
  user_type?: string | null;
  subscription_status?: string | null;
  selected_volume?: string | number | null;
  selected_volume_month?: string | null;
  selected_volume_locked_at?: string | null;
};

export type MoodleAccessDecision = {
  ok: boolean;
  reason?: string;
  message?: string;
  role?: MoodleRole;
};

export const MOODLE_BOOK_TARGETS: MoodleTarget[] = Array.from({ length: 10 }, (_, index) => {
  const volume = index + 1;
  const courseId = index + 2;

  return {
    target_key: `mu_book_${volume}`,
    // 権限判定上は「Book読書対象」として扱う。
    // Moodleへの入場先は巻ごとの course/view.php。
    target_type: 'book',
    course_id: courseId,
    role: 'student',
    redirect_path: `/course/view.php?id=${courseId}`,
    volume,
    title: `第${volume}巻`,
    subtitle: `Mu Book 第${volume}巻`,
    free_url: volume === 1 ? '/free-book/vol1/chapter1' : undefined,
  };
});

export const MOODLE_TARGETS: Record<string, MoodleTarget> = Object.fromEntries(
  MOODLE_BOOK_TARGETS.map((target) => [target.target_key, target]),
);

export const ACCESS_REASON_MESSAGES: Record<string, string> = {
  not_logged_in: 'ログインが必要です。',
  free_requires_upgrade: '続きを読むには、プラン登録が必要です。',
  subscription_inactive: 'プランが有効ではありません。登録状況をご確認ください。',
  regular_volume_not_selected: '今月読む巻を選択してください。',
  regular_volume_not_allowed: 'レギュラープランでは、今月選択した巻のみ読むことができます。',
  session_not_allowed: 'セッション機能は、マスター以上のプランで利用できます。',
  course_not_allowed: 'この講座は、対象プランのユーザーのみ参加できます。',
  message_not_allowed: 'メッセージ機能は、対象プランのユーザーのみ利用できます。',
  unknown_target: '指定された教材が見つかりません。',
};

export function findMoodleTarget(targetKey: string): MoodleTarget | null {
  return MOODLE_TARGETS[targetKey] ?? null;
}

export function getAccessMessage(reason?: string) {
  if (!reason) return undefined;
  return ACCESS_REASON_MESSAGES[reason] ?? ACCESS_REASON_MESSAGES.unknown_target;
}

export function getTokyoMonthKey(date = new Date()) {
  // Asia/Tokyo の当月を YYYY-MM で固定する。
  const tokyo = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const year = tokyo.getUTCFullYear();
  const month = String(tokyo.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

export function getUserPlan(user: MoodleUserAccessRecord) {
  const candidates = [user.plan, user.plan_status, user.click_type];
  for (const candidate of candidates) {
    const value = normalized(candidate);
    if (['free', 'regular', 'premium', 'master', 'partner'].includes(value)) return value;
  }
  return 'free';
}

export function getUserType(user: MoodleUserAccessRecord) {
  const candidates = [user.user_type, user.click_type];
  for (const candidate of candidates) {
    const value = normalized(candidate);
    if (['free', 'regular', 'premium', 'master', 'partner', 'admin'].includes(value)) return value;
  }
  return 'free';
}

export function getSelectedVolume(user: MoodleUserAccessRecord) {
  const value = Number(user.selected_volume ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isSubscriptionActive(user: MoodleUserAccessRecord) {
  const raw = normalized(user.subscription_status);

  // 既存DBに subscription_status がまだない場合は、click_type / plan の権限を優先する。
  // カラム追加後は active / trialing / paid などを明示的に見る。
  if (!raw) return true;

  return ['active', 'trialing', 'paid', 'valid'].includes(raw);
}

function decision(ok: boolean, reason?: string, role: MoodleRole = 'student'): MoodleAccessDecision {
  return {
    ok,
    reason,
    message: getAccessMessage(reason),
    role: ok ? role : undefined,
  };
}

export function canAccessMoodleTarget(
  user: MoodleUserAccessRecord | null | undefined,
  target: MoodleTarget | null | undefined,
  now = new Date(),
): MoodleAccessDecision {
  if (!user?.user_code) return decision(false, 'not_logged_in');
  if (!target) return decision(false, 'unknown_target');

  const plan = getUserPlan(user);
  const userType = getUserType(user);
  const subscriptionActive = isSubscriptionActive(user);

  // Muverse admin は全Bookへ入れるが、SSOでMoodle管理者権限は渡さない。
  if (userType === 'admin') return decision(true, undefined, 'student');

  if (target.target_type === 'book') {
    if (plan === 'free') return decision(false, 'free_requires_upgrade');

    if (plan === 'regular') {
      if (!subscriptionActive) return decision(false, 'subscription_inactive');

      const selectedVolume = getSelectedVolume(user);
      const selectedMonth = String(user.selected_volume_month ?? '').trim();
      const currentMonth = getTokyoMonthKey(now);

      if (!selectedVolume || !selectedMonth || selectedMonth !== currentMonth) {
        return decision(false, 'regular_volume_not_selected');
      }

      if (selectedVolume !== target.volume) {
        return decision(false, 'regular_volume_not_allowed');
      }

      return decision(true, undefined, 'student');
    }

    if (plan === 'premium') {
      if (!subscriptionActive) return decision(false, 'subscription_inactive');
      return decision(true, undefined, 'student');
    }

    if (plan === 'master') {
      if (!subscriptionActive && userType !== 'master') return decision(false, 'subscription_inactive');
      return decision(true, undefined, 'student');
    }

    if (plan === 'partner' || userType === 'partner') {
      return decision(true, undefined, 'student');
    }

    return decision(false, 'free_requires_upgrade');
  }

  if (target.target_type === 'session') {
    if (plan === 'master' || plan === 'partner' || userType === 'master' || userType === 'partner') {
      return decision(true, undefined, 'student');
    }
    return decision(false, 'session_not_allowed');
  }

  if (target.target_type === 'course') {
    if (plan === 'partner' || userType === 'partner') return decision(true, undefined, 'student');
    return decision(false, 'course_not_allowed');
  }

  if (target.target_type === 'message') {
    if (plan === 'master' || plan === 'partner' || userType === 'master' || userType === 'partner') {
      return decision(true, undefined, 'student');
    }
    return decision(false, 'message_not_allowed');
  }

  return decision(false, 'unknown_target');
}
