// BANCO LOCALE (non committare): quali pad il controllo plane_stitch_missing lascia scoperti, e quali via vede accanto.
import { it } from "vitest";
import { readFileSync } from "node:fs";
import { padsOffPlane, readPours, tutteLeVia, netOfViaKey } from "@/lib/pours";
it("scoperti", () => {
  const c = JSON.parse(readFileSync(process.env.CIRCUITO!, "utf8"));
  const pours = readPours(c);
  const nets = new Map<string, string>(c.filter((e: any) => e.type === "source_net").map((e: any) => [e.source_net_id, e.name]));
  const vie = tutteLeVia(c, netOfViaKey(c, pours));
  console.log("VIE", JSON.stringify(vie.map((v: any) => [Number(v.x.toFixed(2)), Number(v.y.toFixed(2)), nets.get(v.net) ?? v.net])));
  const pad = new Map<string, any>(c.filter((e: any) => e.type === "pcb_smtpad").map((e: any) => [e.pcb_smtpad_id, e]));
  for (const s of padsOffPlane(c, pours)) {
    const p = pad.get(s.pad);
    console.log("SCOPERTO", s.pad, nets.get(s.net) ?? s.net, s.x.toFixed(3), s.y.toFixed(3), p?.layer, p?.shape, JSON.stringify(p?.port_hints));
  }
});
