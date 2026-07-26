/**
 * Versione del motore di controlli (DRC, PRC, schematic quality, variant
 * engine, struttura del compile summary). INCREMENTARE a ogni modifica di
 * quelle logiche: la compile cache e' valida solo se prodotta dalla stessa
 * versione — altrimenti la scheda va rivalutata (POST /api/recheck), perche'
 * una "verita" calcolata con controlli vecchi non e' piu' una verita.
 */
export const CHECKS_ENGINE_VERSION = 1;
