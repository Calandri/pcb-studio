"use client";

import type { ReactNode } from "react";

export function Btn({
  children,
  onClick,
  type = "button",
  variant = "ghost",
  size = "md",
  disabled,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "ghost" | "primary" | "quiet" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs rounded-lg",
    md: "px-3.5 py-2 text-sm rounded-lg",
  } as const;
  const variants = {
    primary:
      "bg-brand text-ink shadow-sm hover:bg-brand-strong active:translate-y-px",
    ghost:
      "border border-line bg-surface text-muted hover:border-line-strong hover:text-text hover:bg-sunken",
    quiet: "text-muted hover:bg-sunken hover:text-text",
    danger: "text-danger hover:bg-danger-wash",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 font-medium transition-all disabled:pointer-events-none disabled:opacity-45 ${sizes[size]} ${variants[variant]} ${className}`}
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
  className = "",
}: {
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <input
      name={name}
      type={type}
      required={required}
      placeholder={placeholder}
      className={`rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-text outline-none transition-colors placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/15 ${className}`}
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
      className={`cursor-pointer rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm text-muted outline-none transition-colors focus:border-brand ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="section-label">{children}</p>;
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint && <p className="mt-1 text-xs leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "accent";
}) {
  const tones = {
    neutral: "bg-sunken text-faint",
    brand: "bg-brand-wash text-brand-strong",
    accent: "bg-accent-wash text-accent",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
