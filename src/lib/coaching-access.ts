export type CoachingAccessProfile = {
  role?: string | null;
  subscription_status?: string | null;
  is_active?: boolean | null;
  paid_test_credits?: number | null;
  awakes_access_started_at?: string | null;
  awakes_access_expires_at?: string | null;
};

export function hasActiveAwakesAccess(
  profile: CoachingAccessProfile | null | undefined,
  now = new Date()
) {
  if (
    profile?.subscription_status !== 'active' ||
    profile.is_active !== true ||
    !profile.awakes_access_expires_at
  ) {
    return false;
  }

  const expiresAt = Date.parse(profile.awakes_access_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function hasCoachingAccess(
  profile: CoachingAccessProfile | null | undefined,
  now = new Date()
) {
  return profile?.role === 'admin' || hasActiveAwakesAccess(profile, now);
}

export function hasPaidDiagnosisAccess(
  profile: CoachingAccessProfile | null | undefined,
  now = new Date()
) {
  return (
    hasCoachingAccess(profile, now) ||
    (profile?.paid_test_credits || 0) > 0
  );
}

export function isFormerAwakesMemberWithoutAccess(
  profile: CoachingAccessProfile | null | undefined,
  now = new Date()
) {
  if (!profile || profile.role === 'admin' || hasActiveAwakesAccess(profile, now)) {
    return false;
  }
  return (
    Boolean(profile.awakes_access_started_at) ||
    profile.subscription_status === 'expired' ||
    profile.subscription_status === 'cancelled' ||
    profile.subscription_status === 'payment_failed'
  );
}
