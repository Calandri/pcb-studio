import { test } from "vitest";
import { ePotenza } from "../net-roles";
test("reti di potenza", () => {
  const nets = (process.env.RETI ?? "").split(",");
  require("fs").writeFileSync("/tmp/potenza.json", JSON.stringify(nets.filter((n) => ePotenza(n))));
});
