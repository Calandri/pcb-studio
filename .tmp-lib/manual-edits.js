/**
 * Modifiche manuali: il livello geometrico dell'essere umano.
 *
 * PERCHE' UN FILE SEPARATO. In PCB Studio main.tsx appartiene all'agente, che
 * lo riscrive per intero a ogni turno. Se il trascinamento di un componente
 * scrivesse dentro main.tsx, il primo "sistema il decoupling" cancellerebbe
 * ore di posizionamento a mano; e viceversa un umano che tocca il file rompe
 * il lavoro dell'agente. Qui i due domini restano separati: main.tsx dice CHE
 * COSA e' collegato a che cosa, manual-edits.json dice DOVE sta e COME passa
 * la pista. Nessuno dei due sovrascrive l'altro.
 *
 * COME VIENE APPLICATO. Non a runtime sul Circuit JSON (si perderebbe al primo
 * ri-sbroglio) ma in compilazione, iniettando nelle sorgenti le stesse prop che
 * tscircuit onora con la priorita' piu' alta:
 *   - posizione schematica  -> schX / schY sul tag del componente
 *   - posizione sul rame    -> pcbX / pcbY sul tag del componente
 *   - percorso di una pista -> manualEdits={{manual_trace_hints}} sul <board>
 * Le sorgenti dell'utente non vengono mai modificate: l'iniezione vive solo
 * nella mappa file passata al compilatore.
 *
 * Verificato su @tscircuit/core 0.0.1512: schX/schY su un SOLO componente
 * bloccano quel componente e lasciano l'auto layout agli altri anche quando il
 * foglio e' diviso in sezioni (schSectionName), mentre la prop manualEdits con
 * schematic_placements viene ignorata dal layout a sezioni e i pcb_placements
 * vengono ignorati appena un componente ha gia' pcbX/pcbY. Per questo si passa
 * dalle prop e non dal formato nativo, che qui non funzionerebbe.
 */
export const MANUAL_EDITS_PATH = "manual-edits.json";
export function emptyManualEdits() {
    return { schematic_placements: [], pcb_placements: [], manual_trace_hints: [] };
}
export function countManualEdits(edits) {
    const schematic = edits.schematic_placements.length;
    const pcb = edits.pcb_placements.length;
    const traceHints = edits.manual_trace_hints.length;
    return { schematic, pcb, traceHints, total: schematic + pcb + traceHints };
}
const isPoint = (v) => typeof v === "object" &&
    v !== null &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y);
/**
 * Lettura difensiva: il file e' scritto dal server ma vive nella mappa file del
 * progetto, quindi puo' arrivare modificato a mano o troncato. Una riga
 * malformata viene scartata, non fa fallire la compilazione dell'intera scheda.
 */
export function parseManualEdits(raw) {
    const out = emptyManualEdits();
    if (!raw)
        return out;
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return out;
    }
    if (typeof data !== "object" || data === null)
        return out;
    const obj = data;
    for (const key of ["schematic_placements", "pcb_placements"]) {
        const list = obj[key];
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            if (typeof item !== "object" || item === null)
                continue;
            const p = item;
            if (typeof p.selector !== "string" || !p.selector)
                continue;
            if (!isPoint(p.center))
                continue;
            out[key].push({
                selector: p.selector,
                center: { x: round3(p.center.x), y: round3(p.center.y) },
            });
        }
    }
    const hints = obj.manual_trace_hints;
    if (Array.isArray(hints)) {
        for (const item of hints) {
            if (typeof item !== "object" || item === null)
                continue;
            const h = item;
            if (typeof h.pcb_port_selector !== "string" || !h.pcb_port_selector)
                continue;
            if (!Array.isArray(h.offsets))
                continue;
            const offsets = h.offsets
                .filter(isPoint)
                .map((o) => ({
                x: round3(o.x),
                y: round3(o.y),
                ...(o.via === true ? { via: true } : {}),
            }));
            if (offsets.length === 0)
                continue;
            out.manual_trace_hints.push({ pcb_port_selector: h.pcb_port_selector, offsets });
        }
    }
    return out;
}
export function serializeManualEdits(edits) {
    return `${JSON.stringify(edits, null, 2)}\n`;
}
const round3 = (v) => Math.round(v * 1000) / 1000;
const isNameStart = (c) => /[A-Za-z_]/.test(c);
const isNameChar = (c) => /[A-Za-z0-9_.$]/.test(c);
export function scanJsxTags(src) {
    const tags = [];
    for (let i = 0; i < src.length; i++) {
        if (src[i] !== "<")
            continue;
        const nameStart = i + 1;
        if (nameStart >= src.length || !isNameStart(src[nameStart]))
            continue;
        let j = nameStart;
        while (j < src.length && isNameChar(src[j]))
            j++;
        const name = src.slice(nameStart, j);
        // attributi: si scorre fino al ">" di chiusura ignorando quelli dentro
        // stringhe o dentro espressioni {}
        let depth = 0;
        let quote = null;
        let k = j;
        let closed = -1;
        for (; k < src.length; k++) {
            const c = src[k];
            if (quote) {
                if (c === "\\")
                    k++;
                else if (c === quote)
                    quote = null;
                continue;
            }
            if (c === '"' || c === "'" || c === "`") {
                quote = c;
                continue;
            }
            if (c === "{")
                depth++;
            else if (c === "}")
                depth--;
            else if (c === ">" && depth <= 0) {
                closed = k;
                break;
            }
        }
        if (closed === -1)
            continue;
        // il "/" dell'auto-chiusura non fa parte degli attributi
        let attrsEnd = closed;
        while (attrsEnd > j && /\s/.test(src[attrsEnd - 1]))
            attrsEnd--;
        if (attrsEnd > j && src[attrsEnd - 1] === "/")
            attrsEnd--;
        tags.push({ name, start: i, end: closed + 1, attrsStart: j, attrsEnd });
        i = closed;
    }
    return tags;
}
/** valore grezzo di un attributo dentro il testo attributi di un tag */
export function readAttr(attrs, attr) {
    const re = new RegExp(`(^|\\s)${attr}\\s*=\\s*`, "g");
    const m = re.exec(attrs);
    if (!m)
        return null;
    const i = m.index + m[0].length;
    if (attrs[i] === '"' || attrs[i] === "'") {
        const q = attrs[i];
        const end = attrs.indexOf(q, i + 1);
        return end === -1 ? null : attrs.slice(i + 1, end);
    }
    if (attrs[i] === "{") {
        let depth = 0;
        for (let k = i; k < attrs.length; k++) {
            if (attrs[k] === "{")
                depth++;
            else if (attrs[k] === "}") {
                depth--;
                if (depth === 0)
                    return attrs.slice(i + 1, k);
            }
        }
        return null;
    }
    const end = attrs.slice(i).search(/\s|$/);
    return attrs.slice(i, i + (end === -1 ? attrs.length : end));
}
/** valore numerico di una prop scritta come schX={-4} o schX="2mm" */
export function readNumericProp(attrs, attr) {
    const raw = readAttr(attrs, attr);
    if (raw === null)
        return null;
    const n = Number.parseFloat(raw.trim().replace(/mm$/, ""));
    return Number.isFinite(n) ? n : null;
}
/** sostituisce la prop se c'e', altrimenti la aggiunge in coda agli attributi */
function upsertAttr(attrs, attr, valueExpr) {
    const re = new RegExp(`(^|\\s)${attr}\\s*=\\s*`);
    const m = re.exec(attrs);
    if (!m)
        return `${attrs.replace(/\s+$/, "")} ${attr}=${valueExpr}`;
    const valueStart = m.index + m[0].length;
    const raw = readAttr(attrs, attr);
    if (raw === null)
        return `${attrs.replace(/\s+$/, "")} ${attr}=${valueExpr}`;
    // lunghezza del valore originale, delimitatori compresi
    const delim = attrs[valueStart];
    const consumed = delim === '"' || delim === "'" || delim === "{" ? raw.length + 2 : raw.length;
    return (attrs.slice(0, m.index + (m[1] ? m[1].length : 0)) +
        `${attr}=${valueExpr}` +
        attrs.slice(valueStart + consumed));
}
// tag che hanno un attributo name ma non sono componenti piazzabili: iniettare
// pcbX su una <trace> o su una <net> e' un errore di compilazione
const NOT_PLACEABLE = new Set(["trace", "net", "schematicsection", "netlabel"]);
/**
 * Riscrive le sorgenti applicando le modifiche manuali. Il risultato e' quello
 * che viene compilato; i file del progetto restano quelli scritti dall'agente.
 */
export function injectManualEdits(main, edits) {
    const sch = new Map(edits.schematic_placements.map((p) => [p.selector, p.center]));
    const pcb = new Map(edits.pcb_placements.map((p) => [p.selector, p.center]));
    const hints = edits.manual_trace_hints;
    if (sch.size === 0 && pcb.size === 0 && hints.length === 0)
        return main;
    const tags = scanJsxTags(main);
    // si lavora dal fondo cosi' gli indici dei tag precedenti restano validi
    let out = main;
    for (let i = tags.length - 1; i >= 0; i--) {
        const tag = tags[i];
        const attrs = out.slice(tag.attrsStart, tag.attrsEnd);
        let next = attrs;
        if (tag.name === "board" && hints.length > 0) {
            const literal = JSON.stringify({ manual_trace_hints: hints });
            next = upsertAttr(next, "manualEdits", `{${literal}}`);
        }
        if (!NOT_PLACEABLE.has(tag.name.toLowerCase())) {
            const name = readAttr(attrs, "name");
            if (name) {
                const s = sch.get(name);
                if (s) {
                    next = upsertAttr(next, "schX", `{${s.x}}`);
                    next = upsertAttr(next, "schY", `{${s.y}}`);
                }
                const p = pcb.get(name);
                if (p) {
                    next = upsertAttr(next, "pcbX", `{${p.x}}`);
                    next = upsertAttr(next, "pcbY", `{${p.y}}`);
                }
            }
        }
        if (next !== attrs) {
            // senza lo spazio il tag diventa `schY={-2}/>`: valido, ma illeggibile
            // per chi apre il file compilato per capire cosa e' stato iniettato
            if (out[tag.attrsEnd] === "/" && !/\s$/.test(next))
                next += " ";
            out = out.slice(0, tag.attrsStart) + next + out.slice(tag.attrsEnd);
        }
    }
    return out;
}
/**
 * Mappa file pronta per il compilatore: main.tsx con le prop iniettate e senza
 * il file delle modifiche manuali (non e' un modulo, non serve al compilatore).
 */
export function applyManualEditsToFsMap(fsMap) {
    const raw = fsMap[MANUAL_EDITS_PATH];
    if (!raw)
        return fsMap;
    const edits = parseManualEdits(raw);
    const rest = { ...fsMap };
    delete rest[MANUAL_EDITS_PATH];
    if (countManualEdits(edits).total === 0)
        return rest;
    const main = rest["main.tsx"];
    if (typeof main !== "string")
        return rest;
    return { ...rest, "main.tsx": injectManualEdits(main, edits) };
}
const findById = (circuitJson, type, idKey, id) => circuitJson.find((e) => e?.type === type && e[idKey] === id) ?? null;
/** nome sorgente di un componente a partire dal suo elemento pcb/schematico */
function sourceName(circuitJson, sourceComponentId) {
    if (typeof sourceComponentId !== "string")
        return null;
    const src = findById(circuitJson, "source_component", "source_component_id", sourceComponentId);
    const name = src?.name;
    return typeof name === "string" && name ? name : null;
}
/**
 * Selettore di porta nella forma ".R1 > .pin1". Serve al tag TraceHint, che
 * risolve la porta per selettore e non per id: gli id cambiano a ogni
 * compilazione, il nome no.
 */
function portSelector(circuitJson, pcbPortId) {
    const pcbPort = findById(circuitJson, "pcb_port", "pcb_port_id", pcbPortId);
    if (!pcbPort)
        return null;
    const srcPortId = pcbPort.source_port_id;
    if (typeof srcPortId !== "string")
        return null;
    const srcPort = findById(circuitJson, "source_port", "source_port_id", srcPortId);
    if (!srcPort)
        return null;
    const comp = sourceName(circuitJson, srcPort.source_component_id);
    if (!comp)
        return null;
    const hints = Array.isArray(srcPort.port_hints) ? srcPort.port_hints : [];
    const pin = (typeof srcPort.name === "string" && srcPort.name) ||
        hints.find((h) => typeof h === "string");
    if (!pin)
        return null;
    return `.${comp} > .${pin}`;
}
const upsertPlacement = (list, selector, center) => {
    const next = list.filter((p) => p.selector !== selector);
    next.push({ selector, center: { x: round3(center.x), y: round3(center.y) } });
    return next;
};
/**
 * Traduce gli eventi dei viewer in modifiche manuali.
 *
 * Il viewer ragiona in coordinate globali della scheda, le prop iniettate sono
 * relative al genitore: si applica quindi lo SPOSTAMENTO alla prop esistente
 * invece della posizione assoluta. Su una scheda piatta le due coincidono, su
 * un componente dentro un <group> solo lo spostamento e' corretto.
 */
export function applyEditEvents({ circuitJson, main, edits, events, }) {
    const out = {
        schematic_placements: [...edits.schematic_placements],
        pcb_placements: [...edits.pcb_placements],
        manual_trace_hints: [...edits.manual_trace_hints],
    };
    const tags = scanJsxTags(main);
    const attrsOf = (name) => {
        for (const tag of tags) {
            if (NOT_PLACEABLE.has(tag.name.toLowerCase()))
                continue;
            const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
            if (readAttr(attrs, "name") === name)
                return attrs;
        }
        return null;
    };
    for (const event of events) {
        if (event.in_progress)
            continue;
        if (event.edit_event_type === "edit_pcb_component_location" &&
            event.pcb_component_id &&
            event.original_center &&
            event.new_center) {
            const el = findById(circuitJson, "pcb_component", "pcb_component_id", event.pcb_component_id);
            const name = el && sourceName(circuitJson, el.source_component_id);
            if (!name)
                continue;
            const existing = out.pcb_placements.find((p) => p.selector === name)?.center;
            const attrs = attrsOf(name);
            const baseX = existing?.x ?? (attrs ? readNumericProp(attrs, "pcbX") : null) ?? event.original_center.x;
            const baseY = existing?.y ?? (attrs ? readNumericProp(attrs, "pcbY") : null) ?? event.original_center.y;
            out.pcb_placements = upsertPlacement(out.pcb_placements, name, {
                x: baseX + (event.new_center.x - event.original_center.x),
                y: baseY + (event.new_center.y - event.original_center.y),
            });
            continue;
        }
        if (event.edit_event_type === "edit_schematic_component_location" &&
            event.schematic_component_id &&
            event.original_center &&
            event.new_center) {
            const el = findById(circuitJson, "schematic_component", "schematic_component_id", event.schematic_component_id);
            const name = el && sourceName(circuitJson, el.source_component_id);
            if (!name)
                continue;
            const existing = out.schematic_placements.find((p) => p.selector === name)?.center;
            const attrs = attrsOf(name);
            const baseX = existing?.x ?? (attrs ? readNumericProp(attrs, "schX") : null) ?? event.original_center.x;
            const baseY = existing?.y ?? (attrs ? readNumericProp(attrs, "schY") : null) ?? event.original_center.y;
            out.schematic_placements = upsertPlacement(out.schematic_placements, name, {
                x: baseX + (event.new_center.x - event.original_center.x),
                y: baseY + (event.new_center.y - event.original_center.y),
            });
            continue;
        }
        if (event.pcb_edit_event_type === "edit_trace_hint" && event.pcb_port_id) {
            const selector = portSelector(circuitJson, event.pcb_port_id);
            if (!selector)
                continue;
            const route = (event.route ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
            const rest = out.manual_trace_hints.filter((h) => h.pcb_port_selector !== selector);
            if (route.length > 0) {
                rest.push({
                    pcb_port_selector: selector,
                    offsets: route.map((p) => ({
                        x: round3(p.x),
                        y: round3(p.y),
                        ...(p.via ? { via: true } : {}),
                    })),
                });
            }
            out.manual_trace_hints = rest;
        }
    }
    return out;
}
/** toglie i vincoli manuali di un componente (o di tutti se name e' null) */
export function releaseManualEdits(edits, scope, name) {
    const keepPlacement = (list, active) => !active ? list : name === null ? [] : list.filter((p) => p.selector !== name);
    const schActive = scope === "schematic" || scope === "all";
    const pcbActive = scope === "pcb" || scope === "all";
    const traceActive = scope === "traces" || scope === "all";
    return {
        schematic_placements: keepPlacement(edits.schematic_placements, schActive),
        pcb_placements: keepPlacement(edits.pcb_placements, pcbActive),
        manual_trace_hints: !traceActive
            ? edits.manual_trace_hints
            : name === null
                ? []
                : edits.manual_trace_hints.filter((h) => !h.pcb_port_selector.startsWith(`.${name} >`)),
    };
}
