import type { Metadata, Viewport } from 'next';
import { Noto_Sans_JP } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';

const notoSansJp = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-noto-sans-jp',
  preload: true,
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: 'ACT診断コーチングサイト',
  description: '個人の行動や思考を診断し、改善のためのコーチングを提供するプラットフォーム',
  keywords: ['ACT', '診断', 'コーチング', 'メンタルヘルス', '行動'],
  authors: [{ name: 'ACT Coaching Platform' }],
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    url: 'https://act-diagnosis.com',
    title: 'ACT診断コーチングサイト',
    description: '個人の行動や思考を診断し、改善のためのコーチングを提供するプラットフォーム',
    siteName: 'ACT Coaching Platform',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ACT診断コーチングサイト',
    description: '個人の行動や思考を診断し、改善のためのコーチングを提供するプラットフォーム',
  },
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="theme-color" content="#dbeafe" />
      </head>
      <body className={`${notoSansJp.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
