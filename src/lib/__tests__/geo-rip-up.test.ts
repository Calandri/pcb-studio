import { describe, expect, it } from "vitest";
import { clipSegmentToZone, ripZone, splitRouteByZone, type Zone } from "@/lib/rip-up";
import { deleteTrace } from "@/lib/trace-edit";
import type { CircuitElement } from "@/lib/route-score";

const zone: Zone = { minX: 4, maxX: 6, minY: -1, maxY: 1, problems: 1, reasons: ["t"] };
const w = (x: number, y: number) => ({ route_type: "wire", x, y, layer: "top", width: 0.2 });
const trace = (id: string, route: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): CircuitElement =>
  ({ type: "pcb_trace", pcb_trace_id: id, source_trace_id: "st1", route, ...extra }) as CircuitElement;

describe("clipSegmentToZone", () => {
  it("finds the stretch of a segment inside the zone", () => {
    expect(clipSegmentToZone(zone, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ t0: 0.4, t1: 0.6 });
    expect(clipSegmentToZone(zone, { x: 0, y: 5 }, { x: 10, y: 5 })).toBeNull();
  });
});

describe("ripZone", () => {
  it("cuts a straight segment that crosses the zone with both ends outside", () => {
    const { circuitJson, cuts } = ripZone([trace("t", [w(0, 0), w(10, 0)])], zone);
    const kept = circuitJson.filter((e) => e.type === "pcb_trace");
    expect(kept).toHaveLength(2);
    expect((kept[0].route as Array<{ x: number }>).at(-1)!.x).toBeCloseTo(4, 6);
    expect((kept[1].route as Array<{ x: number }>)[0].x).toBeCloseTo(6, 6);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].sourceTraceId).toBe("st1");
  });

  it("joins a head stub to the end of the route that lies inside the zone", () => {
    // from a pad outside to a pad inside: the kept head must not float
    const { circuitJson, cuts } = ripZone([trace("t", [w(0, 0), w(3, 0), w(5, 0)])], zone);
    const kept = circuitJson.filter((e) => e.type === "pcb_trace");
    expect(kept).toHaveLength(1);
    expect((kept[0].route as Array<{ x: number }>).at(-1)!.x).toBeCloseTo(4, 6);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].a).toMatchObject({ x: 4, y: 0 });
    expect(cuts[0].b).toMatchObject({ x: 5, y: 0 });
  });

  it("joins the start inside the zone to a tail that leaves it", () => {
    const { cuts } = ripZone([trace("t", [w(5, 0), w(9, 0)])], zone);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].a).toMatchObject({ x: 5, y: 0 });
    expect(cuts[0].b).toMatchObject({ x: 6, y: 0 });
  });

  it("leaves untouched what does not reach the zone", () => {
    const t = trace("t", [w(0, 3), w(10, 3)]);
    const { circuitJson, cuts } = ripZone([t], zone);
    expect(circuitJson[0]).toBe(t);
    expect(cuts).toHaveLength(0);
  });

  it("never removes the vias of hand copper, flagged or recognised by position", () => {
    const hand = trace(
      "hand",
      [w(5, 0), { route_type: "via", x: 5.5, y: 0, from_layer: "top", to_layer: "bottom" }, { ...w(5.5, 0), layer: "bottom" }],
      { manual: true },
    );
    const flagged = { type: "pcb_via", pcb_via_id: "v1", x: 4.5, y: 0.5, manual: true } as CircuitElement;
    const legacy = { type: "pcb_via", pcb_via_id: "v2", x: 5.5, y: 0 } as CircuitElement;
    const auto = { type: "pcb_via", pcb_via_id: "v3", x: 5, y: 0.5 } as CircuitElement;
    const { circuitJson } = ripZone([hand, flagged, legacy, auto], zone);
    const ids = circuitJson.filter((e) => e.type === "pcb_via").map((e) => e.pcb_via_id);
    expect(ids).toEqual(["v1", "v2"]);
    expect(circuitJson).toContain(hand);
  });
});

describe("splitRouteByZone", () => {
  it("reports a route that exits and comes back as two cuts", () => {
    const r = splitRouteByZone([w(5, 0), w(5, 3), w(5.5, 3), w(5.5, 0)], zone);
    expect(r.pieces).toHaveLength(1);
    expect(r.cuts).toHaveLength(2);
  });
});

describe("deleteTrace", () => {
  const base = (): Array<Record<string, unknown>> => [
    { type: "source_trace", source_trace_id: "st1", display_name: ".R1 > .pin1 to .C1 > .pin1" },
    {
      type: "pcb_trace",
      pcb_trace_id: "pcb_trace_manual_st1",
      source_trace_id: "st1",
      manual: true,
      route: [w(0, 0), { route_type: "via", x: 1, y: 0, from_layer: "top", to_layer: "bottom" }, { ...w(2, 0), layer: "bottom" }],
    },
    // another trace through a via of its own, and through the shared one
    {
      type: "pcb_trace",
      pcb_trace_id: "other",
      source_trace_id: "st2",
      route: [w(5, 5), { route_type: "via", x: 6, y: 5, from_layer: "top", to_layer: "bottom" }],
    },
    { type: "pcb_via", pcb_via_id: "pcb_via_manual_0", x: 1, y: 0, manual: true },
    { type: "pcb_via", pcb_via_id: "v_other", x: 6, y: 5 },
  ];

  it("removes the route by connection when the copper carries no key, and its via", () => {
    const edits = JSON.stringify({
      pcb_routes: [{ connection: ".R1 > .pin1 to .C1 > .pin1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] }],
    });
    const r = deleteTrace(base(), "pcb_trace_manual_st1", edits)!;
    expect(r.connection).toBe(".R1 > .pin1 to .C1 > .pin1");
    expect(r.editsChanged).toBe(true);
    expect(r.edits.pcb_routes).toHaveLength(0);
    const vias = r.circuitJson.filter((e) => e.type === "pcb_via").map((e) => e.pcb_via_id);
    expect(vias).toEqual(["v_other"]);
  });

  it("removes exactly the route the copper names when it carries its key", () => {
    const els = base();
    (els[1] as Record<string, unknown>).manual_route_id = ".C1 > .pin1 ~ .R1 > .pin1";
    const edits = JSON.stringify({
      pcb_routes: [
        { connection: ".R1 > .pin1 to .C1 > .pin1", from: ".R1 > .pin1", to: ".C1 > .pin1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] },
        { connection: ".R1 > .pin1 to .C1 > .pin1", from: ".R1 > .pin1", to: ".D1 > .pin1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 0, y: 2 }] },
      ],
    });
    const r = deleteTrace(els, "pcb_trace_manual_st1", edits)!;
    expect(r.edits.pcb_routes).toHaveLength(1);
    expect(r.edits.pcb_routes[0].to).toBe(".D1 > .pin1");
  });

  it("keeps a via another trace still passes through", () => {
    const els = base();
    (els[2] as { route: unknown[] }).route.push({ route_type: "via", x: 1, y: 0, from_layer: "top", to_layer: "bottom" });
    const r = deleteTrace(els, "pcb_trace_manual_st1", null)!;
    expect(r.circuitJson.filter((e) => e.type === "pcb_via")).toHaveLength(2);
  });
});
