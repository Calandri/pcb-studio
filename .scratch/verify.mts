import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const { getProject } = await import("./lib/project-store.ts");
const { getLibraryFsMap } = await import("./lib/library-store.ts");
const { compileProject } = await import("./lib/compile.ts");
const { applyEditEvents, parseManualEdits, serializeManualEdits, MANUAL_EDITS_PATH } = await import("./lib/manual-edits.ts");

const PROJECT = process.argv[2] ?? "bat-bs";
const files = await getProject(PROJECT);
const lib = await getLibraryFsMap().catch(() => ({}));
const fsMap = { ...lib, ...files };
console.log("file progetto:", Object.keys(files).join(", "));

console.time("compile-1");
const first = await compileProject(fsMap);
console.timeEnd("compile-1");
const name = (cj: any[], el: any) => cj.find(s => s.type === "source_component" && s.source_component_id === el.source_component_id)?.name;
const pcbOf = (cj: any[], n: string) => cj.find((e: any) => e.type === "pcb_component" && name(cj, e) === n);
const schOf = (cj: any[], n: string) => cj.find((e: any) => e.type === "schematic_component" && name(cj, e) === n);

const target = first.circuitJson.filter((e: any) => e.type === "pcb_component").map((e: any) => name(first.circuitJson, e))[0];
console.log("ok:", first.summary.ok, "| componenti:", first.summary.components.length,
  "| piste:", first.summary.pcbTraces, "| manualEdits:", JSON.stringify(first.summary.manualEdits));
const p0 = pcbOf(first.circuitJson, target), s0 = schOf(first.circuitJson, target);
console.log("bersaglio:", target, "PCB", p0.center, "SCH", s0?.center);

// l'utente trascina il componente di 3mm a destra e 2mm in alto sul rame,
// e il suo simbolo di 2 unita' in alto sullo schematico
const events = [
  { edit_event_type: "edit_pcb_component_location", pcb_component_id: p0.pcb_component_id,
    original_center: p0.center, new_center: { x: p0.center.x + 3, y: p0.center.y + 2 } },
  ...(s0 ? [{ edit_event_type: "edit_schematic_component_location", schematic_component_id: s0.schematic_component_id,
    original_center: s0.center, new_center: { x: s0.center.x, y: s0.center.y + 2 } }] : []),
];
const edits = applyEditEvents({ circuitJson: first.circuitJson, main: files["main.tsx"], edits: parseManualEdits(files[MANUAL_EDITS_PATH]), events });
console.log("modifiche manuali:", JSON.stringify(edits).slice(0, 220));

console.time("compile-2");
const second = await compileProject({ ...fsMap, [MANUAL_EDITS_PATH]: serializeManualEdits(edits) });
console.timeEnd("compile-2");
const p1 = pcbOf(second.circuitJson, target), s1 = schOf(second.circuitJson, target);
console.log("dopo:      ", target, "PCB", p1?.center, "SCH", s1?.center);
console.log("ok:", second.summary.ok, "| piste:", second.summary.pcbTraces,
  "| manualEdits:", JSON.stringify(second.summary.manualEdits),
  "| errori:", second.summary.errors.length);
console.log("schX/schY segnalati nelle sorgenti:", JSON.stringify(second.summary.schematicQuality.schCoordFiles));
console.log("sovrapposizioni simboli:", second.summary.schematicQuality.symbolOverlapCount,
  "| DRC:", second.summary.drcViolations.length, "| non instradate:", second.summary.unroutedConnections.length);

const dxPcb = { x: +(p1.center.x - p0.center.x).toFixed(3), y: +(p1.center.y - p0.center.y).toFixed(3) };
const dySch = s1 && s0 ? +(s1.center.y - s0.center.y).toFixed(3) : null;
console.log("SPOSTAMENTO PCB atteso {3,2} ->", JSON.stringify(dxPcb), "| SCH atteso +2 ->", dySch);
