import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

// Inter per il testo (font del brand), IBM Plex Mono per le cifre: le misure
// in colonna devono restare allineate e leggibili in corpo piccolo.
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
      <body className="min-h-full bg-canvas text-text">{children}</body>
    </html>
  );
}
