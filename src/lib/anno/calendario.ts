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
// «Giorno fuori dal calendario» si segnala una volta per sede e per client, come la lettura.
const FUORI_SEGNALATI = new WeakMap<SupabaseClient, Set<string>>()

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
  anni_scolastici?: unknown
}

const data = (v: unknown): v is string => typeof v === 'string' && giornoValido(v)

/** PostgREST può restituire il join come oggetto o come array di un elemento. */
function annoInizioDelJoin(join: unknown): unknown {
  const j = Array.isArray(join) ? join[0] : join
  return j && typeof j === 'object' ? (j as { anno_inizio?: unknown }).anno_inizio : undefined
}

function inRigaCalendario(r: RigaDb): RigaCalendario | null {
  const annoInizio = annoInizioDelJoin(r.anni_scolastici)
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

async function leggi(supabase: SupabaseClient, scuolaId: string): Promise<Calendario | null> {
  try {
    const { data: righe, error } = await supabase
      .from('anni_sede')
      .select(
        'id, anno_id, inizio, fine, ultimo_giorno_aperto, prepara_successivo_dal, stato, domande_aperte, anni_scolastici(anno_inizio)',
      )
      .eq('scuola_id', scuolaId)
      .order('inizio', { ascending: true })
    if (error) {
      if (schemaAnnoIndietro(error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'calendario-non-disponibile', scuola_id: scuolaId })
      } else {
        // solo il SQLSTATE: il messaggio non serve e non deve portare dati
        erroreDiSede(
          'anno/calendario:caricaCalendario',
          'calendario-non-letto',
          scuolaId,
          new Error(`anni_sede:${error.code ?? 'senza-codice'}`),
        )
      }
      return null
    }
    const grezze = Array.isArray(righe) ? (righe as RigaDb[]) : []
    const buone: RigaCalendario[] = []
    let scartate = 0
    for (const g of grezze) {
      const r = inRigaCalendario(g)
      if (r) buone.push(r)
      else scartate++
    }
    if (scartate > 0) {
      logEvento('anno-scolastico', 'warn', { tipo: 'calendario-riga-scartata', scuola_id: scuolaId, scartate })
    }
    return buone
  } catch (err) {
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

/** L'anno di un giorno civile per una sede. Un `giorno` non valido lancia (errore di programma). */
export async function annoDi(supabase: SupabaseClient, scuolaId: string, giorno: string): Promise<AnnoDelGiorno> {
  const cal = await caricaCalendario(supabase, scuolaId)
  const anno = annoDelGiorno(giorno, cal)
  if (cal && cal.length > 0 && anno.fonte === 'predefinito') {
    // Il database impedisce i buchi: se succede, il predefinito risponde ma qualcuno deve saperlo.
    let visti = FUORI_SEGNALATI.get(supabase)
    if (!visti) {
      visti = new Set()
      FUORI_SEGNALATI.set(supabase, visti)
    }
    if (!visti.has(scuolaId)) {
      visti.add(scuolaId)
      logEvento('anno-scolastico', 'warn', { tipo: 'anno-fuori-calendario', scuola_id: scuolaId, giorno })
    }
  }
  return anno
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
