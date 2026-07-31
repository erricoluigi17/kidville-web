// W4-A — Il CORREDO MINIMO di una sede: che cosa deve esserci perché una sede
// «nasca pronta», e che cosa resta a un umano.
//
// IL DIFETTO CHE QUESTO MODULO CHIUDE (audit 2026-07-31, R123/R124/R68).
// `provisiona_sede` preparava quattro cose — la riga in `schools`, quella in
// `scuole`, `admin_settings` e i legami della Direzione in `utenti_scuole` — e
// si fermava lì. Kidville Aversa e Kidville Cesa, nate il 2026-07-29, si sono
// trovate senza scala dei giudizi, senza titolario dei protocolli e — Cesa, che
// ha cinque classi di primaria — senza una sola disciplina. Nessun errore da
// nessuna parte: la sede SEMBRA pronta, e chi la apre trova elenchi vuoti.
//
// LA DIVISIONE. Ciò che ha un default sensato si crea da solo (qui e nella RPC
// SQL gemella); ciò che va DECISO da una persona — anagrafica, dati fiscali,
// periodi di scrutinio, mensa, sezioni — non si inventa: esce come CHECKLIST
// nella risposta del POST, con lo stato di ciascuna voce e il punto del cockpit
// in cui si compila. Inventare una P.IVA sarebbe peggio del vuoto: una ricevuta
// con l'intestazione sbagliata è un documento falso, una senza intestazione è
// solo un documento incompleto.
//
// ⚠️ GEMELLO SQL: `public.provisiona_corredo_sede`
// (supabase/migrations/20260731170000_provisiona_sede_v2.sql). Questo file è il
// ramo che gira quando la RPC non c'è (DB E2E della CI, non migrato). Le due
// copie devono restare allineate — il lock
// `__tests__/architecture/provisiona-sede-default-gemello.test.ts` le confronta.
// La RPC fa in più una cosa che qui non avrebbe senso: le discipline delle
// sezioni di primaria già esistenti. Una sede appena creata di sezioni non ne
// ha ancora nessuna, quindi quel pezzo serve solo al recupero di una sede
// vecchia, che passa sempre dalla RPC.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { defaultAdminSettingsRow } from '@/lib/scuole/admin-settings-default'

/** Una voce della scala dei giudizi sintetici della primaria. */
export interface VoceGiudizio {
  etichetta: string
  ordine: number
  /** Serve alle MEDIE (`src/lib/primaria/media.ts`): senza, una pagella non fa media. */
  valore_numerico: number
}

/**
 * Scala dei giudizi sintetici con cui nasce una sede.
 *
 * È la scala già in uso a Kidville Giugliano — l'unica sede che ce l'abbia — e
 * corrisponde alla scala ordinaria della scuola primaria. La Direzione può
 * rinominare, aggiungere e disattivare le voci da Impostazioni → Primaria:
 * questo è il punto di partenza, non un vincolo.
 *
 * `etichetta` è la CHIAVE (UNIQUE `(scuola_id, etichetta)`) ed è referenziata
 * PER TESTO da `scrutinio_giudizio_descrittivo.etichetta_voto`: due voci con la
 * stessa etichetta farebbero fallire l'inserimento dell'intero corredo.
 */
export const DEFAULT_GIUDIZI_SCALA: readonly VoceGiudizio[] = [
  { etichetta: 'Ottimo', ordine: 1, valore_numerico: 10 },
  { etichetta: 'Distinto', ordine: 2, valore_numerico: 9 },
  { etichetta: 'Buono', ordine: 3, valore_numerico: 8 },
  { etichetta: 'Discreto', ordine: 4, valore_numerico: 7 },
  { etichetta: 'Sufficiente', ordine: 5, valore_numerico: 6 },
  { etichetta: 'Non sufficiente', ordine: 6, valore_numerico: 4 },
]

/**
 * Titolario di classificazione dei protocolli con cui nasce una sede.
 *
 * Stava dentro `GET /api/admin/protocolli/categorie` come seed «lazy» (alla
 * prima apertura della pagina). Il seed lazy resta — è la rete per le sedi
 * create prima di questo corredo — ma l'elenco vive QUI, in un posto solo:
 * tre copie della stessa lista (SQL, questo file, la route) divergono, e
 * quale sede prende quale copia lo decide il caso.
 */
export const TITOLARIO_DEFAULT: readonly string[] = [
  'Alunni e famiglie',
  'Personale',
  'Amministrazione e contabilità',
  'Enti e istituzioni',
  'Fornitori',
  'Sicurezza e privacy',
  'Varie',
]

// ─── La checklist di attivazione ─────────────────────────────────────────────

export type StatoVoce = 'fatto' | 'da_fare'

export interface VoceChecklist {
  /** Chiave stabile, per il client e per i test. Non è un testo da mostrare. */
  chiave: string
  /** Che cos'è, in italiano. */
  etichetta: string
  /** Dove si compila, nel cockpit. */
  dove: string
  /** `true` se la decisione è di una persona: non si può provisionare da soli. */
  manuale: boolean
  stato: StatoVoce
}

type VoceBase = Omit<VoceChecklist, 'stato'>

/**
 * Le voci della checklist, nell'ordine in cui conviene affrontarle.
 *
 * Le prime tre le crea il provisioning e sono qui solo per dire che sono state
 * fatte (una checklist che elenca solo i buchi non fa capire quanto manca). Le
 * altre richiedono una decisione, e restano `da_fare` per costruzione: se un
 * giorno una di loro avesse un default sensato, la si sposta di sopra — non le
 * si mette una spunta.
 */
export const VOCI_CHECKLIST: readonly VoceBase[] = [
  {
    chiave: 'registro',
    etichetta: 'Registro elettronico: funzioni attive per grado',
    dove: 'Impostazioni → Funzioni per grado',
    manuale: false,
  },
  {
    chiave: 'giudizi',
    etichetta: 'Scala dei giudizi sintetici della primaria',
    dove: 'Impostazioni → Primaria → Giudizi',
    manuale: false,
  },
  {
    chiave: 'titolario',
    etichetta: 'Titolario di classificazione dei protocolli',
    dove: 'Protocolli → Categorie',
    manuale: false,
  },
  {
    chiave: 'sezioni',
    etichetta:
      'Sezioni e classi della sede (per le classi di primaria, applicare anche il preset delle discipline)',
    dove: 'Impostazioni → Sezioni',
    manuale: true,
  },
  {
    chiave: 'anagrafica',
    etichetta: 'Anagrafica della sede: indirizzo, CAP, provincia, PEC, telefono, codice meccanografico',
    dove: 'Impostazioni → Sedi → Anagrafica',
    manuale: true,
  },
  {
    chiave: 'fiscale',
    etichetta:
      'Dati fiscali per ricevute e attestazioni: denominazione, partita IVA, codice fiscale',
    dove: 'Impostazioni → Contabilità → Dati fiscali',
    manuale: true,
  },
  {
    chiave: 'scrutinio_periodi',
    etichetta: 'Periodi di scrutinio della primaria',
    dove: 'Impostazioni → Primaria → Scrutinio',
    manuale: true,
  },
  {
    chiave: 'mensa',
    etichetta: 'Mensa: menu settimanale, gruppi e pacchetti di ticket',
    dove: 'Impostazioni → Mensa',
    manuale: true,
  },
]

/**
 * La checklist con lo stato reale di ciascuna voce.
 *
 * @param fatti chiavi che il provisioning ha DAVVERO creato. Non è un'ipotesi:
 *   sul ramo RPC la funzione è atomica (se ha restituito un id, tutto ciò che
 *   contiene è passato); sul ramo di fallback ogni INSERT riporta il proprio
 *   esito. Una voce che il DB non ha accettato non deve risultare spuntata.
 */
export function checklistSede(fatti: ReadonlySet<string>): VoceChecklist[] {
  return VOCI_CHECKLIST.map((v) => ({
    ...v,
    stato: !v.manuale && fatti.has(v.chiave) ? 'fatto' : 'da_fare',
  }))
}

// ─── Il provisioning, ramo senza RPC ─────────────────────────────────────────

/** Schema non migrato (DB E2E della CI): tabella o colonna assente. PostgREST
 *  non lancia, ritorna `{ error }` — 42P01 relazione, 42703 colonna (SELECT),
 *  PGRST204 colonna (INSERT/UPDATE), PGRST205 tabella fuori dal cache. */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

interface PezzoCorredo {
  /** Chiave della checklist che questo pezzo soddisfa. */
  chiave: string
  tabella: string
  /** Prefisso degli `esito` nei log: `<etichetta>-creato|-non-disponibile|-fallito`. */
  etichetta: string
  righe: (sedeId: string) => Record<string, unknown>[]
}

const CORREDO: readonly PezzoCorredo[] = [
  {
    chiave: 'registro',
    tabella: 'admin_settings',
    etichetta: 'admin-settings',
    righe: (id) => [defaultAdminSettingsRow(id)],
  },
  {
    chiave: 'giudizi',
    tabella: 'giudizi_sintetici_scala',
    etichetta: 'giudizi',
    righe: (id) => DEFAULT_GIUDIZI_SCALA.map((g) => ({ scuola_id: id, ...g })),
  },
  {
    chiave: 'titolario',
    tabella: 'protocolli_categorie',
    etichetta: 'titolario',
    righe: (id) => TITOLARIO_DEFAULT.map((nome, i) => ({ scuola_id: id, nome, ordine: i + 1 })),
  },
]

/** Le tabelle che il corredo riempie, in questo ramo e nella RPC gemella. */
export const TABELLE_CORREDO: readonly string[] = CORREDO.map((p) => p.tabella)

/**
 * Le tabelle che riempie SOLO la RPC, e la ragione.
 *
 * `materie`: le discipline si applicano alle sezioni di primaria già esistenti.
 * Una sede appena creata non ne ha nemmeno una, quindi qui non ci sarebbe nulla
 * da fare; quel pezzo serve al RECUPERO di una sede vecchia, che passa sempre
 * dalla RPC. Il lock `provisiona-sede-default-gemello` usa questo elenco per
 * distinguere «differenza voluta» da «pezzo dimenticato in un ramo».
 */
export const TABELLE_CORREDO_SOLO_SQL: readonly string[] = ['materie']

/**
 * Crea il corredo minimo della sede quando la RPC non è disponibile.
 *
 * Ritorna le chiavi di checklist effettivamente soddisfatte: è quello che
 * finisce nella risposta del POST, e non è mai un'affermazione a scatola chiusa
 * — un pezzo che il database non ha accettato NON entra nell'insieme.
 *
 * Non risponde mai con un errore al chiamante, e la ragione è precisa: quando
 * si arriva qui la sede esiste già in `schools` e in `scuole`. Un 500 inviterebbe
 * a un retry, e il retry creerebbe una SECONDA sede. Il guasto si grida nel log
 * (configurazione mancante = `error`, AGENTS.md §4) e la checklist della
 * risposta dice quale pezzo manca.
 *
 * Un buco non ferma gli altri: se il titolario non passa, la scala dei giudizi
 * deve comunque nascere.
 */
export async function provisionaCorredoFallback(
  supabase: SupabaseClient,
  sedeId: string,
  operazione: string,
): Promise<Set<string>> {
  const fatti = new Set<string>()

  for (const pezzo of CORREDO) {
    const righe = pezzo.righe(sedeId)
    // Una riga sola si passa come oggetto, più righe come array: PostgREST
    // accetta entrambe le forme, e l'oggetto è quella già in uso nel progetto.
    const payload = righe.length === 1 ? righe[0] : righe
    const { error } = await supabase.from(pezzo.tabella).insert(payload)

    if (!error) {
      fatti.add(pezzo.chiave)
      // Provisioning = evento critico: si logga anche il SUCCESSO, altrimenti
      // «nessun log» non distingue «tutto creato» da «non è mai partito niente».
      logEvento('multi_sede', 'info', {
        operazione,
        esito: `${pezzo.etichetta}-creato`,
        sede_id: sedeId,
        righe: righe.length,
      })
      continue
    }

    if (SCHEMA_ASSENTE.has(error.code ?? '')) {
      // DB E2E non migrato: lì nessuno apre il registro. È ignorabile — ma va
      // detto, non taciuto (AGENTS.md §6: un catch che non logga è un bug).
      logEvento(
        'multi_sede',
        'info',
        { operazione, esito: `${pezzo.etichetta}-non-disponibile`, sede_id: sedeId },
        error,
      )
      continue
    }

    logEvento(
      'multi_sede',
      'error',
      { operazione, esito: `${pezzo.etichetta}-fallito`, sede_id: sedeId },
      error,
    )
  }

  return fatti
}

/**
 * Che cosa del corredo esiste DAVVERO per questa sede, riletto dal database.
 *
 * Perché non ci si fida di ciò che si è appena scritto. Sul ramo RPC il
 * chiamante conosce solo l'uuid restituito: quali pezzi contenga quella
 * funzione lo decide la VERSIONE deployata, non il codice che la invoca. Fra il
 * deploy dell'applicazione e l'applicazione della migrazione c'è una finestra
 * in cui la RPC è ancora quella vecchia — e una checklist che spunta «scala dei
 * giudizi: fatto» perché «di solito la RPC la crea» è esattamente il genere di
 * affermazione non verificata che questo audit è nato per togliere di mezzo.
 *
 * Costa tre conteggi (`head: true`, nessuna riga trasferita) su un'operazione
 * che capita qualche volta all'anno.
 */
export async function verificaCorredoSede(
  supabase: SupabaseClient,
  sedeId: string,
  operazione: string,
): Promise<Set<string>> {
  const fatti = new Set<string>()

  for (const pezzo of CORREDO) {
    const { count, error } = await supabase
      .from(pezzo.tabella)
      .select('scuola_id', { count: 'exact', head: true })
      .eq('scuola_id', sedeId)
    if (error) {
      // Non si può dire se ci sia: allora non si spunta. Il livello è `info`
      // perché sul DB E2E la tabella può legittimamente non esistere, ma la
      // riga c'è comunque — un ramo che non si vede è un ramo che non si corregge.
      logEvento(
        'multi_sede',
        'info',
        { operazione, esito: `${pezzo.etichetta}-non-verificabile`, sede_id: sedeId },
        error,
      )
      continue
    }
    if ((count ?? 0) > 0) fatti.add(pezzo.chiave)
  }

  return fatti
}
