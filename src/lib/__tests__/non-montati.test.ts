import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * sbb-dl-principale, 16/11/2026: J5, a Tag-Connect TC2030-NL written with
 * doNotPlace (only a footprint the programming cable presses on), was in the
 * pick-and-place file ("J5",10.860,-11.450,"bottom",180) and in the BOM.
 * PCB Basic, who assembles the boards, would have been asked to place a part
 * that does not exist. Such a part stays out of both, its pads and holes stay
 * in the Gerber, and it goes to distinta_non_montati.csv; a board without one
 * gives the files it always gave.
 */

const db = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
}));
vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return { ...vero, getProject: vi.fn(async () => db.files), getCompileCache: vi.fn(async () => db.row) };
});

import JSZip from "jszip";
import { convertCircuitJsonToPickAndPlaceRows } from "circuit-json-to-pnp-csv";
import { GET as esporta } from "@/app/api/export/route";
import { buildBoardReport } from "@/lib/board-report";
import {
  bomToCsv,
  buildBom,
  buildNonMontati,
  centriDiMontaggio,
  nonMontatiToCsv,
  pnpToCsv,
  righeCpl,
} from "@/lib/bom";
import { compileGeometryOnly } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { nomiNonMontati } from "@/lib/non-montati";
import { filesHash } from "@/lib/project-store";

type El = Record<string, unknown> & { type: string };

/** the pick and place as it was written before 16/11/2026: every pcb_component, none left out */
const cplDiPrima = (cj: unknown[]) =>
  pnpToCsv(centriDiMontaggio(convertCircuitJsonToPickAndPlaceRows(cj as never), cj));

// ---------------------------------------------------------------------------
// a hand-written circuit: two parts mounted, J5 not, on the bottom
// ---------------------------------------------------------------------------

const PARTI = `export const Parti = () => (
  <>
    <resistor name="R1" resistance="10k" footprint="0402" supplierPartNumbers={{ jlcpcb: ["C25744"] }} description="partitore" />
    <chip name="U1" footprint="soic8" manufacturerPartNumber="TCA6408APWR" />
    <chip name="J5" description={"connettore di programmazione Tag-Connect TC2030-NL, senza componente (non montare)"} manufacturerPartNumber="TC2030-NL" doNotPlace layer="bottom" footprint={<footprint><smtpad name="J9" portHints={["1"]} shape="circle" radius={0.39} /></footprint>} />
  </>
)
`;
const SORGENTI = { "parti.tsx": PARTI };

const scritto = (nonMontato: boolean): El[] => [
  { type: "source_component", source_component_id: "s1", ftype: "simple_resistor", name: "R1", display_resistance: "10kΩ", supplier_part_numbers: { jlcpcb: ["C25744"] } },
  { type: "source_component", source_component_id: "s2", ftype: "simple_chip", name: "U1", manufacturer_part_number: "TCA6408APWR" },
  { type: "source_component", source_component_id: "s3", ftype: "simple_chip", name: "J5", manufacturer_part_number: "TC2030-NL" },
  { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: -2, y: 1 }, layer: "top", rotation: 90, do_not_place: false },
  { type: "pcb_component", pcb_component_id: "p2", source_component_id: "s2", center: { x: 4, y: -3 }, layer: "bottom", rotation: -90, do_not_place: false },
  { type: "pcb_component", pcb_component_id: "p3", source_component_id: "s3", center: { x: 10.86, y: -11.45 }, layer: "bottom", rotation: 180, do_not_place: nonMontato },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad3", pcb_component_id: "p3", shape: "circle", x: 10.86, y: -11.45, radius: 0.39, layer: "bottom" },
];

describe("a part that is not mounted", () => {
  const cj = scritto(true);

  it("is read from pcb_component.do_not_place, the field tscircuit writes for doNotPlace", () => {
    expect([...nomiNonMontati(cj)]).toEqual(["J5"]);
    expect(nomiNonMontati(scritto(false)).size).toBe(0);
    expect(buildBoardReport(cj, null).nonMontati).toEqual(["J5"]);
  });

  it("is out of the pick and place; the other rows are the ones they always were", () => {
    const cpl = pnpToCsv(righeCpl(cj));
    expect(cpl).not.toMatch(/J5/);
    const prima = cplDiPrima(cj).split("\r\n");
    expect(prima.some((r) => r.startsWith('"J5"'))).toBe(true);
    expect(cpl).toBe(prima.filter((r) => !r.startsWith('"J5"')).join("\r\n"));
    expect(cpl.split("\r\n")).toEqual([
      "Designator,Mid X,Mid Y,Layer,Rotation",
      `"R1",-2.000,1.000,"top",90`,
      `"U1",4.000,-3.000,"bottom",270`,
    ]);
  });

  it("is out of the BOM; the other rows are the ones they always were", () => {
    const bom = buildBom(cj, SORGENTI);
    expect(bom.map((r) => r.designators)).toEqual(["R1", "U1"]);
    // the same rows as a board where J5 was never written
    const senzaJ5 = cj.filter((e) => e.source_component_id !== "s3");
    expect(bom).toEqual(buildBom(senzaJ5, { "parti.tsx": PARTI.replace(/ {4}<chip name="J5".*\n/, "") }));
    expect(bomToCsv(bom)).not.toMatch(/J5|TC2030/);
  });

  it("is in its own file, on its face, where the pick and place had it, with its note", () => {
    const righe = buildNonMontati(cj, SORGENTI);
    expect(righe).toEqual([
      {
        designator: "J5",
        footprint: "<footprint> inline",
        manufacturerPartNumber: "TC2030-NL",
        lcsc: "",
        layer: "bottom",
        x: 10.86,
        y: -11.45,
        rotation: 180,
        nota: "connettore di programmazione Tag-Connect TC2030-NL, senza componente (non montare)",
      },
    ]);
    // the very position and rotation the old pick and place wrote for it
    expect(cplDiPrima(cj)).toContain(`"J5",10.860,-11.450,"bottom",180`);
    expect(nonMontatiToCsv(righe)).toBe(
      `"Nome","Impronta","Codice produttore (MPN)","Codice LCSC","Lato","X (mm)","Y (mm)","Rotazione","Nota"\n` +
        `"J5","<footprint> inline","TC2030-NL","","bottom",10.860,-11.450,180,"connettore di programmazione Tag-Connect TC2030-NL, senza componente (non montare)"\n`,
    );
  });

  it("takes its note from `nota` first, then `description`; code, control characters and formulas are not written as they are", () => {
    const conNota = (attrs: string) => ({
      "parti.tsx": `export const P = () => <chip name="J5" footprint="soic8" doNotPlace ${attrs} />\n`,
    });
    const nota = (attrs: string) => buildNonMontati(cj, conNota(attrs))[0].nota;
    expect(nota(`nota="distanziale nylon M2.5, lo montiamo noi" description="altro"`)).toBe("distanziale nylon M2.5, lo montiamo noi");
    expect(nota(`description={"solo impronta"}`)).toBe("solo impronta");
    expect(nota(`nota={descrizioni.J5} description="ripiego"`)).toBe("ripiego");
    // a note written over more lines, with a tab: one line in the file
    expect(nota(`nota="prima riga\n  seconda\triga\r"`)).toBe("prima riga seconda riga");
    expect(nota(`nota={"${"x".repeat(400)}"}`)).toHaveLength(300);
    expect(nota("")).toBe("");
  });

  it("writes every text cell as data: a formula gets its apostrophe, quotes are doubled", () => {
    const [riga] = buildNonMontati(cj, { "parti.tsx": `export const P = () => <chip name="J5" footprint="soic8" doNotPlace nota='=HYPERLINK("http://x")' />\n` });
    expect(riga.nota).toBe('=HYPERLINK("http://x")');
    const csv = nonMontatiToCsv([{ ...riga, designator: "+J5", footprint: "-soic8", manufacturerPartNumber: "@cmd", lcsc: "=1+1" }]);
    expect(csv.split("\n")[1]).toBe(`"'+J5","'-soic8","'@cmd","'=1+1","bottom",10.860,-11.450,180,"'=HYPERLINK(""http://x"")"`);
  });

  it("a board without any gives byte for byte the files it always gave, and an empty list", () => {
    const tutti = scritto(false);
    expect(pnpToCsv(righeCpl(tutti))).toBe(cplDiPrima(tutti));
    expect(buildBom(tutti, SORGENTI).map((r) => r.designators)).toEqual(["J5", "R1", "U1"]);
    expect(buildNonMontati(tutti, SORGENTI)).toEqual([]);
    expect(nonMontatiToCsv([])).toBe(`"Nome","Impronta","Codice produttore (MPN)","Codice LCSC","Lato","X (mm)","Y (mm)","Rotazione","Nota"\n`);
    expect(buildBoardReport(tutti, null).nonMontati).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// a real board, compiled by tscircuit, through the export route
// ---------------------------------------------------------------------------

const main = (nonMontato: boolean) => `export default () => (
  <board width="24mm" height="16mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-6} pcbY={3} supplierPartNumbers={{ jlcpcb: ["C25744"] }} />
    <capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={-6} pcbY={-3} pcbRotation={90} layer="bottom" />
    <chip name="U1" footprint="soic8" pcbX={2} pcbY={4} manufacturerPartNumber="TCA6408APWR" />
    <chip name="J5" description={"connettore di programmazione Tag-Connect TC2030-NL, senza componente (non montare)"} manufacturerPartNumber="TC2030-NL" ${nonMontato ? "doNotPlace " : ""}pcbX={6} pcbY={-4} pcbRotation={180} layer="bottom" pinLabels={{ pin1: "VTREF", pin2: "SWDIO" }} footprint={<footprint><smtpad portHints={["1"]} shape="circle" radius={0.3935} pcbX={-1.27} pcbY={-0.635} layer="top" /><smtpad portHints={["2"]} shape="circle" radius={0.3935} pcbX={1.27} pcbY={-0.635} layer="top" /><hole diameter={0.9906} pcbX={0} pcbY={1.0} /><silkscreencircle pcbX={-1.27} pcbY={-1.45} radius={0.2} layer="top" /></footprint>} />
    {/* the pin 1 marks the export asks of every part with a way round (polarita.ts) */}
    <silkscreencircle pcbX={-1.6} pcbY={6.6} radius={0.2} />
  </board>
)
`;

describe("the export of a compiled board with a part that is not mounted", () => {
  const schede: Record<"con" | "senza", { files: Record<string, string>; cj: El[] }> = {} as never;

  beforeAll(async () => {
    for (const [chiave, nonMontato] of [["con", true], ["senza", false]] as const) {
      const files = { "main.tsx": main(nonMontato) };
      const cj = (await compileGeometryOnly(files, { schematic: false })) as unknown as El[];
      schede[chiave] = { files, cj };
    }
  }, 120_000);

  const usa = (chiave: "con" | "senza") => {
    db.files = schede[chiave].files;
    db.row = {
      filesHash: filesHash(schede[chiave].files),
      circuitJson: schede[chiave].cj,
      summary: {},
      createdAt: "2026-11-16T16:00:00.000Z",
      engineVersion: CHECKS_ENGINE_VERSION,
      base: null,
    };
  };
  const scarica = async (kind: string) => {
    const r = await esporta(new Request(`http://x/api/export?projectId=p&kind=${kind}`));
    expect(r.status).toBe(200);
    return r;
  };

  it("tscircuit writes doNotPlace on the part's pcb_component, and keeps its pads", () => {
    const { cj } = schede.con;
    const j5 = cj.find((e) => e.type === "source_component" && e.name === "J5")!;
    const pcb = cj.find((e) => e.type === "pcb_component" && e.source_component_id === j5.source_component_id)!;
    expect(pcb.do_not_place).toBe(true);
    expect(pcb.layer).toBe("bottom");
    expect(cj.filter((e) => e.type === "pcb_smtpad" && e.pcb_component_id === pcb.pcb_component_id)).toHaveLength(2);
    expect(cj.some((e) => e.type === "pcb_hole")).toBe(true);
    expect(cj.filter((e) => e.type === "pcb_component" && e.do_not_place === true)).toHaveLength(1);
  });

  it("pick and place and BOM leave J5 out, the file of its own has it on the bottom; the other rows do not move", async () => {
    usa("con");
    const cpl = await (await scarica("pnp")).text();
    const bom = await (await scarica("bom")).text();
    const json = (await (await scarica("bom-json")).json()) as { rows: Array<{ designators: string }>; nonMontati?: Array<{ designator: string; layer: string }> };
    const nm = await scarica("non-montati");
    const elenco = await nm.text();

    expect(cpl).not.toMatch(/"J5"/);
    expect(bom).not.toMatch(/"J5"|TC2030/);
    expect(json.rows.map((r) => r.designators)).not.toContain("J5");
    expect(json.nonMontati).toMatchObject([{ designator: "J5", layer: "bottom" }]);
    expect(nm.headers.get("content-disposition")).toBe('attachment; filename="distinta_non_montati.csv"');
    const [, j5, ...altre] = elenco.trimEnd().split("\n");
    expect(altre).toEqual([]);
    expect(j5).toMatch(/^"J5","<footprint> inline","TC2030-NL","","bottom",-?\d+\.\d{3},-?\d+\.\d{3},\d+,"connettore di programmazione Tag-Connect TC2030-NL, senza componente \(non montare\)"$/);

    // every other row is the one the old pick and place wrote, in the same order
    const prima = cplDiPrima(schede.con.cj).split("\r\n");
    expect(cpl).toBe(prima.filter((r) => !r.startsWith('"J5"')).join("\r\n"));
    // and J5 sits in its file where the old pick and place had it
    const vecchiaJ5 = prima.find((r) => r.startsWith('"J5"'))!.split(",");
    expect(j5.split(",").slice(4, 8)).toEqual([vecchiaJ5[3], vecchiaJ5[1], vecchiaJ5[2], vecchiaJ5[4]]);
  }, 60_000);

  it("the Gerber and the drill files are the same with or without doNotPlace: the pads and the hole stay", async () => {
    // the files say when they were written: that hour is all that may differ
    const senzaOra = (testo: string) => testo.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<ora>");
    const contenuto = async () => {
      const zip = await JSZip.loadAsync(await (await scarica("gerber")).arrayBuffer());
      const out: Record<string, string> = {};
      for (const nome of Object.keys(zip.files).sort()) out[nome] = senzaOra(await zip.file(nome)!.async("string"));
      return out;
    };
    usa("con");
    const con = await contenuto();
    usa("senza");
    const senza = await contenuto();
    expect(Object.keys(con)).toEqual(Object.keys(senza));
    expect(Object.keys(con)).not.toContain("distinta_non_montati.csv");
    expect(con).toEqual(senza);
    expect(con["drill_unplated.drl"]).toMatch(/T\d+C0\.99/);
  }, 60_000);

  it("the same board without doNotPlace exports the files of before, byte for byte, and an empty list", async () => {
    usa("senza");
    const cpl = await (await scarica("pnp")).text();
    expect(cpl).toBe(cplDiPrima(schede.senza.cj));
    expect(cpl).toMatch(/"J5"/);
    const bom = await (await scarica("bom")).text();
    expect(bom).toBe(bomToCsv(buildBom(schede.senza.cj, schede.senza.files)));
    expect(bom).toMatch(/"J5"/);
    const json = (await (await scarica("bom-json")).json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["rows"]);
    const elenco = await (await scarica("non-montati")).text();
    expect(elenco.trimEnd().split("\n")).toHaveLength(1);
  }, 60_000);
});
