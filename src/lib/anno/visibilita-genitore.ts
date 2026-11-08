import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { logEvento } from '@/lib/logging/logger'

/**
 * PR 4.4 · CHE COSA VEDE UNA FAMIGLIA: le route chiamano le funzioni SQL di visibilità da qui.
 *
 * Le funzioni (`20261108170148_anno_visibilita_genitore_funzioni.sql`) sono del solo `service_role` e prendono l'utente come
 * parametro: la regola sta in SQL una volta sola, e qui c'è soltanto la lettura del loro esito. Sono tre, e la differenza è il
 * punto del modulo:
 *
 *  · `ok` — la funzione ha risposto, anche con zero righe;
 *  · `indietro` — il database non ha ancora lo schema dell'anno (la CI, la finestra del deploy): la route fa quello che fa
 *    oggi, e resta una riga `info`;
 *  · `guasto` — ogni altro errore. Non si ripiega MAI sulla lista larga: la route risponde vuoto o con un errore, come fa oggi
 *    quando una sua lettura si rompe. Un guasto non deve aprire dati di minori.
 *
 * Nessuno mocka questo modulo, come `@/lib/alunni/attivo`: `@/lib/anagrafiche/legami` e `@/lib/auth/require-staff` li
 * sostituiscono decine di test con una factory, e un export nuovo là li farebbe esplodere.
 *
 * Il canale è `anno-scolastico`, che non sta in `EVENTI_PERSISTITI`: gli `info` restano sui log di Vercel e non finiscono in
 * `app_log` a ogni schermata di ogni famiglia. Solo uuid, numeri e codici. `motivo` è una chiave redatta: il perché sta in `tipo`.
 */

export type EsitoVisibilita<T> =
  | { stato: 'ok'; righe: T[] }
  | { stato: 'indietro' }
  | { stato: 'guasto'; errore: { code?: string; message?: string } }

/** Una riga per FREQUENZA viva: lo stesso bambino può comparire due volte, con due sedi su anni attivi diversi. */
export interface RigaFiglioAttivo {
  alunno_id: string
  frequenza_id: string
  section_id: string | null
  scuola_id: string
}

/** Una riga per coppia: due figli sono due righe sullo stesso avviso. */
export interface CoppiaAvviso {
  avviso_id: string
  alunno_id: string
}

export type FunzioneVisibilita =
  | 'figli_attivi'
  | 'avvisi_visibili_genitore'
  | 'thread_visibili'
  | 'thread_e_visibile'
  | 'voci_visibili_genitore'
  | 'galleria_pagina_genitore'

/**
 * Il tetto di righe di PostgREST (`max_rows`) taglia anche una funzione, in silenzio: la lista resta corta e nessuno lo sa. Una
 * famiglia non ci arriva nemmeno vicino e tagliare chiude invece di aprire, ma non deve succedere senza una riga in tabella.
 */
const RIGHE_DA_CONTROLLARE = 1000

/**
 * Chiama una funzione di visibilità e ne legge l'esito. `utente` è sempre quello del gate, mai un parametro del client.
 */
export async function leggiVisibilita<T>(
  supabase: SupabaseClient,
  funzione: FunzioneVisibilita,
  utente: string,
  altri: Record<string, unknown> = {},
): Promise<EsitoVisibilita<T>> {
  const operazione = `anno/visibilita:${funzione}`
  const { data, error } = await supabase.rpc(funzione, { p_utente: utente, ...altri })
  if (error) {
    const err = error as { code?: string; message?: string }
    if (schemaAnnoIndietro(err)) {
      logEvento('anno-scolastico', 'info', { operazione, esito: 'schema-indietro', error_code: err.code })
      return { stato: 'indietro' }
    }
    logEvento('anno-scolastico', 'error', { operazione, esito: 'lettura-fallita', error_code: err.code, utente }, err)
    return { stato: 'guasto', errore: err }
  }
  const righe = (Array.isArray(data) ? data : data === null || data === undefined ? [] : [data]) as T[]
  if (righe.length >= RIGHE_DA_CONTROLLARE) {
    logEvento('anno-scolastico', 'warn', { operazione, esito: 'righe-forse-tagliate', n: righe.length, utente })
  } else {
    logEvento('anno-scolastico', 'info', { operazione, esito: 'letta', n: righe.length })
  }
  return { stato: 'ok', righe }
}

/** I figli attivi di un genitore: l'elenco dei bambini, senza il doppione di chi ha due frequenze vive. */
export function figliAttiviDi(supabase: SupabaseClient, utente: string): Promise<EsitoVisibilita<RigaFiglioAttivo>> {
  return leggiVisibilita<RigaFiglioAttivo>(supabase, 'figli_attivi', utente)
}

export function idDeiFigli(righe: RigaFiglioAttivo[]): string[] {
  return [...new Set(righe.map((r) => r.alunno_id))]
}

/** `indietro` e `guasto` li decide chi chiama: il gate risponde 500, una lista risponde come fa con ogni sua lettura. */
export type EsitoFiglioAttivo = 'attivo' | 'non-attivo' | 'indietro' | 'guasto'

export async function esitoFiglioAttivo(
  supabase: SupabaseClient,
  utente: string,
  alunno: string,
): Promise<EsitoFiglioAttivo> {
  const esito = await figliAttiviDi(supabase, utente)
  if (esito.stato === 'indietro') return 'indietro'
  if (esito.stato === 'guasto') return 'guasto'
  return esito.righe.some((r) => r.alunno_id === alunno) ? 'attivo' : 'non-attivo'
}

/** Una riga per thread: vale per le due parti, il genitore e l'operatore. */
export interface RigaThreadVisibile {
  thread_id: string
  scrivibile: boolean
}

export type EsitoThread = 'scrivibile' | 'sola-lettura' | 'nascosto' | 'indietro' | 'guasto'

/** Per le route che ricevono l'id di un thread. La partecipazione la controllano loro, prima: qui è solo la visibilità. */
export async function esitoThread(supabase: SupabaseClient, utente: string, thread: string): Promise<EsitoThread> {
  const esito = await leggiVisibilita<RigaThreadVisibile>(supabase, 'thread_visibili', utente)
  if (esito.stato !== 'ok') return esito.stato
  const riga = esito.righe.find((r) => r.thread_id === thread)
  if (!riga) return 'nascosto'
  return riga.scrivibile ? 'scrivibile' : 'sola-lettura'
}

/**
 * Un rifiuto della visibilità: `warn`, così resta in tabella. Il `403` di `withRoute` è `info`, e un rifiuto nuovo che non lascia
 * niente è la forma del difetto che ha nascosto per un mese una funzione rotta: alla domanda «quante famiglie lo prendono
 * dopo il deploy?» deve rispondere una query.
 */
export function logVisibilitaNegata(tipo: string, campi: Record<string, string | number>, distingui: string[] = []): void {
  logEvento('anno-scolastico', 'warn', { operazione: 'anno/visibilita:negato', tipo, ...campi, stato: 403 }, undefined, { distingui })
}
