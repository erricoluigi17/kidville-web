import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { anniDellaSede } from '@/lib/anno/lettura'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

/**
 * L'anno ATTIVO di ciascuna sede, per le ricerche di una sezione PER NOME e per gli ELENCHI (Compito 4.3.7).
 *
 * I nomi di classe si ripetono ogni anno («1A» c'è nel 2026/27 e ci sarà nel 2027/28): una ricerca per nome che non
 * guarda l'anno può agganciare un bambino alla «1A» sbagliata, in silenzio. E il passaggio d'anno è PER SEDE: nei
 * giorni in cui Aversa è passata al 2027/28 e Giugliano no, «l'anno attivo» non è uno solo. Per questo il risultato
 * è un insieme di COPPIE sede→anno, mai un insieme di anni: il filtro è «`scuola_id = X` E `anno_id = Y`» per ogni
 * sede, e due «1A» della stessa sede non passano insieme. Lo applica `filtraPerAnnoDiSede`.
 *
 * Le funzioni di libreria non hanno la `request` (quindi nemmeno il cookie dell'anno scelto dalla segreteria): per
 * loro l'anno è quello ATTIVO della sede, lo stesso che usa il trigger `sync_alunno_section_id`.
 *
 * `coppie` = le sedi per cui l'anno si conosce (`anni_scolastici.id`, quello che porta `sections.anno_id`).
 * `liberi` = le sedi per cui NON si filtra (fail-open per sede, come il DB della CI): nessuna riga in `anni_sede`,
 * nessun anno attivo, o lettura fallita (in quel caso un `warn` col solo codice d'errore). Una sede così non sparisce
 * dall'elenco in silenzio.
 *
 * Ritorna `null` = «nessun filtro per nessuna sede»: database senza lo schema dell'anno (il DB E2E della CI non è
 * migrato: un `.eq('anno_id', …)` darebbe `42703`), nessuna sede, o nessuna sede con un anno da filtrare.
 *
 * Mai lancia.
 */
export type AnniAttivi = {
  coppie: readonly { sede: string; annoId: string }[]
  liberi: readonly string[]
}

export async function anniAttiviDeiPlessi(
  supabase: SupabaseClient,
  plessi: readonly (string | null | undefined)[],
): Promise<AnniAttivi | null> {
  const sedi = [...new Set(plessi.filter((p): p is string => typeof p === 'string' && p !== ''))]
  if (sedi.length === 0) return null
  const coppie: { sede: string; annoId: string }[] = []
  const liberi: string[] = []
  const guasto = (errore: unknown) =>
    logEvento('anno-scolastico', 'warn', { tipo: 'anni-attivi-non-letti', azione: 'anniAttiviDeiPlessi' }, errore)

  for (const sede of sedi) {
    const lette = await anniDellaSede(supabase, sede)
    if ('indietro' in lette) return null
    if ('guasto' in lette) {
      guasto(lette.guasto)
      liberi.push(sede)
      continue
    }
    if (lette.righe.length === 0) {
      liberi.push(sede)
      continue
    }
    let attivo: string | null = null
    try {
      const r = await supabase.rpc('anno_attivo', { p_scuola: sede })
      if (r.error) {
        if (schemaAnnoIndietro(r.error)) return null
        guasto(r.error)
        liberi.push(sede)
        continue
      }
      attivo = typeof r.data === 'string' ? r.data : null
    } catch (err) {
      guasto(err)
      liberi.push(sede)
      continue
    }
    const riga = lette.righe.find((x) => x.id === attivo)
    if (riga) coppie.push({ sede, annoId: String(riga.anno_id) })
    else liberi.push(sede)
  }
  return coppie.length > 0 ? { coppie, liberi } : null
}

/**
 * L'UNICO punto che applica l'anno a una query su `sections` (o a qualunque tabella con `scuola_id` e `anno_id`).
 * `anni` = `null` → la query torna com'è (nessun filtro: DB non migrato). Altrimenti
 * `.or('and(scuola_id.eq.X,anno_id.eq.Y),…,scuola_id.eq.Z')`: una clausola per sede con anno, una per sede libera. Una
 * sede che non compare né fra le coppie né fra i liberi (il cookie di staff su un anno che non ha) resta VUOTA.
 * La forma `and(…)` dentro `.or()` è quella di PostgREST (`PostgrestFilterBuilder.or`, e `chat/messages`).
 */
export function filtraPerAnnoDiSede<Q extends { or(filtri: string): Q }>(query: Q, anni: AnniAttivi | null): Q {
  if (!anni || anni.coppie.length === 0) return query
  const clausole = [
    ...anni.coppie.map((c) => `and(scuola_id.eq.${c.sede},anno_id.eq.${c.annoId})`),
    ...anni.liberi.map((s) => `scuola_id.eq.${s}`),
  ]
  return query.or(clausole.join(','))
}
