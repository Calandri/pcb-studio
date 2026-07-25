"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Applica il tema e lo ricorda; l'anti-lampo iniziale e' nello script del layout. */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("pcb-studio-theme", theme);
  } catch {
    // storage non disponibile: il tema vale solo per questa sessione
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const stored = (() => {
      try {
        return localStorage.getItem("pcb-studio-theme") as Theme | null;
      } catch {
        return null;
      }
    })();
    const initial =
      stored ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setThemeState(initial);
    applyTheme(initial);
  }, []);

  return [
    theme,
    (t: Theme) => {
      setThemeState(t);
      applyTheme(t);
    },
  ];
}

export function ThemeToggle({
  theme,
  onChange,
  compact = false,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
  compact?: boolean;
}) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={next === "dark" ? "Passa al tema scuro" : "Passa al tema chiaro"}
      className={`flex items-center justify-center rounded-lg text-faint transition-colors hover:bg-sunken hover:text-text ${
        compact ? "h-9 w-9" : "h-8 w-8"
      }`}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
          <circle cx="10" cy="10" r="3.4" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10 2.6v1.8M10 15.6v1.8M17.4 10h-1.8M4.4 10H2.6M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3M15.2 15.2l-1.3-1.3M6.1 6.1 4.8 4.8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
          <path
            d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
