/**
 * THE stitch_ground TOOL, one implementation for the three doors that open it:
 * the agent's tool, the MCP tool and the viewer's "Cuci la massa" (all of them
 * through executeTool). Whoever calls it has already checked the access: the
 * same as write_file to write (apply), viewing to look (dryRun).
 *
 * It reads the SAVED board (the one on screen, the one the exports are made
 * from) and the project's rules, takes off it the vias a previous run wrote
 * (see ground-stitching-file.ts), runs cuciLaMassa, and only with apply: true
 * writes cucitura-massa.tsx. It never compiles and never touches main.tsx.
 */

import type { CompileCache } from "./project-store";
import { resolveDesignRules } from "./design-rules";
import {
  cuciLaMassa,
  CORONA_DI_SERIE_MM,
  FORO_DI_SERIE_MM,
  leggiOpzioniCucitura,
  MAX_VIE_DI_SERIE,
  MAX_VIE_LIMITE,
  MOTIVI,
  PASSO_DI_SERIE_MM,
  PASSO_MAX_MM,
  PASSO_MIN_MM,
  senzaLeVieAi,
  type MotivoScarto,
  type TipoVia,
} from "./ground-stitching";
import { FILE_CUCITURA, fileDellaCucitura, mainLaUsa, nomiGiaUsati, RIGA_IMPORT, RIGA_USO, vieDelFile } from "./ground-stitching-file";

/** what the tool is, for whoever chooses it: the agent's definition and the MCP one */
export const DESCRIZIONE_CUCITURA =
  "Cuce la massa: propone, e solo con apply: true scrive, vie passanti della rete di massa a passo regolare dove la massa " +
  "c'e', senza toccare il resto. Usalo SOLO quando la persona lo chiede: le vie non si mettono per regola. " +
  "Legge la scheda salvata e le regole del progetto; una via sta dove la massa copre tutta la corona su almeno due strati, " +
  "su ogni strato con colate di massa, esterno o interno, la massa c'e' (le zone senza rame, antenne, quarzi, porte acustiche, " +
  "i ritagli e i vuoti di un piano restano tali su ogni strato), " +
  "fuori dagli ingombri dei pezzi su tutte e due le facce e dagli spazi di innesto, fuori dalle piazzole (anche di massa) e " +
  "lontana da fori, vie, bordo, zone vietate e rame di altre reti su ogni strato (distanza della colata, mai sotto le regole a " +
  "coppie), col foro lontano dalla serigrafia delle due facce (minSilkscreenClearanceMm). " +
  "Prima collega le isole di massa staccate, poi la fila sul bordo, poi la griglia. " +
  "Pratica (guide di fabbricanti e strumenti, non norme: atlaspcb.com, aivon.com, allpcb.com, flux.ai): passo massimo lambda/20 " +
  "con lambda nel materiale = c / (f x radice di er); FR4 (er circa 4,3): circa 2,7 mm a 2,7 GHz (LTE), circa 4,6 mm a 1,575 GHz " +
  "(GNSS); di serie griglia da circa 3 mm e fila sul bordo a 5-10 mm. " +
  `Di serie passo ${PASSO_DI_SERIE_MM} mm (lambda/20 fino a circa 2,9 GHz in FR4), griglia sfalsata, fila sul bordo, foro ` +
  `${FORO_DI_SERIE_MM} mm e corona ${CORONA_DI_SERIE_MM} mm alzati ai minimi del progetto se servono, al massimo ${MAX_VIE_DI_SERIE} vie. ` +
  "Le linee a impedenza controllata non si riconoscono da sole: mettile in retiLontane o in zoneEscluse. " +
  `dryRun (di serie) restituisce vie proposte con le coordinate, scarti per motivo e isole; apply: true scrive ${FILE_CUCITURA} ` +
  "(rilanciato lo riscrive per intero) e NON compila; main.tsx non viene toccato: se non lo usa, la risposta dice le righe da aggiungere.";

/** what each parameter is, for both definitions */
export const PARAMETRI_CUCITURA = {
  rete: "nome della rete da cucire; di serie GND (se ambigua lo dice e non sceglie)",
  passoMm: `passo della griglia in mm, ${PASSO_MIN_MM}..${PASSO_MAX_MM} (di serie ${PASSO_DI_SERIE_MM})`,
  sfalsata: "griglia sfalsata a triangolo, ogni via con sei vicine a un passo (di serie true); false: quadrata",
  bordo: "fila di vie lungo il contorno della scheda (di serie true)",
  passoBordoMm: `passo della fila sul bordo in mm, ${PASSO_MIN_MM}..${PASSO_MAX_MM} (di serie quello della griglia)`,
  foroMm: `foro della via in mm (di serie ${FORO_DI_SERIE_MM}, mai sotto minViaHoleMm del progetto)`,
  coronaMm: `diametro della corona in mm (di serie ${CORONA_DI_SERIE_MM}, mai sotto minViaDiameterMm del progetto)`,
  maxVie: `tetto di vie, 1..${MAX_VIE_LIMITE} (di serie ${MAX_VIE_DI_SERIE})`,
  distanzaPisteMm: "distanza minima dalle piste di altre reti in mm (di serie quella della colata)",
  zoneEscluse: "zone dove non mettere vie: rettangoli {x, y, w, h} (centro e misure, mm) o poligoni {punti: [{x, y}]}",
  retiLontane: "reti da cui stare piu' lontano (le linee radio): [{rete, distanzaMm}]",
  dryRun: "true (di serie): guarda soltanto",
  apply: `true: scrive ${FILE_CUCITURA} (stessi permessi di write_file), senza compilare`,
} as const;

/** an island in a list for a model: at most this many, the rest counted */
const MAX_ISOLE_ELENCATE = 50;

export interface EsecuzioneCucitura {
  result: Record<string, unknown>;
  fileChanged?: { path: string; content: string };
}

export async function eseguiCucitura({
  files,
  args,
  cache,
  schedaVecchia,
  scrivi,
}: {
  files: Record<string, string>;
  args: Record<string, unknown>;
  /** the saved board of the project */
  cache: Pick<CompileCache, "circuitJson"> | null;
  /** the saved board is older than the files; null when it could not be told */
  schedaVecchia: boolean | null;
  /** writes a file of the project */
  scrivi: (path: string, content: string) => Promise<void>;
}): Promise<EsecuzioneCucitura> {
  const lettura = leggiOpzioniCucitura(args, ["projectId"]);
  if ("errori" in lettura) return { result: { error: `stitch_ground: ${lettura.errori.slice(0, 10).join("; ")}` } };
  const circuito = cache?.circuitJson as unknown[] | undefined;
  if (!Array.isArray(circuito) || !circuito.some((el) => (el as { type?: unknown })?.type === "pcb_board")) {
    return { result: { error: "nessuna scheda compilata salvata: compila prima, la cucitura si calcola sulla scheda salvata" } };
  }
  const regole = resolveDesignRules(files).rules;
  // the vias the file already put on the board are not ground already stitched: see ground-stitching-file.ts
  const scheda = senzaLeVieAi(circuito, vieDelFile(files[FILE_CUCITURA]));
  const esito = cuciLaMassa(scheda, regole, lettura.opzioni);
  if (!esito.ok) return { result: { error: esito.errore, ...(esito.candidate ? { candidate: esito.candidate } : {}) } };

  const coordinate: Record<TipoVia, Array<[number, number]>> = { isola: [], bordo: [], griglia: [] };
  for (const v of esito.vie) coordinate[v.tipo].push([v.x, v.y]);
  const perche: Partial<Record<MotivoScarto, string>> = {};
  for (const m of Object.keys(esito.scarti) as MotivoScarto[]) perche[m] = MOTIVI[m];
  for (const i of esito.isole.senzaPosto) perche[i.motivo] = MOTIVI[i.motivo];
  const usa = mainLaUsa(files["main.tsx"]);
  const result: Record<string, unknown> = {
    ok: true,
    scritto: false,
    rete: esito.rete.nome,
    via: esito.via,
    passoMm: esito.passoMm,
    sfalsata: esito.sfalsata,
    bordo: esito.bordo,
    copreFinoGHz: esito.copreFinoGHz,
    vie: esito.vie.length,
    conteggio: esito.conteggio,
    posizioniProvate: esito.posizioniProvate,
    scarti: esito.scarti,
    perche,
    isole: {
      trovate: esito.isole.trovate,
      collegate: esito.isole.collegate.length,
      senzaPosto: esito.isole.senzaPosto.length,
      elencoCollegate: esito.isole.collegate.slice(0, MAX_ISOLE_ELENCATE),
      elencoSenzaPosto: esito.isole.senzaPosto.slice(0, MAX_ISOLE_ELENCATE),
    },
    tetto: esito.tetto,
    avvisi: esito.avvisi,
    tempoMs: esito.tempoMs,
    file: FILE_CUCITURA,
    main: usa ? { usaIlFile: true } : { usaIlFile: false, righeDaAggiungere: [RIGA_IMPORT, `${RIGA_USO} dentro <board>`] },
    ...(schedaVecchia ? { schedaPiuVecchiaDeiFile: true } : {}),
  };
  if (!lettura.apply) {
    // the coordinates last: an answer cut to fit a model's context loses them before the counts
    return { result: { ...result, nota: `dryRun: niente scritto; apply: true scrive ${FILE_CUCITURA} senza compilare`, coordinate } };
  }

  // --- apply: the file, whole
  if (esito.vie.length === 0 && files[FILE_CUCITURA] === undefined) {
    return { result: { ...result, nota: `nessuna via da scrivere: ${FILE_CUCITURA} non e' stato creato` } };
  }
  const altro = nomiGiaUsati(files);
  if (altro) return { result: { error: `${altro} usa gia' nomi di via VCM<n>: rinominali prima di scrivere la cucitura` } };
  const testo = fileDellaCucitura(esito);
  if ("errore" in testo) return { result: { error: testo.errore } };
  await scrivi(FILE_CUCITURA, testo.contenuto);
  return {
    result: {
      ...result,
      scritto: true,
      chars: testo.contenuto.length,
      nota:
        `scritto ${FILE_CUCITURA}; nessuna compilazione avviata: la scheda e' da aggiornare` +
        (usa ? "" : `, e conta solo dopo aver aggiunto a main.tsx le righe in main.righeDaAggiungere`),
      coordinate,
    },
    fileChanged: { path: FILE_CUCITURA, content: testo.contenuto },
  };
}
