import "./globals.css";
import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";

const DESCRIPTION =
  "AI-watched Solana memecoin trading bot - paper mode by default, real market data, opt-in live trading";

export const metadata: Metadata = {
  metadataBase: new URL("https://memeoy.vercel.app"),
  title: "Memeoy",
  description: DESCRIPTION,
  keywords: ["solana", "memecoin", "trading bot", "ai agent", "paper trading", "crypto"],
  robots: { index: true, follow: true },
  openGraph: {
    title: "Memeoy",
    description: DESCRIPTION,
    url: "/",
    siteName: "Memeoy",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Memeoy",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
