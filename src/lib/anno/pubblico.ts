import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { formaConfronto } from '@/lib/auth/scope'
import { anniDellaSede, esitoSchemaIndietro, guastoAnno, type RigaAnnoSede } from '@/lib/anno/lettura'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

// =============================================================================
// L'ANNO PER LE PORTE SENZA UTENTE (il modulo pubblico), Compito 3.2 / decisione P22.
//
// ⚠️ DUE UUID CHE NON SI SCAMBIANO.
//  · `anni_scolastici.id` — l'anno, uguale per tutte le sedi: ciò che restituisce `anno_di`, ciò che
//    `opzioni.annoId` e `AnnoPubblico.annoId` portano, ciò che si scrive in `anno_id`.
//  · `anni_sede.id` — l'anno DI UNA SEDE: ciò che restituisce `anno_attivo` e `AnnoPubblico.annoSedeId`.
// =============================================================================

export type AnnoPubblico =
  | { annoSedeId: string; annoId: string }
  | { annoSedeId: null; annoId: null; schemaIndietro: true }
  | { annoSedeId: null; annoId: null; senzaAnno: true }
  /** La famiglia ha scelto un anno che la sede non offre (non c'è, o ha le domande sospese). Mai un ripiego. */
  | { annoSedeId: null; annoId: null; nonOfferto: true }
  /** Lo schema c'è e nessun anno della sede accetta domande. */
  | { annoSedeId: null; annoId: null; chiuso: true }

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * L'anno per le porte SENZA utente (il modulo pubblico).
 *
 *  · **Senza `opzioni.annoId`** (un cliente vecchio, o la sede ha un anno solo): il `corrente` della sede,
 *    com'è sempre stato. Se gli anni offerti sono più d'uno la famiglia avrebbe dovuto scegliere e non lo ha
 *    fatto: va nel `corrente` con un `warn` `anno-pubblico-non-dichiarato` (§4.20: l'obbligo viene dalla
 *    release dopo).
 *  · **Con `opzioni.annoId` (un `anni_scolastici.id`) e `opzioni.rigido`**: quell'anno, se la sede ce l'ha E
 *    ha `domande_aperte`; altrimenti `nonOfferto` — la scelta di una famiglia non si cambia in silenzio.
 *    Senza `rigido` il ripiego sul `corrente` resta (nessuna porta lo chiede più).
 *  · **Se nessun anno della sede ha `domande_aperte`** (e lo schema c'è): `chiuso`. Il chiamante risponde 409
 *    `ISCRIZIONI_CHIUSE` e non scrive niente.
 *
 * Mai un cookie, mai un ruolo, mai un gettone: la funzione non riceve nemmeno `request`.
 *
 * Il rifiuto lo decide il chiamante, leggendo `nonOfferto` e `chiuso`. Se non c'è un `corrente` (agosto)
 * restituisce `senzaAnno: true` con un `warn` (P18: senza, ad agosto ogni domanda sarebbe archiviata senza anno
 * e nessuno lo vedrebbe); lo stesso se la lettura fallisce (lì il log `error` lo scrive `guastoAnno`). Il
 * chiamante scrive senza `anno_id`: la riserva permanente di `enrollment_submissions` lo assegna.
 */
export async function annoPerScritturaPubblica(
  supabase: SupabaseClient,
  scuolaId: string,
  opzioni: { annoId?: string; rigido?: boolean } = {},
): Promise<AnnoPubblico> {
  const azione = 'annoPerScritturaPubblica'
  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) {
    const e = esitoSchemaIndietro(azione)
    return { annoSedeId: null, annoId: null, schemaIndietro: e.schemaIndietro as true }
  }
  if ('guasto' in anni) {
    guastoAnno(azione, anni.guasto)
    return { annoSedeId: null, annoId: null, senzaAnno: true }
  }
  // la sede solo se è un uuid: passa la redazione
  const sede = FORMA_UUID.test(scuolaId) ? scuolaId : undefined
  const offerti = anni.righe.filter((r) => r.domande_aperte === true)
  // «Chiuso» vuol dire che la sede HA degli anni e nessuno accetta domande. Una sede senza alcuna riga (appena
  // nata, o il riempimento non è ancora passato) non è "chiusa": è senza anno, come sempre, e la domanda si
  // scrive lo stesso (la riserva permanente del database assegna l'anno) con il `warn` qui sotto.
  if (offerti.length === 0 && anni.righe.length > 0) {
    // ⚠️ LA FINESTRA DEL DEPLOY (4.5.15, I4). `domande_aperte` nasce spento su tutte le righe e lo RIEMPIE M45d, la stessa
    // migrazione che crea `listino_voci.scadenza`. Fra il codice nuovo e quella migrazione "nessun anno offerto" non vuol dire
    // "iscrizioni chiuse": vuol dire "il riempimento non è ancora passato", e chiudere il modulo pubblico quel giorno
    // respingerebbe famiglie vere. Una lettura di prova della colonna distingue i due casi: assente → si comporta come
    // `indietro` (come prima di questa PR), errore di altro genere → non si chiude, si avvisa.
    // Questa lettura si toglie con la PR-B (quando M45d è in produzione ovunque e la finestra non esiste più).
    const sonda = await supabase.from('listino_voci').select('scadenza').limit(1)
    if (sonda.error) {
      if (schemaAnnoIndietro(sonda.error)) {
        const e = esitoSchemaIndietro(azione)
        return { annoSedeId: null, annoId: null, schemaIndietro: e.schemaIndietro as true }
      }
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-pubblico-sonda-listino-fallita',
        azione,
        error_code: 'SONDA_LISTINO_FALLITA',
        scuola_id: sede,
      })
      return { annoSedeId: null, annoId: null, schemaIndietro: true }
    }
    // Un `corrente` che non accetta domande è un fatto da vedere (è l'anno in cui le famiglie si iscrivono adesso); un anno
    // chiuso o in preparazione che non le accetta è la vita ordinaria.
    const livello = anni.righe.some((r) => r.stato === 'corrente') ? 'warn' : 'info'
    logEvento('anno-scolastico', livello, {
      tipo: 'anno-pubblico-chiuso',
      azione,
      error_code: 'ISCRIZIONI_CHIUSE',
      scuola_id: sede,
    })
    return { annoSedeId: null, annoId: null, chiuso: true }
  }
  let riga: RigaAnnoSede | undefined
  if (opzioni.annoId) {
    const voluto = formaConfronto(opzioni.annoId)
    riga = offerti.find((r) => formaConfronto(String(r.anno_id)) === voluto)
    if (!riga && opzioni.rigido) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-pubblico-non-offerto',
        azione,
        error_code: 'ANNO_NON_OFFERTO',
        scuola_id: sede,
      })
      return { annoSedeId: null, annoId: null, nonOfferto: true }
    }
  }
  if (!riga) {
    const correnti = anni.righe.filter((r) => r.stato === 'corrente')
    if (correnti.length === 1) riga = correnti[0]
    if (riga && !opzioni.annoId && offerti.length > 1) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anno-pubblico-non-dichiarato', azione, scuola_id: sede })
    }
  }
  if (!riga) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-pubblico-senza-corrente',
      azione,
      error_code: 'ANNO_DA_SPECIFICARE',
      scuola_id: sede,
    })
    return { annoSedeId: null, annoId: null, senzaAnno: true }
  }
  return { annoSedeId: riga.id, annoId: riga.anno_id }
}

/** Un anno che il modulo pubblico offre: SOLO id, etichetta e il tipo di ingresso. Niente date, niente stati. */
export type AnnoOfferto = { anno_id: string; etichetta_breve: string; ingresso: 'durante' | 'inizio' }

export type AnniOfferti = { anni: AnnoOfferto[]; scelta: boolean; chiuso: boolean } | { indietro: true } | { guasto: unknown }

/**
 * Gli anni che accettano domande, per il passo «anno» del modulo pubblico (`GET /api/iscrizione/anni`).
 *
 * `ingresso`: `durante` per il `corrente` (il bambino entra subito), `inizio` per gli altri (entra a inizio anno).
 * L'ordine è quello del tempo. `scelta` è vero solo se gli anni sono almeno due: con uno non c'è niente da scegliere.
 * Il tipo di ritorno non contiene altro che questo: ciò che la funzione non restituisce non può uscire dalla route.
 */
export async function anniOffertiPubblici(supabase: SupabaseClient, scuolaId: string): Promise<AnniOfferti> {
  const azione = 'anniOffertiPubblici'
  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) {
    esitoSchemaIndietro(azione)
    return { indietro: true }
  }
  if ('guasto' in anni) {
    guastoAnno(azione, anni.guasto)
    return { guasto: anni.guasto }
  }
  const offerti = anni.righe.filter((r) => r.domande_aperte === true)
  // Chiuso = la sede ha degli anni e nessuno accetta domande (lo stesso criterio di `annoPerScritturaPubblica`).
  if (offerti.length === 0) return { anni: [], scelta: false, chiuso: anni.righe.length > 0 }

  const { data, error } = await supabase
    .from('anni_scolastici')
    .select('id, anno_inizio, etichetta_breve')
    .in('id', offerti.map((r) => r.anno_id))
  if (error) {
    if (schemaAnnoIndietro(error)) {
      esitoSchemaIndietro(azione)
      return { indietro: true }
    }
    guastoAnno(azione, error)
    return { guasto: error }
  }
  const anagrafica = new Map(
    ((Array.isArray(data) ? data : []) as { id: string; anno_inizio: number; etichetta_breve: string | null }[]).map(
      (a) => [formaConfronto(String(a.id)), a] as const,
    ),
  )
  const elenco: (AnnoOfferto & { inizio: number })[] = []
  for (const r of offerti) {
    const a = anagrafica.get(formaConfronto(String(r.anno_id)))
    if (!a || !a.etichetta_breve) {
      // Un anno aperto di cui non si sa il nome non si può offrire: lo si dice, non si inventa un'etichetta.
      logEvento('anno-scolastico', 'warn', {
        tipo: 'anno-pubblico-senza-etichetta',
        azione,
        entita_id: FORMA_UUID.test(r.anno_id) ? r.anno_id : undefined,
      })
      continue
    }
    elenco.push({
      anno_id: r.anno_id,
      etichetta_breve: a.etichetta_breve,
      ingresso: r.stato === 'corrente' ? 'durante' : 'inizio',
      inizio: a.anno_inizio,
    })
  }
  elenco.sort((x, y) => x.inizio - y.inizio)
  const pulito = elenco.map(({ anno_id, etichetta_breve, ingresso }) => ({ anno_id, etichetta_breve, ingresso }))
  return { anni: pulito, scelta: pulito.length > 1, chiuso: false }
}

/**
 * L'etichetta dell'anno di una domanda, SOLO se non è il `corrente` della sede (per la riga della ricevuta).
 * Best-effort: la domanda è già registrata, e un'etichetta che non si legge è una riga che manca, non un errore.
 * Schema indietro → `null` in silenzio (log `info`); un guasto vero → `null` con un `warn`.
 */
export async function etichettaAnnoSeNonCorrente(
  supabase: SupabaseClient,
  annoSedeId: string,
  annoId: string,
): Promise<string | null> {
  const azione = 'etichettaAnnoSeNonCorrente'
  const sede = await supabase.from('anni_sede').select('stato').eq('id', annoSedeId)
  if (sede.error) {
    if (schemaAnnoIndietro(sede.error)) esitoSchemaIndietro(azione)
    else logEvento('anno-scolastico', 'warn', { tipo: 'anno-pubblico-etichetta-non-letta', azione }, sede.error)
    return null
  }
  const stato = (Array.isArray(sede.data) ? (sede.data as { stato?: string }[])[0]?.stato : undefined) ?? null
  if (stato === 'corrente' || stato === null) return null
  const anno = await supabase.from('anni_scolastici').select('etichetta_breve').eq('id', annoId)
  if (anno.error) {
    if (schemaAnnoIndietro(anno.error)) esitoSchemaIndietro(azione)
    else logEvento('anno-scolastico', 'warn', { tipo: 'anno-pubblico-etichetta-non-letta', azione }, anno.error)
    return null
  }
  const etichetta =
    (Array.isArray(anno.data) ? (anno.data as { etichetta_breve?: string | null }[])[0]?.etichetta_breve : null) ?? null
  return etichetta && etichetta.length > 0 ? etichetta : null
}
