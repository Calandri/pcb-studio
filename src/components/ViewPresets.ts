/**
 * Board views, in the style of "map layers": one configuration per
 * real task, instead of a list of checkboxes to compose by hand.
 * The flags map to the internal state of @tscircuit/pcb-viewer.
 */

export interface ViewFlags {
  is_showing_drc_errors: boolean;
  is_showing_rats_nest: boolean;
  is_showing_copper_pours: boolean;
  is_showing_courtyards: boolean;
  is_showing_solder_mask: boolean;
  is_showing_silkscreen: boolean;
  is_showing_fabrication_notes: boolean;
  is_showing_multiple_traces_length: boolean;
  is_showing_autorouting: boolean;
  is_showing_pcb_groups: boolean;
  is_showing_group_anchor_offsets: boolean;
  /** stencil aperture: where the solder paste goes, smaller than the pad */
  is_showing_paste_mask: boolean;
}

const NONE: ViewFlags = {
  is_showing_drc_errors: false,
  is_showing_rats_nest: false,
  is_showing_copper_pours: false,
  is_showing_courtyards: false,
  is_showing_solder_mask: false,
  is_showing_silkscreen: false,
  is_showing_fabrication_notes: false,
  is_showing_multiple_traces_length: false,
  is_showing_autorouting: false,
  is_showing_pcb_groups: false,
  is_showing_group_anchor_offsets: false,
  is_showing_paste_mask: false,
};

export interface ViewPreset {
  key: string;
  label: string;
  description: string;
  flags: ViewFlags;
}

export const VIEW_PRESETS: ViewPreset[] = [
  {
    key: "overview",
    label: "Panoramica",
    description:
      "Piste, piani di rame e sigle dei componenti: la vista di lavoro, quella che risponde alla domanda «com'è fatta la mia scheda».",
    flags: {
      ...NONE,
      is_showing_copper_pours: true,
      is_showing_silkscreen: true,
    },
  },
  {
    key: "assembly",
    label: "Montaggio",
    description:
      "La scheda come esce dalla fabbrica: la vernice verde copre il rame (quindi le piste non si vedono, esattamente come dal vero) e restano scoperti pad e serigrafia.",
    flags: {
      ...NONE,
      is_showing_silkscreen: true,
      is_showing_solder_mask: true,
      is_showing_paste_mask: true,
    },
  },
  {
    key: "copper",
    label: "Rame e percorsi",
    description:
      "Solo il rame: piste, piani di massa e alimentazione. Serve a giudicare il routing senza distrazioni.",
    flags: { ...NONE, is_showing_copper_pours: true },
  },
  {
    key: "interference",
    label: "Interferenze",
    description:
      "Ingombri dei componenti ed errori di produzione: è la vista per capire perché due pezzi non ci stanno o perché l'autorouter si blocca.",
    flags: {
      ...NONE,
      is_showing_courtyards: true,
      is_showing_drc_errors: true,
      is_showing_solder_mask: true,
    },
  },
  {
    key: "connections",
    label: "Collegamenti mancanti",
    description:
      "Mostra come linee dritte i collegamenti che devono ancora diventare piste, con la lunghezza di quelle già fatte.",
    flags: {
      ...NONE,
      is_showing_rats_nest: true,
      is_showing_multiple_traces_length: true,
    },
  },
  {
    key: "fabrication",
    label: "Produzione",
    description:
      "Quello che vede il fabbricante: serigrafia, vernice verde, pasta salda e note di fabbricazione. La pasta salda e' l'apertura dello stencil, sempre piu' piccola del pad.",
    flags: {
      ...NONE,
      is_showing_silkscreen: true,
      is_showing_solder_mask: true,
      is_showing_fabrication_notes: true,
      is_showing_paste_mask: true,
    },
  },
  {
    key: "everything",
    label: "Tutto",
    description: "Tutti i livelli accesi insieme: utile per un colpo d'occhio finale.",
    flags: {
      is_showing_drc_errors: true,
      is_showing_rats_nest: true,
      is_showing_copper_pours: true,
      is_showing_courtyards: true,
      is_showing_solder_mask: true,
      is_showing_silkscreen: true,
      is_showing_fabrication_notes: true,
      is_showing_multiple_traces_length: false,
      is_showing_autorouting: false,
      is_showing_pcb_groups: true,
      is_showing_group_anchor_offsets: false,
      is_showing_paste_mask: true,
    },
  },
];
