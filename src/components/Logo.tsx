/**
 * Marchio PCB Studio: un contorno ottagonale di scheda, interrotto dove entrano
 * e escono due piste con la loro piazzola, e un tracciato d'onda che lo
 * attraversa. Disegnato in SVG e non ritagliato dal PNG del brand: qui vive a
 * 26px nell'intestazione e a 512px come icona dell'app, e deve restare nitido.
 *
 * Verde di marca #0BA36C (brand guidelines). Nel workspace scuro l'accento
 * resta il verde piu' chiaro dell'interfaccia: questo, su fondo quasi nero,
 * sarebbe illeggibile.
 */
export function LogoMark({
  size = 32,
  boxed = true,
  className,
}: {
  size?: number;
  /** true = simbolo bianco nel quadrato verde (icona app), false = solo tratto */
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
        {/* contorno: arco alto-sinistra, dal fianco sinistro allo spigolo alto-destra */}
        <path d="M14 29.5V21.5L21.5 14H39.5L43.5 18" />
        {/* pista che esce in alto a destra, verso la piazzola */}
        <path d="M43.5 18L46 20.5" />
        <circle cx="49.2" cy="23.7" r="3.1" />
        {/* contorno: arco basso-destra */}
        <path d="M50 35.5V42.5L42.5 50H24.5L20 45.5" />
        {/* pista che esce in basso a sinistra, verso la piazzola */}
        <path d="M20 45.5L17.5 43" />
        <circle cx="14.3" cy="39.8" r="3.1" />
        {/* il tracciato d'onda che attraversa la scheda */}
        <path d="M9 32.5H23L27.5 20.5L33 44L37 32.5H55" />
      </g>
    </svg>
  );
}

/** Marchio + nome, come nel logo principale delle brand guidelines. */
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
