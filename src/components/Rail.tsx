"use client";

import type { ReactNode } from "react";

export type RailKey = "projects" | "library" | "datasheets" | "team" | null;

const ICONS: Record<Exclude<RailKey, null>, ReactNode> = {
  projects: (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <path
        d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.4 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 15.8H4a1.5 1.5 0 0 1-1.5-1.5v-8.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  ),
  library: (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <rect x="6" y="6" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 6V3.4M12 6V3.4M8 14v2.6M12 14v2.6M6 8H3.4M6 12H3.4M14 8h2.6M14 12h2.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
  datasheets: (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <path
        d="M5 2.8h6.2L15.2 7v10.2H5V2.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M11 3v4h4M7.6 11h4.8M7.6 13.8h3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
      <circle cx="7.6" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.8 16c.5-2.6 2.4-4 4.8-4s4.3 1.4 4.8 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M13.4 5.2a2.4 2.4 0 0 1 0 4.6M14.6 12.4c1.6.5 2.5 1.8 2.8 3.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const LABELS: Record<Exclude<RailKey, null>, string> = {
  projects: "Progetti",
  library: "Libreria",
  datasheets: "Datasheet",
  team: "Team",
};

export function Rail({
  active,
  onSelect,
  counts,
}: {
  active: RailKey;
  onSelect: (key: RailKey) => void;
  counts: Partial<Record<Exclude<RailKey, null>, number>>;
}) {
  const keys = Object.keys(LABELS) as Array<Exclude<RailKey, null>>;
  return (
    <nav className="flex w-14 flex-none flex-col items-center gap-1 border-r border-edge bg-panel pb-3">
      <div className="mb-2 flex h-12 w-14 flex-none items-center justify-center border-b border-edge">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-solder-dim/40 bg-solder-dim/10">
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-solder">
          <path
            d="M3 10h3.2l1.6-4 2.4 8 1.8-4H17"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        </div>
      </div>

      {keys.map((key, i) => {
        const isActive = active === key;
        const count = counts[key];
        return (
          <button
            key={key}
            type="button"
            title={LABELS[key]}
            onClick={() => onSelect(isActive ? null : key)}
            style={{ animationDelay: `${60 + i * 45}ms` }}
            className={`power-on relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
              isActive
                ? "bg-raised text-solder"
                : "text-faint hover:bg-raised hover:text-dim"
            }`}
          >
            {ICONS[key]}
            {isActive && (
              <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-solder" />
            )}
            {typeof count === "number" && count > 0 && (
              <span className="absolute right-1 top-1.5 font-mono text-[9px] text-faint">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
