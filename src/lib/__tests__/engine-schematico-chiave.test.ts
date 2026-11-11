import { describe, expect, it } from "vitest";
import { compileGeometryOnly, compileProject, graftSchematic, schematicKeyOf, soloCioCheLeggeLoSchematico } from "@/lib/compile";

/*
 * Review of 11/11/2026 on the key of the schematic. It left out pcbX, layer,
 * pcbRotation and the other attributes of the copper on ANY tag, also on a
 * component written by the user, whose code may decide the schematic with
 * them: a <Pull layer> that sends the pull to VCC or to GND kept the key, and
 * the schematic of the other net was put on the board. And the graft compared
 * the traces by id only: a wire moved to another pin or net has the same id.
 */
type El = Record<string, unknown> & { type: string };
const norm = (v: unknown) => JSON.stringify(v).replace(/<(\w+)#\d+/g, "<$1#");
const schematico = (cj: unknown[]) => (cj as El[]).filter((e) => e.type.startsWith("schematic_"));
const etichette = (cj: unknown[]) =>
  (cj as El[])
    .filter((e) => e.type === "schematic_net_label")
    .map((e) => String(e.text))
    .sort();
const spans = (s: { profile: { spans: Array<{ name: string }> } }) => s.profile.spans.map((x) => x.name);

/** a component of the user whose `layer` chooses the net the pull goes to */
const PULL = (layer: "top" | "bottom") => `const Pull = (props: { name: string; layer: "top" | "bottom" }) => (
  <>
    <resistor name={props.name} resistance="10k" footprint="0402" layer={props.layer} schSectionName="pull" />
    <trace from={"." + props.name + " > .pin1"} to={props.layer === "bottom" ? "net.GND" : "net.VCC"} />
  </>
)
export default () => (
  <board width="20mm" height="10mm" schTraceAutoLabelEnabled>
    <net name="VCC" />
    <net name="GND" />
    <Pull name="R1" layer="${layer}" />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} schSectionName="pull" />
    <trace from=".R2 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin2" />
  </board>
)
`;

/** a component of the user that turns its symbol as it turns the part on the board */
const CONN = (giro: number) => `const Conn = (props: { name: string; pcbRotation: number }) => (
  <resistor name={props.name} resistance="1k" footprint="0402" pcbRotation={props.pcbRotation} schRotation={props.pcbRotation} schSectionName="conn" />
)
export default () => (
  <board width="20mm" height="10mm">
    <net name="GND" />
    <Conn name="R1" pcbRotation={${giro}} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} schSectionName="conn" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin2" />
  </board>
)
`;

/** compiles `dopo` as the page does after `prima`: the board saved early, the schematic of `prima` offered */
const dopoDi = async (prima: string, dopo: string) => {
  const a = await compileProject({ "main.tsx": prima });
  const b = await compileProject(
    { "main.tsx": dopo },
    { schematicFrom: { circuitJson: a.circuitJson, summary: a.summary }, onBoard: async () => {} },
  );
  const giusto = await compileProject({ "main.tsx": dopo });
  return { a, b, giusto };
};

describe("la chiave dello schematico non toglie niente ai componenti dell'utente", () => {
  it("<Pull layer> che sceglie la rete: chiave diversa e lo schematico giusto, non quello dell'altra rete", async () => {
    expect(schematicKeyOf({ "main.tsx": PULL("bottom") })).not.toBe(schematicKeyOf({ "main.tsx": PULL("top") }));
    const { a, b, giusto } = await dopoDi(PULL("top"), PULL("bottom"));
    expect(etichette(a.circuitJson)).toEqual(["GND", "VCC"]);
    expect(etichette(giusto.circuitJson)).toEqual(["GND"]);
    expect(etichette(b.circuitJson)).toEqual(["GND"]);
    expect(b.summary.message).not.toMatch(/schematico invariato/);
    expect(norm(schematico(b.circuitJson))).toBe(norm(schematico(giusto.circuitJson)));
  }, 180_000);

  it("<Conn pcbRotation> che gira anche il simbolo: chiave diversa e il simbolo girato", async () => {
    expect(schematicKeyOf({ "main.tsx": CONN(0) })).not.toBe(schematicKeyOf({ "main.tsx": CONN(90) }));
    const { a, b, giusto } = await dopoDi(CONN(90), CONN(0));
    expect(norm(schematico(giusto.circuitJson))).not.toBe(norm(schematico(a.circuitJson)));
    expect(norm(schematico(b.circuitJson))).toBe(norm(schematico(giusto.circuitJson)));
  }, 180_000);

  it("sui pezzi di tscircuit con il valore scritto si toglie, sui componenti dell'utente e con un valore letto da altrove resta", () => {
    expect(soloCioCheLeggeLoSchematico('<board>\n  <via pcbX={1} />\n  <R a="1" pcbX={2} />\n  <resistor name="R2" pcbX={-6.5} layer="bottom" />\n</board>')).toBe(
      '<board>\n  <R a="1" pcbX={2} />\n  <resistor name="R2" />\n</board>',
    );
    // a member expression is a component of the user too
    expect(soloCioCheLeggeLoSchematico('<lib.Part name="U1" pcbX={2} />')).toBe('<lib.Part name="U1" pcbX={2} />');
    // inside a component of the user, a value that comes from a prop stays
    const dentro = 'const P = (props) => <resistor name={props.name} layer={props.layer} pcbX={props.x + 1} pcbY={0} />';
    expect(soloCioCheLeggeLoSchematico(dentro)).toBe('const P = (props) => <resistor name={props.name} layer={props.layer} pcbX={props.x + 1} />');
    // lists and objects written out go: a hand-drawn path
    expect(soloCioCheLeggeLoSchematico('<trace from=".A > .pin1" to="net.G" pcbPath={["U1.pin1", { x: -1.5, y: 2e-1 }]} />')).toBe('<trace from=".A > .pin1" to="net.G" />');
    // a schematic primitive keeps every attribute
    expect(soloCioCheLeggeLoSchematico('<schematictext text="A" layer="top" />')).toBe('<schematictext text="A" layer="top" />');
  });

  it("un attributo del rame su un pezzo di tscircuit che legge una variabile usata anche altrove resta, e la variabile cambia la chiave", () => {
    const con = (giro: number) => `const giro = ${giro}
export default () => (
  <board width="10mm" height="10mm">
    <chip name="U1" footprint="soic8" pcbRotation={giro} schRotation={giro} />
  </board>
)`;
    expect(soloCioCheLeggeLoSchematico(con(90))).toContain("pcbRotation={giro}");
    expect(schematicKeyOf({ "main.tsx": con(0) })).not.toBe(schematicKeyOf({ "main.tsx": con(90) }));
    // the same with the attribute gone: the variable is written where it is declared, and that stays in the key
    const senza = (giro: number) => con(giro).replace(" pcbRotation={giro}", "");
    expect(schematicKeyOf({ "main.tsx": senza(0) })).not.toBe(schematicKeyOf({ "main.tsx": senza(90) }));
  });
});

describe("il motore conferma cosa la chiave toglie dai pezzi di tscircuit", () => {
  /** a chip with its footprint written out: pads moved from one side to the other, the chip turned and flipped */
  const CHIP = (dx: number, giro: number, lato: "top" | "bottom") => `export default () => (
  <board width="20mm" height="12mm" schTraceAutoLabelEnabled>
    <net name="GND" />
    <chip name="U1" pinLabels={{ pin1: "IN", pin2: "GND", pin3: "OUT" }} pcbRotation={${giro}} layer="${lato}" schSectionName="a"
      footprint={<footprint>
        <smtpad portHints={["pin1"]} shape="rect" width={1} height={0.6} pcbX={${-1.2 + dx}} pcbY={0.95} />
        <smtpad portHints={["pin2"]} shape="rect" width={1} height={0.6} pcbX={${-1.2 + dx}} pcbY={-0.95} />
        <smtpad portHints={["pin3"]} shape="rect" width={1} height={0.6} pcbX={${1.2 - dx}} pcbY={0} />
      </footprint>} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={5} pcbRotation={0} schSectionName="a" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to=".R1 > .pin1" />
  </board>
)
`;

  it("piazzole spostate da un lato all'altro, chip girato e sul lato sotto: stessa chiave e stesso schematico", async () => {
    const a = CHIP(0, 0, "top");
    const b = CHIP(2.4, 90, "bottom").replace("pcbRotation={0}", "pcbRotation={270}");
    expect(schematicKeyOf({ "main.tsx": b })).toBe(schematicKeyOf({ "main.tsx": a }));
    const [sa, sb] = [await compileGeometryOnly({ "main.tsx": a }), await compileGeometryOnly({ "main.tsx": b })];
    expect(schematico(sa).length).toBeGreaterThan(0);
    expect(norm(schematico(sb))).toBe(norm(schematico(sa)));
  }, 180_000);
});

describe("l'innesto guarda a cosa e' collegata ogni pista e cosa mostra ogni pezzo", () => {
  const prima: El[] = [
    { type: "source_component", source_component_id: "s1", ftype: "simple_resistor", name: "R1", resistance: 1000, display_resistance: "1kΩ" },
    { type: "source_port", source_port_id: "p1", name: "pin1", pin_number: 1, source_component_id: "s1" },
    { type: "source_port", source_port_id: "p2", name: "pin2", pin_number: 2, source_component_id: "s1" },
    { type: "source_net", source_net_id: "n1", name: "VCC" },
    { type: "source_net", source_net_id: "n2", name: "GND" },
    { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["p1"], connected_source_net_ids: ["n1"] },
    { type: "schematic_component", schematic_component_id: "x", source_component_id: "s1" },
  ];
  const scheda = (cambia: (els: El[]) => El[]) => [...cambia(prima.filter((e) => !e.type.startsWith("schematic_"))), { type: "pcb_board" }];

  it("la stessa pista spostata su un altro piedino o su un'altra rete, con gli stessi id: no", () => {
    expect(graftSchematic(scheda((els) => els) as never, prima)).not.toBeNull();
    const altroPiedino = (els: El[]) => els.map((e) => (e.type === "source_trace" ? { ...e, connected_source_port_ids: ["p2"] } : e));
    const altraRete = (els: El[]) => els.map((e) => (e.type === "source_trace" ? { ...e, connected_source_net_ids: ["n2"] } : e));
    expect(graftSchematic(scheda(altroPiedino) as never, prima)).toBeNull();
    expect(graftSchematic(scheda(altraRete) as never, prima)).toBeNull();
    // the same ports and nets in another order: yes
    const ordine = (els: El[]) =>
      els.map((e) => (e.type === "source_trace" ? { ...e, connected_source_port_ids: ["p1"], connected_source_net_ids: ["n1"] } : e));
    expect(graftSchematic(scheda(ordine) as never, prima)).not.toBeNull();
  });

  it("un pezzo con un altro valore o un altro simbolo: no; con altri codici del fornitore: si'", () => {
    const valore = (els: El[]) => els.map((e) => (e.type === "source_component" ? { ...e, resistance: 4700, display_resistance: "4.7kΩ" } : e));
    const simbolo = (els: El[]) => els.map((e) => (e.type === "source_component" ? { ...e, ftype: "simple_capacitor" } : e));
    const codici = (els: El[]) => els.map((e) => (e.type === "source_component" ? { ...e, supplier_part_numbers: { jlcpcb: ["C1"] } } : e));
    expect(graftSchematic(scheda(valore) as never, prima)).toBeNull();
    expect(graftSchematic(scheda(simbolo) as never, prima)).toBeNull();
    expect(graftSchematic(scheda(codici) as never, prima)).not.toBeNull();
  });
});

describe("una via scritta prima dei pezzi", () => {
  const SENZA = `export default () => (
  <board width="20mm" height="10mm" schTraceAutoLabelEnabled>
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} schSectionName="a" />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} schSectionName="a" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin2" />
  </board>
)
`;
  const CON = SENZA.replace('    <net name="GND" />\n', '    <via pcbX={0} pcbY={3} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.GND" />\n    <net name="GND" />\n');

  it("stessa chiave, ma i piedini dei pezzi cambiano numero: lo schematico si ridisegna e torna quello giusto", async () => {
    expect(CON).not.toBe(SENZA);
    expect(schematicKeyOf({ "main.tsx": CON })).toBe(schematicKeyOf({ "main.tsx": SENZA }));
    const { a, b, giusto } = await dopoDi(SENZA, CON);
    expect(graftSchematic((await compileGeometryOnly({ "main.tsx": CON }, { schematic: false })) as never, a.circuitJson)).toBeNull();
    expect(b.summary.message).not.toMatch(/schematico invariato/);
    expect(spans(b.summary)).toContain("scheda con schematico (tscircuit)");
    expect(norm(schematico(b.circuitJson))).toBe(norm(schematico(giusto.circuitJson)));
    expect(b.summary.schematicKey).toBe(schematicKeyOf({ "main.tsx": CON }));
  }, 180_000);
});
