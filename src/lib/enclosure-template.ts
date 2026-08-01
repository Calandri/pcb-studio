/**
 * The parametric enclosure template: a two-shell box auto-sized on the board.
 * The JSCAD source generated here goes through the same worker as the
 * AI-written enclosures — one single way to turn code into a mesh.
 *
 * Spatial convention (applies to the whole designer): millimetres, origin at
 * the centre of the board, z=0 LOWER face of the board, z=1.6 upper face
 * (component plane).
 */

export interface EnclosureParams {
  /** side margin between board edge and inner wall */
  clearanceMm: number;
  /** wall thickness */
  wallMm: number;
  /** outer corner radius */
  cornerRadiusMm: number;
  /** clearance under the board (solder side) */
  bottomHeightMm: number;
  /** clearance above the component plane */
  topHeightMm: number;
  /** height of the shell split plane, above the component plane */
  splitMm: number;
  /** mounting posts at the board corners */
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
 * Generates the enclosure's JSCAD source. Same contract as the AI enclosures:
 * the body defines `main(jscad)` and returns a geom3 or an array of geom3.
 * The lower shell is a solid-walled tray; the upper one is a lid whose cavity
 * (tray exterior + clearance) slides over the lower shell's walls, like in
 * real moulded enclosures.
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
  // the lid slides OVER the tray walls: cavity = tray exterior + clearance,
  // lid exterior = cavity + walls. Without the clearance it does not snap on.
  const lidW = outerW + 0.4;
  const lidH = outerH + 0.4;
  const lidOuterW = lidW + 2 * p.wallMm;
  const lidOuterH = lidH + 2 * p.wallMm;
  const zBottom = -(p.bottomHeightMm + p.wallMm);
  const zSplit = BOARD_THICKNESS_MM + p.splitMm;
  const zTop = zSplit + p.topHeightMm + p.wallMm;
  // posts: halfway between board edge and wall, from the bottom to the
  // board's lower face
  const postX = boardWidthMm / 2 + p.clearanceMm / 2;
  const postY = boardHeightMm / 2 + p.clearanceMm / 2;

  return `// parametric enclosure — generated, edit via the parameters
function main(jscad) {
  const { cuboid, roundedCuboid, cylinder } = jscad.primitives;
  const { subtract, union } = jscad.booleans;
  const { translate } = jscad.transforms;

  const box = (w, h, z0, z1, r) =>
    r > 0
      ? roundedCuboid({ size: [w, h, z1 - z0], roundRadius: Math.min(r, (z1 - z0) / 2 - 0.01), center: [0, 0, (z0 + z1) / 2] })
      : cuboid({ size: [w, h, z1 - z0], center: [0, 0, (z0 + z1) / 2] });

  const outerR = ${p.cornerRadiusMm};

  // lower shell: tray open above the split plane
  const bottom = subtract(
    box(${outerW}, ${outerH}, ${zBottom}, ${zSplit}, outerR),
    box(${innerW}, ${innerH}, ${-p.bottomHeightMm}, ${zSplit + 0.01}, 0),
  );

  // upper shell: lid whose cavity slides over the tray walls
  const top = subtract(
    box(${lidOuterW}, ${lidOuterH}, ${zSplit}, ${zTop}, outerR),
    box(${lidW}, ${lidH}, ${zSplit - 0.01}, ${zSplit + p.topHeightMm}, 0),
  );

  ${p.posts ? `
  // mounting posts: seat for the board, hole for an M2 screw
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
