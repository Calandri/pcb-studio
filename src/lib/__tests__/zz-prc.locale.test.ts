import { it } from "vitest";
import fs from "node:fs";
import { runPrcChecks } from "@/lib/prc";
it("prc", () => {
  const c = JSON.parse(fs.readFileSync(process.env.CIRCUITO!, "utf8"));
  for (const v of runPrcChecks(c)) if (v.rule === "power_trace_width") console.log("PRC", JSON.stringify(v).slice(0, 300));
});
