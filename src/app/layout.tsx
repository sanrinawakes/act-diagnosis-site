import type { Metadata, Viewport } from 'next';
import './globals.css';
import Providers from '@/components/Providers';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: 'ACTIコーチングサイト',
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
    title: 'ACTIコーチングサイト',
    description: '個人の行動や思考を診断し、改善のためのコーチングを提供するプラットフォーム',
    siteName: 'ACT Coaching Platform',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ACTIコーチングサイト',
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
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
