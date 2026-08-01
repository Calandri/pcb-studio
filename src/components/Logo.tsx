/**
 * PCB Studio mark: an octagonal board outline, interrupted where two traces
 * enter and exit with their pad, and a waveform running across it. Drawn in
 * SVG and not cropped from the brand PNG: it lives at 26px in the header and
 * at 512px as the app icon, and must stay sharp.
 *
 * Brand green #0BA36C. In the dark workspace the accent
 * stays the lighter interface green: this one, on a near-black background,
 * would be unreadable.
 */
export function LogoMark({
  size = 32,
  boxed = true,
  className,
}: {
  size?: number;
  /** true = white symbol in the green square (app icon), false = stroke only */
  boxed?: boolean;
  className?: string;
}) {
  const stroke = boxed ? "#FFFFFF" : "#0BA36C";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden
    >
      {boxed && <rect width="64" height="64" rx="15" fill="#0BA36C" />}
      <g
        stroke={stroke}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* outline: upper-left arc, from the left edge to the upper-right corner */}
        <path d="M14 29.5V21.5L21.5 14H39.5L43.5 18" />
        {/* trace exiting top-right, toward the pad */}
        <path d="M43.5 18L46 20.5" />
        <circle cx="49.2" cy="23.7" r="3.1" />
        {/* outline: lower-right arc */}
        <path d="M50 35.5V42.5L42.5 50H24.5L20 45.5" />
        {/* trace exiting bottom-left, toward the pad */}
        <path d="M20 45.5L17.5 43" />
        <circle cx="14.3" cy="39.8" r="3.1" />
        {/* the waveform running across the board */}
        <path d="M9 32.5H23L27.5 20.5L33 44L37 32.5H55" />
      </g>
    </svg>
  );
}

/** Mark + name, the main project logo. */
export function Logo({
  size = 32,
  tagline = true,
  className,
}: {
  size?: number;
  tagline?: boolean;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark size={size} />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-bold tracking-[-0.01em] text-text">
          PCB Studio
        </span>
        {tagline && (
          <span className="mt-[3px] text-[11px] text-faint">AI PCB Designer</span>
        )}
      </span>
    </span>
  );
}
