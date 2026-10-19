import type { Metadata } from "next";
import localFont from "next/font/local";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import "./globals.css";

// Inter for text (the brand font), IBM Plex Mono for figures: columnar
// measurements must stay aligned and readable at small sizes.
//
// The files live in the repo (latin subset, SIL OFL 1.1, licenses next to
// them). With next/font/google every build downloaded them from Google, and on
// Vercel that download failed often enough to fail two deploys out of three.
const brandSans = localFont({
  variable: "--font-plex-sans",
  src: [{ path: "./fonts/inter-latin-var.woff2", weight: "400 700", style: "normal" }],
  display: "swap",
});

const plexMono = localFont({
  variable: "--font-plex-mono",
  src: [
    { path: "./fonts/plexmono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plexmono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plexmono-latin-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PCB Studio — la tua prossima scheda, progettata parlando",
  description:
    "Progetta elettronica reale conversando con un agente AI: schematico, sbroglio con le regole del produttore, distinta e scocca 3D. Gratis, con il tuo agente via MCP.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="it"
      className={`${brandSans.variable} ${plexMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-canvas text-text">
        {children}
        <FeedbackWidget />
      </body>
    </html>
  );
}
