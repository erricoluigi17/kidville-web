import type { SupabaseClient } from '@supabase/supabase-js'
import { formaConfronto } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'
import { CODICI_RPC_CRM_ASSENTE, CODICI_SCHEMA_CRM_ASSENTE, codiceErroreDb } from './errori'
import { nomiSiSomigliano } from './nomi'
import { esitoPassaggioDa, registraEsitoPassaggio, type EsitoPassaggio } from './quota'

/**
 * CRM DELLA SEGRETERIA · L'AGGANCIO DEL BAMBINO ALL'ALUNNO.
 *
 * Quando un bambino del CRM diventa alunno, va COLLEGATO all'alunno: è questo collegamento che fa passare la
 * quota d'iscrizione in contabilità (spec «quota e disponibilità» §5.4). Il collegamento nasce da tre strade,
 * e questo file è la porta di tutte e tre:
 *
 *  · `agganciaDaImport` — l'import notturno ha appena creato gli alunni di una domanda: ogni figlio che ha
 *    un bambino nel CRM (stessa domanda, stesso figlio, stessa sede) si aggancia al SUO alunno;
 *  · `alunnoDaDomandaImportata` — la domanda era già stata importata PRIMA di essere collegata al bambino
 *    (la famiglia compila, l'import gira, e solo dopo la segreteria la collega): l'alunno si ritrova fra
 *    quelli che l'import ha creato per quella domanda;
 *  · `agganciaAlunno` — il collegamento vero e proprio, anche a mano dalla scheda (la route `…/alunno`).
 *
 * ─── LE STESSE REGOLE DI `collegamento.ts` ───────────────────────────────────────────────────────────
 *
 * 1. **NON LANCIANO MAI.** L'import delle domande e il collegamento le chiamano a cose fatte, e un guasto del
 *    CRM non deve far fallire un'iscrizione per cui la password è già stata spedita: ogni guasto è una riga di
 *    log e un esito, mai un'eccezione. Con le tabelle `crm_*` (o la funzione) assenti — il database E2E della
 *    CI non è migrato e non lo sarà — l'esito è `non_installato`.
 *
 * 2. **Dalla domanda non si legge niente.** `enrollment_submissions` contiene dati VERI di minori. Qui si
 *    leggono gli ALUNNI che l'import ha creato (nome e data di nascita servono ad abbinare), mai la domanda.
 *    Nei log passano gli uuid, i conteggi e i codici d'esito, e basta.
 *
 * 3. **Una sede sola.** Ogni lettura porta `scuola_id` nella STESSA istruzione, e le righe tornate si
 *    ricontrollano in codice. La funzione SQL rifiuta comunque un alunno di un'altra sede (`sede_diversa`).
 *
 * ─── DUE INSIEMI DI CODICI «SCHEMA ASSENTE», NON UNO ─────────────────────────────────────────────────
 * Dopo una chiamata `rpc` valgono SOLO i quattro di `CODICI_RPC_CRM_ASSENTE`: su una funzione già installata
 * un `42703` è un errore vero nel suo corpo, e deve restare un `error` nel log. I sei di
 * `CODICI_SCHEMA_CRM_ASSENTE` valgono per la lettura di `crm_bambini`, che seleziona `alunno_id` (una colonna
 * che la migrazione della quota aggiunge): nella finestra fra il deploy e la migrazione manca.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tipi
// ─────────────────────────────────────────────────────────────────────────────

export type EsitoAggancio =
  | { esito: 'ok'; collegato: boolean; passaggio: EsitoPassaggio | null }
  | { esito: 'non_trovato' | 'sede_diversa' | 'gia_collegato_altro' | 'alunno_gia_collegato' | 'non_installato' | 'errore' }

export type EsitoAgganciaDaImport =
  | { esito: 'fatto'; agganciati: number }
  | { esito: 'non_installato' | 'errore' }

const OP_AGGANCIA = 'crm/aggancio-alunno:agganciaAlunno'
const OP_IMPORT = 'crm/aggancio-alunno:agganciaDaImport'
const OP_RICERCA = 'crm/aggancio-alunno:alunnoDaDomandaImportata'

/** Gli esiti con cui la funzione SQL dice «non l'ho collegato» (e perché). */
const ESITI_RIFIUTATI = ['non_trovato', 'sede_diversa', 'gia_collegato_altro', 'alunno_gia_collegato'] as const

const sedeUguale = (a: unknown, b: string): boolean => typeof a === 'string' && formaConfronto(a) === formaConfronto(b)

// ─────────────────────────────────────────────────────────────────────────────
// agganciaAlunno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dall'errore (oggetto PostgREST o eccezione) all'esito, con la riga di log che gli spetta:
 *  · `23505` — la UNIQUE sull'alunno (`crm_bambini_alunno_unico`): l'import e un collegamento a mano sono
 *    arrivati insieme sullo stesso alunno. Di norma la funzione lo traduce da sé nell'esito
 *    `alunno_gia_collegato`; se esce come errore vale lo stesso, ed è una risposta normale, non un guasto;
 *  · funzione o tabella assente → `non_installato` (warn);
 *  · il resto → `errore` (error).
 */
function esitoDaErrore(err: unknown, bambinoId: string): EsitoAggancio {
  const codice = codiceErroreDb(err)
  if (codice === '23505') {
    logEvento('crm', 'warn', { operazione: OP_AGGANCIA, esito: 'aggancio-rifiutato:alunno_gia_collegato', entita_id: bambinoId }, err)
    return { esito: 'alunno_gia_collegato' }
  }
  if (CODICI_RPC_CRM_ASSENTE.has(codice)) {
    logEvento('crm', 'warn', { operazione: OP_AGGANCIA, esito: 'schema-crm-assente', entita_id: bambinoId }, err)
    return { esito: 'non_installato' }
  }
  logEvento('crm', 'error', { operazione: OP_AGGANCIA, esito: 'errore', entita_id: bambinoId }, err)
  return { esito: 'errore' }
}

/**
 * Chiama `crm_aggancia_alunno`: il bambino si collega all'alunno (uno solo per bambino, e un alunno a un solo
 * bambino) e, se la quota era in attesa o bloccata, passa in contabilità nella stessa transazione.
 *
 * `eseguitoDa` è chi ha premuto «collega» (o ha collegato la domanda); `null` quando lo fa il sistema (l'import,
 * il collegamento automatico), e allora lo storico scrive «sistema». **NON LANCIA MAI.**
 *
 * L'aggancio è un evento critico e logga anche il SUCCESSO: una riga per esito, con l'id del bambino e quello
 * dell'alunno. Il passaggio della quota ha la sua riga (`registraEsitoPassaggio`).
 */
export async function agganciaAlunno(
  supabase: SupabaseClient,
  bambinoId: string,
  alunnoId: string,
  eseguitoDa: string | null,
): Promise<EsitoAggancio> {
  try {
    const { data, error } = await supabase.rpc('crm_aggancia_alunno', {
      p_bambino_id: bambinoId,
      p_alunno_id: alunnoId,
      p_eseguito_da: eseguitoDa,
    })
    if (error) return esitoDaErrore(error, bambinoId)
    return leggiEsito(data, bambinoId, alunnoId, eseguitoDa)
  } catch (err) {
    return esitoDaErrore(err, bambinoId)
  }
}

/** Dal jsonb della funzione al tipo. Una forma imprevista non diventa mai un successo né un'eccezione. */
function leggiEsito(json: unknown, bambinoId: string, alunnoId: string, eseguitoDa: string | null): EsitoAggancio {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    logEvento('crm', 'error', { operazione: OP_AGGANCIA, esito: 'aggancio-risposta-illeggibile', entita_id: bambinoId })
    return { esito: 'errore' }
  }
  const j = json as Record<string, unknown>

  if (j.esito === 'ok') {
    const collegato = j.collegato === true
    const passaggio = j.passaggio == null ? null : esitoPassaggioDa(j.passaggio)
    logEvento('crm', 'info', {
      operazione: OP_AGGANCIA,
      esito: collegato ? 'alunno-collegato' : 'alunno-gia-collegato',
      entita_id: bambinoId,
      alunno_id: alunnoId,
      via: eseguitoDa ? 'segreteria' : 'sistema',
    })
    if (passaggio) registraEsitoPassaggio(passaggio, bambinoId, OP_AGGANCIA)
    return { esito: 'ok', collegato, passaggio }
  }

  const rifiutato = ESITI_RIFIUTATI.find((e) => e === j.esito)
  if (rifiutato) {
    // Il motivo sta DENTRO `esito` (il logger redige ogni chiave che contiene «motivo»). Non è un guasto: è
    // un dato da guardare (un alunno di un'altra sede, un bambino già collegato a un altro alunno).
    logEvento('crm', 'warn', { operazione: OP_AGGANCIA, esito: `aggancio-rifiutato:${rifiutato}`, entita_id: bambinoId })
    return { esito: rifiutato }
  }

  logEvento('crm', 'error', { operazione: OP_AGGANCIA, esito: 'aggancio-risposta-illeggibile', entita_id: bambinoId })
  return { esito: 'errore' }
}

// ─────────────────────────────────────────────────────────────────────────────
// agganciaDaImport
// ─────────────────────────────────────────────────────────────────────────────

type BambinoDellaDomanda = { id: string; scuola_id: string; domanda_figlio: number | null; alunno_id: string | null }

/**
 * Dall'import: per ogni figlio della domanda, il bambino del CRM con (domanda_id, domanda_figlio) e quella
 * sede si aggancia all'alunno che l'import ha creato (o ritrovato) per quel figlio. `figlio` è la posizione
 * in `data.children` — lo stesso numero che il CRM salva in `crm_bambini.domanda_figlio`.
 *
 * I bambini che hanno già un alunno si saltano (un rilancio dell'import non rifà niente). Quasi tutte le
 * domande non hanno nessun bambino nel CRM: è la norma, e vale `fatto` con zero agganciati.
 *
 * **NON LANCIA MAI.** Se la funzione manca si ferma al primo tentativo (inutile insistere); un errore su un
 * bambino non impedisce di provare gli altri, ma l'esito complessivo è `errore`.
 */
export async function agganciaDaImport(
  supabase: SupabaseClient,
  d: { domandaId: string; scuolaId: string; figli: { figlio: number; alunnoId: string }[] },
): Promise<EsitoAgganciaDaImport> {
  try {
    let bambini: BambinoDellaDomanda[] = []
    if (d.figli.length > 0) {
      const { data, error } = await supabase
        .from('crm_bambini')
        .select('id, scuola_id, domanda_figlio, alunno_id')
        .eq('domanda_id', d.domandaId)
        .eq('scuola_id', d.scuolaId)
      if (error) {
        if (CODICI_SCHEMA_CRM_ASSENTE.has(codiceErroreDb(error))) {
          logEvento('crm', 'warn', { operazione: OP_IMPORT, esito: 'schema-crm-assente', entita_id: d.domandaId }, error)
          return { esito: 'non_installato' }
        }
        logEvento('crm', 'error', { operazione: OP_IMPORT, esito: 'errore', entita_id: d.domandaId }, error)
        return { esito: 'errore' }
      }
      // Doppio controllo in codice: una riga di un'altra sede non si aggancia mai.
      bambini = ((data ?? []) as BambinoDellaDomanda[]).filter((b) => sedeUguale(b.scuola_id, d.scuolaId))
    }

    let agganciati = 0
    let falliti = 0
    for (const b of bambini) {
      if (b.alunno_id != null) continue
      const alunno = d.figli.find((f) => f.figlio === b.domanda_figlio)
      if (!alunno) continue
      const esito = await agganciaAlunno(supabase, b.id, alunno.alunnoId, null)
      if (esito.esito === 'non_installato') return { esito: 'non_installato' }
      if (esito.esito === 'errore') falliti += 1
      if (esito.esito === 'ok' && esito.collegato) agganciati += 1
    }
    if (falliti > 0) return { esito: 'errore' }

    // Il battito dell'import: una riga per domanda, anche con zero agganciati. «Nessun log» non distingue
    // «nessuna famiglia era in scheda» da «l'aggancio non gira più».
    logEvento('crm', 'info', { esito: 'aggancio-import', entita_id: d.domandaId, n: agganciati })
    return { esito: 'fatto', agganciati }
  } catch (err) {
    if (CODICI_SCHEMA_CRM_ASSENTE.has(codiceErroreDb(err))) {
      logEvento('crm', 'warn', { operazione: OP_IMPORT, esito: 'schema-crm-assente', entita_id: d.domandaId }, err)
      return { esito: 'non_installato' }
    }
    logEvento('crm', 'error', { operazione: OP_IMPORT, esito: 'errore', entita_id: d.domandaId }, err)
    return { esito: 'errore' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// alunnoDaDomandaImportata
// ─────────────────────────────────────────────────────────────────────────────

type AlunnoCreato = { id: string; scuola_id: string; nome: string | null; data_nascita: string | null }

/** `yyyy-mm-dd` di una data di nascita com'esce da una colonna `date` (anche se arrivasse con l'ora in coda). */
function giorno(v: unknown): string | null {
  return typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null
}

/**
 * Domanda già importata: l'unico alunno fra quelli che l'import ha CREATO per quella domanda
 * (`iscrizioni_import_esiti.alunni_creati`), della stessa sede, con la stessa data di nascita (se il bambino
 * del CRM ce l'ha) e almeno una parola di tre lettere del nome in comune. Senza data di nascita nel CRM serve
 * il nome. `null` se nessuno, o se sono più d'uno: due gemelli con lo stesso nome e la stessa nascita non si
 * distinguono, e allora la scelta resta alla segreteria («Collega all'alunno», a mano).
 *
 * Si leggono gli ALUNNI, non la domanda (regola 2 della testata). **NON LANCIA MAI**: ogni guasto è una riga
 * di log e `null`.
 */
export async function alunnoDaDomandaImportata(
  supabase: SupabaseClient,
  b: { domandaId: string; scuolaId: string; nome: string | null; dataNascita: string | null },
): Promise<string | null> {
  try {
    const { data: esito, error: errEsito } = await supabase
      .from('iscrizioni_import_esiti')
      .select('submission_id, scuola_id, alunni_creati')
      .eq('submission_id', b.domandaId)
      .eq('scuola_id', b.scuolaId)
      .maybeSingle()
    if (errEsito) throw errEsito

    const creati =
      esito && sedeUguale((esito as { scuola_id?: unknown }).scuola_id, b.scuolaId) && Array.isArray((esito as { alunni_creati?: unknown }).alunni_creati)
        ? ((esito as { alunni_creati: unknown[] }).alunni_creati.filter((id) => typeof id === 'string' && id !== '') as string[])
        : []
    if (creati.length === 0) {
      logEvento('crm', 'info', { operazione: OP_RICERCA, esito: 'domanda-non-importata', entita_id: b.domandaId })
      return null
    }

    const { data, error } = await supabase
      .from('alunni')
      .select('id, scuola_id, nome, data_nascita')
      .in('id', creati)
      .eq('scuola_id', b.scuolaId)
    if (error) throw error

    const nascita = giorno(b.dataNascita)
    const candidati = ((data ?? []) as AlunnoCreato[]).filter(
      (a) =>
        sedeUguale(a.scuola_id, b.scuolaId) &&
        (nascita === null || giorno(a.data_nascita) === nascita) &&
        nomiSiSomigliano(b.nome, a.nome),
    )

    const [unico] = candidati
    logEvento('crm', 'info', {
      operazione: OP_RICERCA,
      esito: candidati.length === 1 ? 'alunno-importato-trovato' : candidati.length === 0 ? 'alunno-importato-non-trovato' : 'alunno-importato-ambiguo',
      entita_id: b.domandaId,
      n: candidati.length,
    })
    return candidati.length === 1 ? unico.id : null
  } catch (err) {
    if (CODICI_SCHEMA_CRM_ASSENTE.has(codiceErroreDb(err))) {
      logEvento('crm', 'warn', { operazione: OP_RICERCA, esito: 'schema-crm-assente', entita_id: b.domandaId }, err)
    } else {
      logEvento('crm', 'error', { operazione: OP_RICERCA, esito: 'lettura-non-riuscita', entita_id: b.domandaId }, err)
    }
    return null
  }
}
