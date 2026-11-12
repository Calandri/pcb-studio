/**
 * Pezzi di Circuit JSON per i test sul rame: una scheda, pezzi coi loro
 * piedini, reti col nome, piste, vie e colate, scritti come li scrive
 * tscircuit (una traccia sorgente per piedino, la chiave di connettivita' sulla
 * rete e sulle sue tracce).
 */
export type El = { type: string; [key: string]: unknown };

export const scheda = (strati = 4): El => ({ type: "pcb_board", center: { x: 0, y: 0 }, width: 40, height: 40, num_layers: strati });

/**
 * Un pezzo coi suoi piedini SMD: nome, poi [pin, x, y, strato]. Le porte si
 * chiamano `pp_<pezzo>_<pin>`, le piazzole `pad_<pezzo>_<pin>`, il pezzo
 * `pc_<pezzo>`.
 */
export const pezzo = (nome: string, piedini: Array<[string, number, number, string?]>): El[] => [
  { type: "source_component", source_component_id: `sc_${nome}`, name: nome },
  {
    type: "pcb_component",
    pcb_component_id: `pc_${nome}`,
    source_component_id: `sc_${nome}`,
    center: { x: piedini[0][1], y: piedini[0][2] },
    width: 1,
    height: 1,
    rotation: 0,
    layer: piedini[0][3] ?? "top",
  },
  ...piedini.flatMap(([pin, x, y, layer = "top"]) => {
    const id = `${nome}_${pin}`;
    return [
      { type: "source_port", source_port_id: `sp_${id}`, name: pin, source_component_id: `sc_${nome}` },
      { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: `pc_${nome}`, x, y, layers: [layer] },
      { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, pcb_component_id: `pc_${nome}`, x, y, width: 0.6, height: 0.6, layer },
    ];
  }),
];

/** Un piedino passante di un pezzo: porta e foro metallizzato, su ogni strato. */
export const piedinoPassante = (nome: string, pin: string, x: number, y: number): El[] => {
  const id = `${nome}_${pin}`;
  return [
    { type: "source_component", source_component_id: `sc_${nome}`, name: nome },
    { type: "pcb_component", pcb_component_id: `pc_${nome}`, source_component_id: `sc_${nome}`, center: { x, y }, width: 2, height: 2, rotation: 0, layer: "top" },
    { type: "source_port", source_port_id: `sp_${id}`, name: pin, source_component_id: `sc_${nome}` },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: `pc_${nome}`, x, y, layers: ["top", "bottom"] },
    { type: "pcb_plated_hole", pcb_plated_hole_id: `foro_${id}`, pcb_port_id: `pp_${id}`, pcb_component_id: `pc_${nome}`, shape: "circle", x, y, hole_diameter: 0.9, outer_diameter: 1.5, layers: ["top", "bottom"] },
  ];
};

/**
 * Una rete col nome, `source_net_<n>`, coi suoi piedini ("R1_1" = pezzo R1,
 * pin 1). Le tracce sorgente si chiamano `st_<rete>_<i>`, nell'ordine dei
 * piedini.
 */
export const rete = (n: number, nome: string, piedini: string[]): El[] => [
  { type: "source_net", source_net_id: `source_net_${n}`, name: nome, subcircuit_connectivity_map_key: `chiave_${n}` },
  ...piedini.map((p, i) => ({
    type: "source_trace",
    source_trace_id: `st_${nome}_${i}`,
    display_name: `.${p.replace("_", " > .")} to net.${nome}`,
    subcircuit_connectivity_map_key: `chiave_${n}`,
    connected_source_port_ids: [`sp_${p}`],
    connected_source_net_ids: [`source_net_${n}`],
  })),
];

export const wire = (x: number, y: number, layer = "top") => ({ route_type: "wire", x, y, width: 0.2, layer });

export const trace = (id: string, sourceTraceId: string, route: Array<Record<string, unknown>>): El => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  source_trace_id: sourceTraceId,
  route,
});

/** Una via nata da `<via>`: la rete la dice solo `pcb_trace_id`, col source_net della rete n. */
export const via = (id: string, x: number, y: number, n: number): El => ({
  type: "pcb_via",
  pcb_via_id: id,
  x,
  y,
  outer_diameter: 0.6,
  hole_diameter: 0.3,
  layers: ["top", "inner1", "inner2", "bottom"],
  pcb_trace_id: `source_net_${n}`,
});

/** Una colata rettangolare della rete n su uno strato. */
export const colata = (id: string, n: number, layer: string, minX: number, minY: number, maxX: number, maxY: number): El => ({
  type: "pcb_copper_pour",
  pcb_copper_pour_id: id,
  source_net_id: `source_net_${n}`,
  layer,
  shape: "brep",
  brep_shape: {
    outer_ring: {
      vertices: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
    },
    inner_rings: [],
  },
});
