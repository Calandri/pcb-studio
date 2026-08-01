/**
 * What each component is for, deduced from the circuit.
 *
 * Looking at a board without knowing why that capacitor sits there is the
 * fastest way to break something: you move it, remove it, change its value,
 * and the board stops working with no check saying a word. A decoupling
 * capacitor and a reservoir capacitor look alike on the schematic and are not
 * the same thing.
 *
 * The role is not asked of anyone and not written by hand: it is read from
 * how the component is CONNECTED. A capacitor between a power rail and
 * ground, next to a chip, is a decoupling capacitor. The same capacitor in
 * series between two signals is a coupling capacitor. A resistor in series
 * with a LED limits its current. A resistor and a capacitor in cascade are a
 * filter, and for that one you can even say where it cuts.
 */

export interface ComponentRole {
  /** one line: what it is */
  role: string;
  /** why it sits there, in plain words */
  why: string;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const POWER_RE = /^(v|p\d|3v3|5v|vbat|vcc|vdd|vin|vout|vbus|vsys)/i;
const GROUND_RE = /^(gnd|agnd|dgnd|vss)\b/i;

/** value in farads/ohms from "100nF" / "4.7k" / a bare number */
function parseValue(raw: unknown): number | null {
  const direct = num(raw);
  if (direct !== null) return direct;
  const text = String(raw ?? "").trim();
  const m = /^([\d.]+)\s*([pnµumkMG]?)/.exec(text);
  if (!m) return null;
  const scale: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    µ: 1e-6,
    u: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    M: 1e6,
    G: 1e9,
  };
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return value * (scale[m[2]] ?? 1);
}

function formatHz(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(1).replace(".", ",")} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1).replace(".", ",")} kHz`;
  return `${Math.round(hz)} Hz`;
}

/**
 * Role of every component, indexed by designator (C1, R_LED_G, U2...).
 */
export function inferRoles(circuitJson: unknown[] | null): Map<string, ComponentRole> {
  const roles = new Map<string, ComponentRole>();
  if (!circuitJson) return roles;
  const elements = circuitJson as El[];

  const components = new Map<string, El>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      components.set(String(el.source_component_id), el);
    }
  }
  const nameOf = (id: unknown) => String(components.get(String(id ?? ""))?.name ?? "");

  // port -> component, and port -> net name
  const portOwner = new Map<string, string>();
  const portName = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "source_port" || !el.source_port_id) continue;
    portOwner.set(String(el.source_port_id), String(el.source_component_id ?? ""));
    portName.set(String(el.source_port_id), String(el.name ?? ""));
  }

  const netNames = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_net" && el.source_net_id) {
      netNames.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }

  /** for each component: the nets it touches and the components it is in contact with */
  const nets = new Map<string, Set<string>>();
  const neighbours = new Map<string, Set<string>>();
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const ports = (el.connected_source_port_ids as string[] | undefined) ?? [];
    const netLabels = ((el.connected_source_net_ids as string[] | undefined) ?? [])
      .map((id) => netNames.get(id))
      .filter((n): n is string => Boolean(n));
    const owners = [...new Set(ports.map((p) => portOwner.get(p) ?? "").filter(Boolean))];
    for (const owner of owners) {
      const set = nets.get(owner) ?? new Set<string>();
      for (const label of netLabels) set.add(label);
      nets.set(owner, set);
      const near = neighbours.get(owner) ?? new Set<string>();
      for (const other of owners) if (other !== owner) near.add(other);
      neighbours.set(owner, near);
    }
  }

  // positions, so we can say "near U1"
  const centers = new Map<string, { x: number; y: number }>();
  for (const el of elements) {
    if (el.type !== "pcb_component" || !el.source_component_id) continue;
    const c = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const x = num(c.x);
    const y = num(c.y);
    if (x !== null && y !== null) centers.set(String(el.source_component_id), { x, y });
  }
  const nearestChip = (id: string): string | null => {
    const here = centers.get(id);
    if (!here) return null;
    let best: string | null = null;
    let bestD = 8;
    for (const [otherId, comp] of components) {
      if (otherId === id) continue;
      const ftype = String(comp.ftype ?? "");
      if (ftype !== "simple_chip" && !String(comp.name ?? "").startsWith("U")) continue;
      const there = centers.get(otherId);
      if (!there) continue;
      const d = Math.hypot(here.x - there.x, here.y - there.y);
      if (d < bestD) {
        bestD = d;
        best = String(comp.name ?? "");
      }
    }
    return best;
  };

  for (const [id, comp] of components) {
    const name = String(comp.name ?? "");
    if (!name) continue;
    const ftype = String(comp.ftype ?? "");
    const touched = [...(nets.get(id) ?? [])];
    const onPower = touched.filter((n) => POWER_RE.test(n) && !GROUND_RE.test(n));
    const onGround = touched.filter((n) => GROUND_RE.test(n));
    const near = [...(neighbours.get(id) ?? [])].map(nameOf).filter(Boolean);

    if (ftype === "simple_capacitor") {
      const farads = parseValue(comp.capacitance ?? comp.display_value);
      const value = String(comp.display_value ?? comp.capacitance ?? "");
      const crystal = near.find((n) => /^X\d/.test(n));
      if (crystal) {
        roles.set(name, {
          role: "Condensatore di carico",
          why: `Serve al quarzo ${crystal} per oscillare alla frequenza giusta. Il valore dipende dal quarzo: cambiarlo sposta la frequenza.`,
        });
        continue;
      }
      if (onPower.length > 0 && onGround.length > 0) {
        const chip = nearestChip(id);
        const big = farads !== null && farads >= 1e-6;
        roles.set(name, {
          role: big ? "Serbatoio di alimentazione" : "Disaccoppiamento",
          why: big
            ? `Riserva di energia sulla ${onPower[0]}: copre gli assorbimenti improvvisi senza far scendere la tensione.`
            : `Tiene ferma la ${onPower[0]}${chip ? ` vicino a ${chip}` : ""}: quando il chip commuta, la corrente la prende da qui invece che da tutta la scheda. Va tenuto attaccato al piedino, spostarlo lo rende inutile.`,
        });
        continue;
      }
      if (onPower.length === 0 && onGround.length === 0 && near.length >= 2) {
        roles.set(name, {
          role: "Accoppiamento",
          why: `In serie fra ${near.slice(0, 2).join(" e ")}: lascia passare il segnale e blocca la componente continua.`,
        });
        continue;
      }
      roles.set(name, {
        role: "Condensatore",
        why: value ? `Valore ${value}. Collegato a ${touched.join(", ") || "nessuna rete nota"}.` : "Collegamento non riconosciuto.",
      });
      continue;
    }

    if (ftype === "simple_resistor") {
      const ohms = parseValue(comp.resistance ?? comp.display_value);
      const value = String(comp.display_value ?? comp.resistance ?? "");
      const led = near.find((n) => /^D\d|LED/i.test(n));
      if (led) {
        roles.set(name, {
          role: "Limitazione di corrente",
          why: `Decide quanta corrente passa nel LED ${led}, cioe' quanto illumina e quanto consuma. Senza, il LED si brucia.`,
        });
        continue;
      }
      // RC filter: resistor in series with a capacitor to ground
      const capNeighbour = [...(neighbours.get(id) ?? [])].find(
        (other) => String(components.get(other)?.ftype ?? "") === "simple_capacitor",
      );
      if (capNeighbour && ohms !== null) {
        const farads = parseValue(
          components.get(capNeighbour)?.capacitance ?? components.get(capNeighbour)?.display_value,
        );
        if (farads !== null && farads > 0) {
          const hz = 1 / (2 * Math.PI * ohms * farads);
          roles.set(name, {
            role: "Filtro RC",
            why: `Con ${nameOf(capNeighbour)} forma un filtro passa-basso: taglia sopra ${formatHz(hz)}. Serve a togliere i disturbi piu' veloci del segnale utile.`,
          });
          continue;
        }
      }
      if (onPower.length > 0 && near.length > 0) {
        roles.set(name, {
          role: "Pull-up",
          why: `Tiene alto ${near[0]} quando nessuno lo pilota: senza, il piedino resterebbe a mezz'aria e leggerebbe a caso.`,
        });
        continue;
      }
      if (onGround.length > 0 && near.length > 0) {
        roles.set(name, {
          role: "Pull-down",
          why: `Tiene basso ${near[0]} quando nessuno lo pilota: senza, il piedino resterebbe a mezz'aria.`,
        });
        continue;
      }
      if (near.length >= 2) {
        roles.set(name, {
          role: "Resistenza in serie",
          why: `Fra ${near.slice(0, 2).join(" e ")}: smussa il fronte del segnale e riduce i disturbi che partono da questa linea.`,
        });
        continue;
      }
      roles.set(name, {
        role: "Resistenza",
        why: value ? `Valore ${value}.` : "Collegamento non riconosciuto.",
      });
      continue;
    }

    if (ftype === "simple_crystal" || ftype === "simple_resonator") {
      roles.set(name, {
        role: "Quarzo",
        why: "Da' al microcontrollore un battito preciso. Senza, il tempo lo tiene un oscillatore interno, molto meno accurato.",
      });
      continue;
    }

    if (ftype === "simple_diode") {
      roles.set(name, {
        role: "Diodo",
        why: onGround.length > 0
          ? "Protegge dalle sovratensioni e dall'inversione di polarita': lascia passare la corrente in un verso solo."
          : "Lascia passare la corrente in un verso solo.",
      });
      continue;
    }

    if (ftype === "simple_led") {
      roles.set(name, { role: "LED", why: "Segnala a chi guarda cosa sta facendo la scheda." });
      continue;
    }

    if (ftype === "simple_pin_header" || ftype === "simple_connector") {
      roles.set(name, {
        role: "Connettore",
        why: `Porta fuori dalla scheda ${touched.slice(0, 4).join(", ") || "i segnali"}.`,
      });
      continue;
    }

    if (ftype === "simple_push_button" || ftype === "simple_switch") {
      roles.set(name, { role: "Pulsante", why: "Comando manuale: chiude un contatto quando lo premi." });
      continue;
    }

    // chips and everything else: at least say what it lives on
    const supplier = comp.supplier_part_numbers as Record<string, unknown> | undefined;
    const code = supplier
      ? Object.values(supplier)
          .map((v) => (Array.isArray(v) ? v[0] : v))
          .find(Boolean)
      : null;
    roles.set(name, {
      role: ftype ? ftype.replace(/^simple_/, "") : "Componente",
      why: `Alimentato da ${onPower[0] ?? "una rete non riconosciuta"}${
        code ? `, codice ${String(code)}` : ""
      }. Collegato a ${near.slice(0, 4).join(", ") || "nessun altro componente"}.`,
    });
  }

  return roles;
}
