"use client";

import type { ReactNode } from "react";

/** Primitivi condivisi: bottoni, campi, badge dello strumento. */

export function Btn({
  children,
  onClick,
  type = "button",
  variant = "ghost",
  disabled,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "ghost" | "solid" | "danger";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none";
  const variants = {
    ghost:
      "border border-edge text-dim hover:border-edge-bright hover:text-ink hover:bg-raised",
    solid: "bg-solder-dim text-substrate hover:bg-solder",
    danger: "border border-edge text-alert hover:border-alert/60 hover:bg-alert/10",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  name,
  type = "text",
  placeholder,
  required,
  defaultValue,
  className = "",
}: {
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  className?: string;
}) {
  return (
    <input
      name={name}
      type={type}
      required={required}
      placeholder={placeholder}
      defaultValue={defaultValue}
      className={`rounded-md border border-edge bg-substrate px-2.5 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-faint focus:border-solder-dim ${className}`}
    />
  );
}

export function Select({
  name,
  options,
  className = "",
}: {
  name: string;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      name={name}
      className={`rounded-md border border-edge bg-substrate px-2 py-1.5 text-xs text-dim outline-none focus:border-solder-dim ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Silk({ children }: { children: ReactNode }) {
  return <p className="silk">{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-center text-xs text-faint">{children}</p>;
}
