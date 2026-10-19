"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * When the root layout itself throws, error.tsx cannot help: it lives inside
 * that layout. This file replaces the whole document, so it brings its own
 * <html> and <body>, and its colors are written inline: if the stylesheet is
 * what failed, the page must still be readable.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="it">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B100F",
          color: "#E7EFEC",
          fontFamily: "system-ui, sans-serif",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 460 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>PCB Studio non è riuscito a partire</h2>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#8A9C96" }}>
            I progetti salvati non sono stati toccati. Riprova tra un momento.
          </p>
          {error.digest && (
            <p style={{ fontSize: 11, fontFamily: "monospace", color: "#5F726C" }}>
              codice {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              marginTop: 8,
              border: 0,
              borderRadius: 8,
              padding: "8px 14px",
              background: "#3BE8B0",
              color: "#06110D",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Riprova
          </button>
        </div>
      </body>
    </html>
  );
}
