import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Plus Jakarta Sans: geometrica e cordiale, adatta a un prodotto che deve
// risultare accessibile anche a chi non fa l'elettronico di mestiere.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jbMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "PCB Studio",
  description: "Progetta elettronica reale conversando con un agente AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="it"
      className={`${jakarta.variable} ${jbMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-canvas text-text">{children}</body>
    </html>
  );
}
