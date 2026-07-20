import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_COACHING_NOTICE_SETTINGS,
  parseSiteSettingsPatch,
  validateEnabledCoachingNotice,
  type EditableSiteSettings,
} from '@/lib/site-settings';

const NOTICE_BUCKET = 'acti-attachments';
const NOTICE_PATH = 'system/coaching-notice.json';

export type CoachingNoticeSettings = Pick<
  EditableSiteSettings,
  'coaching_notice_enabled' | 'coaching_notice_title' | 'coaching_notice_body'
>;

function parseStoredNotice(input: unknown): CoachingNoticeSettings {
  const patch = parseSiteSettingsPatch(input);
  const notice = {
    ...DEFAULT_COACHING_NOTICE_SETTINGS,
    ...(patch.coaching_notice_enabled === undefined
      ? {}
      : { coaching_notice_enabled: patch.coaching_notice_enabled }),
    ...(patch.coaching_notice_title === undefined
      ? {}
      : { coaching_notice_title: patch.coaching_notice_title }),
    ...(patch.coaching_notice_body === undefined
      ? {}
      : { coaching_notice_body: patch.coaching_notice_body }),
  };
  validateEnabledCoachingNotice(notice);
  return notice;
}

export async function loadCoachingNoticeSettings(
  adminClient: SupabaseClient
): Promise<CoachingNoticeSettings> {
  const { data, error } = await adminClient.storage
    .from(NOTICE_BUCKET)
    .download(NOTICE_PATH);

  if (error || !data) {
    return { ...DEFAULT_COACHING_NOTICE_SETTINGS };
  }

  try {
    return parseStoredNotice(JSON.parse(await data.text()));
  } catch (error) {
    console.error('Invalid coaching notice settings in storage:', error);
    return { ...DEFAULT_COACHING_NOTICE_SETTINGS };
  }
}

export async function saveCoachingNoticeSettings(
  adminClient: SupabaseClient,
  settings: CoachingNoticeSettings
) {
  validateEnabledCoachingNotice(settings);
  const content = new TextEncoder().encode(JSON.stringify(settings));
  const { error } = await adminClient.storage
    .from(NOTICE_BUCKET)
    .upload(NOTICE_PATH, content, {
      cacheControl: '0',
      contentType: 'application/json; charset=utf-8',
      upsert: true,
    });

  if (error) throw error;
}
