/**
 * Il template parametrico della scocca: un box in due gusci auto-dimensionato
 * sulla scheda. Il sorgente JSCAD generato qui passa dallo stesso worker delle
 * scocche scritte dall'AI — un solo modo di trasformare codice in mesh.
 *
 * Convenzione spaziale (vale per tutto il designer): millimetri, origine al
 * centro della scheda, z=0 faccia INFERIORE della scheda, z=1.6 faccia
 * superiore (piano componenti).
 */

export interface EnclosureParams {
  /** margine laterale fra bordo scheda e parete interna */
  clearanceMm: number;
  /** spessore delle pareti */
  wallMm: number;
  /** raggio degli spigoli esterni */
  cornerRadiusMm: number;
  /** spazio libero sotto la scheda (lato saldature) */
  bottomHeightMm: number;
  /** spazio libero sopra il piano componenti */
  topHeightMm: number;
  /** quota del piano di divisione dei gusci, sopra il piano componenti */
  splitMm: number;
  /** colonnine di fissaggio agli angoli della scheda */
  posts: boolean;
  color: string;
}

export const BOARD_THICKNESS_MM = 1.6;

export function defaultEnclosureParams(
  boardWidthMm: number | null,
  boardHeightMm: number | null,
): EnclosureParams {
  void boardWidthMm;
  void boardHeightMm;
  return {
    clearanceMm: 2,
    wallMm: 1.6,
    cornerRadiusMm: 3,
    bottomHeightMm: 3,
    topHeightMm: 10,
    splitMm: 2,
    posts: true,
    color: "#3BE8B0",
  };
}

/**
 * Genera il sorgente JSCAD della scocca. Contratto identico a quello delle
 * scocche AI: il corpo definisce `main(jscad)` e restituisce un geom3 o un
 * array di geom3. Il guscio inferiore ha pareti piene; il superiore ha la
 * cavita' allargata di mezzo spessore, cosi' scorre sopra le pareti
 * dell'inferiore come nei contenitori stampati veri.
 */
export function parametricEnclosureCode(
  boardWidthMm: number,
  boardHeightMm: number,
  p: EnclosureParams,
): string {
  const innerW = boardWidthMm + 2 * p.clearanceMm;
  const innerH = boardHeightMm + 2 * p.clearanceMm;
  const outerW = innerW + 2 * p.wallMm;
  const outerH = innerH + 2 * p.wallMm;
  const zBottom = -(p.bottomHeightMm + p.wallMm);
  const zSplit = BOARD_THICKNESS_MM + p.splitMm;
  const zTop = zSplit + p.topHeightMm + p.wallMm;
  // colonnine: a meta' fra bordo scheda e parete, dal fondo alla faccia
  // inferiore della scheda
  const postX = boardWidthMm / 2 + p.clearanceMm / 2;
  const postY = boardHeightMm / 2 + p.clearanceMm / 2;

  return `// scocca parametrica — generata, modificare dai parametri
function main(jscad) {
  const { cuboid, roundedCuboid, cylinder } = jscad.primitives;
  const { subtract, union } = jscad.booleans;
  const { translate } = jscad.transforms;

  const box = (w, h, z0, z1, r) =>
    r > 0
      ? roundedCuboid({ size: [w, h, z1 - z0], roundRadius: Math.min(r, (z1 - z0) / 2 - 0.01), center: [0, 0, (z0 + z1) / 2] })
      : cuboid({ size: [w, h, z1 - z0], center: [0, 0, (z0 + z1) / 2] });

  const outerR = ${p.cornerRadiusMm};

  // guscio inferiore: vassoio aperto sopra il piano di divisione
  const bottom = subtract(
    box(${outerW}, ${outerH}, ${zBottom}, ${zSplit}, outerR),
    box(${innerW}, ${innerH}, ${-p.bottomHeightMm}, ${zSplit + 0.01}, 0),
  );

  // guscio superiore: calotta la cui cavita' scorre sopra le pareti del vassoio
  const top = subtract(
    box(${outerW}, ${outerH}, ${zSplit}, ${zTop}, outerR),
    box(${innerW + p.wallMm}, ${innerH + p.wallMm}, ${zSplit - 0.01}, ${zSplit + p.topHeightMm}, 0),
  );

  ${p.posts ? `
  // colonnine di fissaggio: appoggio per la scheda, foro per vite M2
  const post = subtract(
    cylinder({ radius: 2.6, height: ${p.bottomHeightMm}, center: [0, 0, ${-p.bottomHeightMm / 2}] }),
    cylinder({ radius: 1.1, height: ${p.bottomHeightMm + 0.02}, center: [0, 0, ${-p.bottomHeightMm / 2}] }),
  );
  const posts = union(
    translate([${postX}, ${postY}, 0], post),
    translate([-${postX}, ${postY}, 0], post),
    translate([${postX}, -${postY}, 0], post),
    translate([-${postX}, -${postY}, 0], post),
  );
  return [union(bottom, posts), top];` : `
  return [bottom, top];`}
}
`;
}
