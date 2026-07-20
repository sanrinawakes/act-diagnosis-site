import type { CoachingNotice } from '@/lib/site-settings';

type CoachingNoticeBannerProps = CoachingNotice & {
  className?: string;
};

export default function CoachingNoticeBanner({
  title,
  body,
  className = '',
}: CoachingNoticeBannerProps) {
  return (
    <section
      className={`border-l-4 border-red-600 bg-red-50 px-4 py-4 text-red-950 ${className}`}
      role="alert"
      aria-live="polite"
      data-testid="coaching-notice"
    >
      <p className="mb-1 text-xs font-bold text-red-700">重要なお知らせ</p>
      <h2 className="text-base font-bold sm:text-lg">{title}</h2>
      <p className="mt-2 whitespace-pre-line text-sm leading-6 sm:text-base sm:leading-7">
        {body}
      </p>
    </section>
  );
}
