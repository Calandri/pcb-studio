import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import "./globals.css";

// Inter for text (the brand font), IBM Plex Mono for figures: columnar
// measurements must stay aligned and readable at small sizes.
const brandSans = Inter({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
