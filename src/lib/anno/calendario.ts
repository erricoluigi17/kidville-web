import type { SupabaseClient } from '@supabase/supabase-js'
import { dataCivile } from '@/i18n/config'
import {
  annoAttivoDelCalendario,
  annoDelGiorno,
  giornoValido,
  type AnnoDelGiorno,
  type Calendario,
  type RigaCalendario,
} from '@/lib/anno-scolastico'
import { logEvento } from '@/lib/logging/logger'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import type { StatoAnno } from '@/lib/anno/tipi'

/**
 * Il calendario dell'anno LATO SERVER: legge `anni_sede` di una sede una volta per richiesta e
 * risponde «che anno è» con il calendario vero (la parte pura sta in `@/lib/anno-scolastico`).
 *
 * Se il database non ha ancora lo schema dell'anno (quello della CI non è migrato) risponde col
 * predefinito: la richiesta non si rompe. Nessuna funzione qui lancia, tranne `annoDi` e
 * `annoDellaFrequenza` quando il `giorno`/`oggi` passato non è una data (errore di programma).
 */

const STATI: ReadonlySet<string> = new Set<StatoAnno>([
  'in_preparazione',
  'iscrizioni_aperte',
  'corrente',
  'in_chiusura',
  'chiuso',
])

// La cache vive quanto il client Supabase, cioè quanto la richiesta: `createAdminClient()`
// restituisce un client NUOVO a ogni chiamata. Si tiene la Promise (non il valore) così due
// chiamate in parallelo sulla stessa sede fanno una lettura sola.
// ⚠️ Se quel client diventasse un singleton, la cache diventerebbe per PROCESSO: sbagliato,
// perché le date di una sede cambiano e il processo non se ne accorgerebbe mai.
const CACHE = new WeakMap<SupabaseClient, Map<string, Promise<Calendario | null>>>()
// «Giorno fuori dal calendario» si segnala UNA volta per sede e per giorno (di Roma) NEL PROCESSO,
// non a ogni richiesta: sede -> ultimo giorno segnalato. Un buco nel calendario è un guasto da
// sapere, non da leggere cento volte al minuto. Un processo nuovo ricomincia (è voluto).
const FUORI_SEGNALATI = new Map<string, string>()

/** Solo per i test: ricomincia da zero le segnalazioni «fuori dal calendario». */
export function azzeraSegnalazioniFuoriCalendario(): void {
  FUORI_SEGNALATI.clear()
}
// Com'è andata la lettura di una sede, accanto alla cache e senza una lettura in più: distingue
// «lo schema dell'anno non c'è» (si degrada) da «il database ha risposto male» (la route dà 500).
export type StatoCalendario = 'ok' | 'non_disponibile' | 'guasto'
const ESITI = new WeakMap<SupabaseClient, Map<string, StatoCalendario>>()

function annotaEsito(supabase: SupabaseClient, scuolaId: string, stato: StatoCalendario): void {
  let m = ESITI.get(supabase)
  if (!m) {
    m = new Map()
    ESITI.set(supabase, m)
  }
  m.set(scuolaId, stato)
}

// Un errore con la sede. `logErrore` non ha un posto per `scuola_id` (accetta solo operazione,
// ms, stato, evento) e lo scarterebbe in silenzio: `logEvento` livello error lo porta nella riga.
function erroreDiSede(operazione: string, tipo: string, scuolaId: string, err: unknown): void {
  logEvento('anno-scolastico', 'error', { tipo, operazione, scuola_id: scuolaId }, err)
}

type RigaDb = {
  id?: unknown
  anno_id?: unknown
  inizio?: unknown
  fine?: unknown
  ultimo_giorno_aperto?: unknown
  prepara_successivo_dal?: unknown
  stato?: unknown
  domande_aperte?: unknown
}

const data = (v: unknown): v is string => typeof v === 'string' && giornoValido(v)

function inRigaCalendario(r: RigaDb, annoInizio: unknown): RigaCalendario | null {
  if (
    typeof r.id !== 'string' ||
    typeof r.anno_id !== 'string' ||
    !data(r.inizio) ||
    !data(r.fine) ||
    !data(r.ultimo_giorno_aperto) ||
    !data(r.prepara_successivo_dal) ||
    typeof r.stato !== 'string' ||
    !STATI.has(r.stato) ||
    typeof annoInizio !== 'number' ||
    !Number.isInteger(annoInizio)
  ) {
    return null
  }
  return {
    annoId: r.anno_id,
    annoSedeId: r.id,
    annoInizio,
    inizio: r.inizio,
    fine: r.fine,
    ultimoGiornoAperto: r.ultimo_giorno_aperto,
    preparaSuccessivoDal: r.prepara_successivo_dal,
    stato: r.stato as StatoAnno,
    domandeAperte: r.domande_aperte === true,
  }
}

/** Esito di una lettura: lo schema indietro e il guasto sono due cose diverse. */
function esitoLettura(supabase: SupabaseClient, scuolaId: string, tabella: string, error: { code?: string }): void {
  if (schemaAnnoIndietro(error)) {
    annotaEsito(supabase, scuolaId, 'non_disponibile')
    logEvento('anno-scolastico', 'info', { tipo: 'calendario-non-disponibile', scuola_id: scuolaId })
  } else {
    annotaEsito(supabase, scuolaId, 'guasto')
    // solo il SQLSTATE: il messaggio non serve e non deve portare dati
    erroreDiSede(
      'anno/calendario:caricaCalendario',
      'calendario-non-letto',
      scuolaId,
      new Error(`${tabella}:${error.code ?? 'senza-codice'}`),
    )
  }
}

// Due letture SEMPLICI e non un embed di `anni_scolastici` dentro la select: nel database non migrato della
// CI un embed risponde `PGRST200`, che `schemaAnnoIndietro` non copre e che sarebbe un falso guasto.
// Una tabella assente invece risponde `PGRST205`, coperto.
async function leggi(supabase: SupabaseClient, scuolaId: string): Promise<Calendario | null> {
  try {
    const { data: righe, error } = await supabase
      .from('anni_sede')
      .select('id, anno_id, inizio, fine, ultimo_giorno_aperto, prepara_successivo_dal, stato, domande_aperte')
      .eq('scuola_id', scuolaId)
      .order('inizio', { ascending: true })
    if (error) {
      esitoLettura(supabase, scuolaId, 'anni_sede', error)
      return null
    }
    const grezze = Array.isArray(righe) ? (righe as RigaDb[]) : []
    const ids = [...new Set(grezze.map((g) => g.anno_id).filter((v): v is string => typeof v === 'string'))]
    const annoInizioDi = new Map<string, unknown>()
    if (ids.length > 0) {
      const { data: anni, error: erroreAnni } = await supabase
        .from('anni_scolastici')
        .select('id, anno_inizio')
        .in('id', ids)
      if (erroreAnni) {
        esitoLettura(supabase, scuolaId, 'anni_scolastici', erroreAnni)
        return null
      }
      for (const a of Array.isArray(anni) ? (anni as Array<{ id?: unknown; anno_inizio?: unknown }>) : []) {
        if (typeof a.id === 'string') annoInizioDi.set(a.id, a.anno_inizio)
      }
    }
    const buone: RigaCalendario[] = []
    let scartate = 0
    for (const g of grezze) {
      const r = inRigaCalendario(g, typeof g.anno_id === 'string' ? annoInizioDi.get(g.anno_id) : undefined)
      if (r) buone.push(r)
      else scartate++
    }
    if (scartate > 0) {
      logEvento('anno-scolastico', 'warn', { tipo: 'calendario-riga-scartata', scuola_id: scuolaId, scartate })
    }
    annotaEsito(supabase, scuolaId, 'ok')
    return buone
  } catch (err) {
    annotaEsito(supabase, scuolaId, 'guasto')
    erroreDiSede('anno/calendario:caricaCalendario', 'calendario-non-letto', scuolaId, err)
    return null
  }
}

/** Il calendario di una sede, una lettura per richiesta. `null` = non disponibile (si usa il predefinito). NON LANCIA. */
export function caricaCalendario(supabase: SupabaseClient, scuolaId: string): Promise<Calendario | null> {
  let perSede = CACHE.get(supabase)
  if (!perSede) {
    perSede = new Map()
    CACHE.set(supabase, perSede)
  }
  let p = perSede.get(scuolaId)
  if (!p) {
    p = leggi(supabase, scuolaId)
    perSede.set(scuolaId, p)
  }
  return p
}

/**
 * Com'è andata la lettura del calendario di una sede, dalla STESSA cache di `caricaCalendario`
 * (nessuna lettura in più). Non lancia. Il guasto è già registrato da `caricaCalendario`.
 */
export async function statoCalendario(supabase: SupabaseClient, scuolaId: string): Promise<StatoCalendario> {
  const cal = await caricaCalendario(supabase, scuolaId)
  const s = ESITI.get(supabase)?.get(scuolaId)
  if (s) return s
  return cal ? 'ok' : 'guasto'
}

/** L'anno di un giorno civile per una sede. Un `giorno` non valido lancia (errore di programma). */
export async function annoDi(supabase: SupabaseClient, scuolaId: string, giorno: string): Promise<AnnoDelGiorno> {
  const cal = await caricaCalendario(supabase, scuolaId)
  const anno = annoDelGiorno(giorno, cal)
  if (cal && cal.length > 0 && anno.fonte === 'predefinito') {
    // Il database impedisce i buchi: se succede, il predefinito risponde ma qualcuno deve saperlo.
    const oggi = dataCivile()
    if (FUORI_SEGNALATI.get(scuolaId) !== oggi) {
      FUORI_SEGNALATI.set(scuolaId, oggi)
      logEvento('anno-scolastico', 'warn', { tipo: 'anno-fuori-calendario', scuola_id: scuolaId, giorno })
    }
  }
  return anno
}

/** Gli anni che docenti e famiglie «non vedono» (specifica §4.4.1): ancora in costruzione. */
export const STATI_RISERVATI: ReadonlySet<string> = new Set<StatoAnno>(['in_preparazione', 'iscrizioni_aperte'])

/** L'uuid dell'anno ATTIVO di una sede (`anni_scolastici.id`), o `null` se non ce n'è. */
export function annoAttivoIdDi(calendario: Calendario | null | undefined): string | null {
  return annoAttivoDelCalendario(calendario)?.annoId ?? null
}

/**
 * «Che anno è oggi» per CHI chiede (PR 4.8.4, Scelta 5). Lo staff ha l'anno che contiene il giorno.
 * Docenti e famiglie, se quell'anno è ancora riservato (`in_preparazione`/`iscrizioni_aperte`: i
 * giorni fra l'inizio del nuovo anno e il passaggio), hanno l'anno ATTIVO, cioè il vecchio, invece
 * di «nessuno». Dopo la conferma il nuovo è `corrente`, non è più riservato e vale per tutti.
 * Sede senza alcun anno attivo: l'anno che contiene il giorno, come per lo staff (mai un errore).
 * Nessuna scrittura cambia: solo la risposta alla domanda «che anno è». `oggi` è il giorno di Roma.
 */
export async function annoDiOggiPerChi(
  supabase: SupabaseClient,
  scuolaId: string,
  opzioni: { staff: boolean; oggi?: string },
): Promise<AnnoDelGiorno> {
  const oggi = opzioni.oggi ?? dataCivile()
  const cal = await caricaCalendario(supabase, scuolaId)
  const contiene = annoDelGiorno(oggi, cal)
  if (opzioni.staff || !contiene.riga || !STATI_RISERVATI.has(contiene.riga.stato)) return contiene
  const attivo = annoAttivoDelCalendario(cal)
  return attivo ? annoDelGiorno(attivo.inizio, cal) : contiene
}

/**
 * L'anno a cui è iscritto un bambino, per stamparlo su un documento: quello attivo se ha una
 * frequenza viva lì, altrimenti il più vicino fra i successivi (nuova iscrizione per l'anno
 * prossimo), altrimenti l'anno del giorno `oggi`. Mai l'uuid del bambino nei log.
 */
export async function annoDellaFrequenza(
  supabase: SupabaseClient,
  alunnoId: string,
  scuolaId: string,
  oggi: string = dataCivile(),
): Promise<AnnoDelGiorno> {
  const cal = await caricaCalendario(supabase, scuolaId)
  const attivo = annoAttivoDelCalendario(cal)
  if (!cal || !attivo) return annoDi(supabase, scuolaId, oggi)

  let vive: Set<string> | null = null
  try {
    const { data: righe, error } = await supabase
      .from('frequenze')
      .select('anno_sede_id')
      .eq('alunno_id', alunnoId)
      .eq('scuola_id', scuolaId)
      .in('stato', ['in_attesa', 'iscritto'])
    if (error) {
      if (schemaAnnoIndietro(error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'frequenze-non-disponibili', scuola_id: scuolaId })
      } else {
        erroreDiSede(
          'anno/calendario:annoDellaFrequenza',
          'frequenze-non-lette',
          scuolaId,
          new Error(`frequenze:${error.code ?? 'senza-codice'}`),
        )
      }
    } else {
      vive = new Set(
        (Array.isArray(righe) ? righe : [])
          .map((r) => (r as { anno_sede_id?: unknown }).anno_sede_id)
          .filter((v): v is string => typeof v === 'string'),
      )
    }
  } catch (err) {
    erroreDiSede('anno/calendario:annoDellaFrequenza', 'frequenze-non-lette', scuolaId, err)
  }
  if (!vive) return annoDi(supabase, scuolaId, oggi)

  if (vive.has(attivo.annoSedeId)) return annoDelGiorno(attivo.inizio, cal)
  const successivo = cal
    .filter((r) => r.inizio > attivo.inizio && vive.has(r.annoSedeId))
    .sort((a, b) => (a.inizio < b.inizio ? -1 : 1))[0]
  if (successivo) return annoDelGiorno(successivo.inizio, cal)
  return annoDi(supabase, scuolaId, oggi)
}
