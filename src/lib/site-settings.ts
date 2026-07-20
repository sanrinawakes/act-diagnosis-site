import type { SiteSettings } from '@/lib/types';

export const COACHING_NOTICE_TITLE_MAX_LENGTH = 120;
export const COACHING_NOTICE_BODY_MAX_LENGTH = 1200;

export const DEFAULT_COACHING_NOTICE_SETTINGS = {
  coaching_notice_enabled: true,
  coaching_notice_title: 'AIコーチングBotのご利用について',
  coaching_notice_body:
    '先日、「AIコーチングBotを改善しました」とご案内しましたが、その後の追加検証で、応答の安定性と会話内容に、さらに修正が必要な点が見つかりました。十分な確認が終わる前にご案内してしまい、本当に申し訳ございません。現在、修正と検証を進めています。修正完了のご案内まで、AIコーチングBotのご利用を数日お待ちくださいますようお願いいたします。完了後、あらためてご案内します。',
} satisfies Pick<
  SiteSettings,
  'coaching_notice_enabled' | 'coaching_notice_title' | 'coaching_notice_body'
>;

export type EditableSiteSettings = Pick<
  SiteSettings,
  | 'bot_enabled'
  | 'maintenance_mode'
  | 'coaching_notice_enabled'
  | 'coaching_notice_title'
  | 'coaching_notice_body'
>;

export type CoachingNotice = {
  title: string;
  body: string;
};

const editableBooleanFields = [
  'bot_enabled',
  'maintenance_mode',
  'coaching_notice_enabled',
] as const;

const editableTextFields = [
  ['coaching_notice_title', COACHING_NOTICE_TITLE_MAX_LENGTH, '告知の見出し'],
  ['coaching_notice_body', COACHING_NOTICE_BODY_MAX_LENGTH, '告知の本文'],
] as const;

export function getVisibleCoachingNotice(
  settings:
    | Pick<
        SiteSettings,
        'coaching_notice_enabled' | 'coaching_notice_title' | 'coaching_notice_body'
      >
    | null
    | undefined
): CoachingNotice | null {
  if (!settings?.coaching_notice_enabled) return null;

  const title = settings.coaching_notice_title.trim();
  const body = settings.coaching_notice_body.trim();
  return title && body ? { title, body } : null;
}

export function parseSiteSettingsPatch(input: unknown): Partial<EditableSiteSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('設定内容が正しくありません');
  }

  const record = input as Record<string, unknown>;
  const patch: Partial<EditableSiteSettings> = {};

  for (const field of editableBooleanFields) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'boolean') {
      throw new Error(`${field} は true または false で指定してください`);
    }
    patch[field] = record[field];
  }

  for (const [field, maxLength, label] of editableTextFields) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string') {
      throw new Error(`${label}は文字列で指定してください`);
    }
    const value = record[field].trim();
    if (value.length > maxLength) {
      throw new Error(`${label}は${maxLength}文字以内で入力してください`);
    }
    patch[field] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('変更する設定がありません');
  }

  return patch;
}

export function validateEnabledCoachingNotice(
  settings: Pick<
    EditableSiteSettings,
    'coaching_notice_enabled' | 'coaching_notice_title' | 'coaching_notice_body'
  >
) {
  if (!settings.coaching_notice_enabled) return;
  if (!settings.coaching_notice_title.trim()) {
    throw new Error('告知を表示する場合は見出しを入力してください');
  }
  if (!settings.coaching_notice_body.trim()) {
    throw new Error('告知を表示する場合は本文を入力してください');
  }
}
