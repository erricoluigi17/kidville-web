import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { spostaNelCestino, type EsitoCestino } from '@/lib/storage/cestino-file'
import { BUCKET_DOCUMENTI_PERSONALE } from './caricamenti'
import { percorsiDelDocumento, type ConDocumento } from './documento-righe'

/**
 * CANCELLARE IL FASCICOLO DI UN MEMBRO DEL PERSONALE — nell'ordine
 * **lettura dei percorsi → righe (in una transazione) → file nel cestino**.
 *
 * ─── DA DOVE NASCE ────────────────────────────────────────────────────────────
 *
 * Il modulo pubblico `/anagrafica-personale` è anonimo per scelta del titolare
 * (`20260811205643_anagrafica_personale.sql`, righe 35-43): chiunque abbia il
 * link può dichiararsi insegnante. Se la segreteria approva, `ensureStaffIdentity`
 * crea l'account E la scheda `anagrafica_personale` con codice fiscale,
 * residenza, estremi del documento e due SCANSIONI della carta d'identità. Su
 * una persona che non è un dipendente, quei dati non hanno base giuridica.
 *
 * ─── PERCHÉ I FILE PER ULTIMI, E NEL CESTINO ──────────────────────────────────
 *
 * Fino alla sessione 10 della seconda serie di robustezza i file uscivano per
 * PRIMI: la DELETE della pratica cascata su `caricamenti_personale`, l'unica riga
 * che li nomina, e con le righe cancellate prima un file rimasto nel bucket non
 * l'avrebbe più nominato nessuno. Ma l'ordine aveva il difetto opposto: se dopo i
 * file falliva un passo (la RPC, o l'account rifiutato da una chiave senza
 * cascata) il dipendente restava, archiviato, senza i suoi documenti.
 *
 * Ora i percorsi si LEGGONO per primi e restano in memoria; poi le righe, in una
 * transazione; poi i file si SPOSTANO in `cestino/<giorno>/` dello stesso bucket,
 * da cui li toglie il giro notturno `cestino-registro-retention`. Un guasto sulle
 * righe non ha toccato un file; uno spostamento che non riesce ripiega sulla
 * cancellazione di prima; un file che non si riesce né a spostare né a cancellare
 * si grida (`file-orfani-fuori-cestino`, in `cestino-file.ts`).
 *
 * ─── PERCHÉ UNA RPC PER LE RIGHE ──────────────────────────────────────────────
 *
 * PostgREST non rende atomiche due `.delete()`, e i due esiti parziali non si
 * somigliano: cancellata la sola anagrafica resta una pratica `approvata` e
 * slegata, che `retention-personale` non tocca MAI. Per l'eliminazione del
 * dipendente la transazione comprende anche il profilo (`personale_elimina_
 * dipendente`): una chiave senza cascata risponde 23503 e annulla tutto.
 *
 * ─── IDEMPOTENTE ──────────────────────────────────────────────────────────────
 *
 * Al secondo giro non c'è più il fascicolo: zero righe, zero file, e lo si dice.
 */

export type FascicoloLetto =
  | { ok: true; trovato: boolean; praticaId: string | null; percorsi: string[] }
  | { ok: false }

type RigaFascicolo = {
  utente_id: string
  origine_pratica_id?: string | null
  documento_fronte_path?: string | null
  documento_retro_path?: string | null
}

type Conteggi = {
  pratiche_cancellate?: number
  anagrafiche_cancellate?: number
  profili_cancellati?: number
  percorsi_staccati?: unknown
}

/**
 * I percorsi delle righe di `caricamenti_personale` che `personale_elimina_dipendente` ha
 * STACCATO invece di lasciarle cancellare in cascata: la route li sposta nel cestino insieme a
 * quelli letti prima. Solo stringhe non vuote; un campo assente (la funzione di prima, che non
 * stacca) è un elenco vuoto.
 */
function percorsiStaccatiDa(c: Conteggi): string[] {
  if (!Array.isArray(c.percorsi_staccati)) return []
  return c.percorsi_staccati.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
}

/**
 * `personale_elimina_dipendente` NON C'È ANCORA in questo database — i soli due codici con cui
 * succede: `PGRST202` (PostgREST non la trova nella schema cache: è il DB E2E della CI, che non è
 * migrato) e `42883` (Postgres: «undefined function»). Solo su QUESTA chiamata si ripiega sulla
 * funzione di prima, e lo si dice a livello `info` (specifica della seconda serie, §5; modello:
 * `RPC_ASSENTE` in `src/app/api/avvisi/[id]/risposte/route.ts`). Un insieme locale e non un
 * modulo comune, di proposito: nessun'altra chiamata deve poter ripiegare per contagio.
 *
 * Mai per gli altri codici: `42P01`/`42703` vogliono dire che la funzione c'è ma legge qualcosa
 * che manca (schema a metà, un guasto); `23503` (una chiave senza cascata) e `57014` (tempo
 * scaduto) sono risposte vere, e ripiegare su quelle rifarebbe a pezzi ciò che la funzione ha
 * appena rifiutato di fare tutto insieme. Si guarda il CODICE, mai il messaggio.
 */
const PERSONALE_ELIMINA_ASSENTE = new Set(['PGRST202', '42883'])

/**
 * Un codice che viene dal database (SQLSTATE: cinque caratteri, cifre e maiuscole) o da
 * PostgREST (`PGRST…`). Con uno di questi la risposta è arrivata, e dice com'è andata: un
 * errore di Postgres annulla la transazione. Senza (postgrest-js consegna `code: ''` quando il
 * fetch cade o scade, `src/lib/logging/supabase-fetch.ts`) l'esito NON si conosce.
 */
function codiceDalDatabase(errore: unknown): boolean {
  const codice = (errore as { code?: unknown } | null | undefined)?.code
  return typeof codice === 'string' && (/^[0-9A-Z]{5}$/.test(codice) || codice.startsWith('PGRST'))
}

/** Il fascicolo, la pratica d'origine e i percorsi delle scansioni. Non scrive niente. */
export async function leggiFascicoloPersonale(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<FascicoloLetto> {
  const { data: anagrafica, error: errAnagrafica } = await supabase
    .from('anagrafica_personale')
    .select('utente_id, origine_pratica_id, documento_fronte_path, documento_retro_path')
    .eq('utente_id', utenteId)
    .maybeSingle()
  if (errAnagrafica) {
    logErrore({ operazione: op, evento: 'fascicolo_lettura_anagrafica' }, errAnagrafica)
    return { ok: false }
  }
  // Nessun fascicolo: non c'è niente da cancellare, e non è un errore. È il caso
  // dei docenti senza anagrafica, e del secondo giro.
  if (!anagrafica) return { ok: true, trovato: false, praticaId: null, percorsi: [] }

  const riga = anagrafica as RigaFascicolo
  const praticaId = riga.origine_pratica_id ?? null

  // La pratica, per i SUOI percorsi: se il travaso all'approvazione era degradato
  // può averli ancora, e sono gli stessi file.
  let percorsiPratica: string[] = []
  if (praticaId) {
    const { data: pratica, error: errPratica } = await supabase
      .from('pratiche_personale')
      .select('id, documento_fronte_path, documento_retro_path')
      .eq('id', praticaId)
      .maybeSingle()
    if (errPratica) {
      logErrore({ operazione: op, evento: 'fascicolo_lettura_pratica' }, errPratica)
      return { ok: false }
    }
    if (pratica) percorsiPratica = percorsiDelDocumento(pratica as ConDocumento)
  }

  return {
    ok: true,
    trovato: true,
    praticaId,
    percorsi: [...new Set([...percorsiDelDocumento(riga), ...percorsiPratica])],
  }
}

export type EsitoRigheDipendente =
  | {
      esito: 'ok'
      praticheCancellate: number
      anagraficheCancellate: number
      profiloEliminato: boolean
      /** Righe del registro staccate dalla funzione: i loro file vanno nel cestino anche loro. */
      percorsiStaccati: string[]
      /**
       * `true` = la funzione nuova non c'è e si è usata quella di prima: il profilo lo toglie
       * la cascata dell'account. `false` con `profiloEliminato: false` vuol dire invece che il
       * profilo era GIÀ sparito (un secondo POST che ha aspettato il primo): non è un ripiego.
       */
      ripiego: boolean
    }
  | { esito: 'rifiutata' }
  | { esito: 'guasto' }
  /**
   * Un errore senza codice di Postgres né di PostgREST (rete caduta, tempo scaduto sul client,
   * un 5xx del gateway): la transazione può essere andata a buon fine e la risposta essersi
   * persa. Chi chiama RILEGGE il profilo prima di dire «niente è stato cancellato».
   */
  | { esito: 'incerto' }

/**
 * Pratica, fascicolo e profilo in UNA transazione. `rifiutata` = una chiave senza
 * cascata trattiene il profilo (23503): niente è stato cancellato, si archivia.
 * Dove la funzione non c'è (DB della CI) ripiega sulla sola cancellazione del
 * fascicolo, e il profilo resta da togliere all'account (`profiloEliminato: false`);
 * la funzione di prima non stacca il registro (`percorsiStaccati: []`).
 */
export async function eliminaRigheDipendente(
  supabase: SupabaseClient,
  utenteId: string,
  praticaId: string | null,
  op: string,
): Promise<EsitoRigheDipendente> {
  const r = await supabase.rpc('personale_elimina_dipendente', { p_utente_id: utenteId, p_pratica_id: praticaId })
  if (!r.error) {
    const c = (r.data ?? {}) as Conteggi
    return {
      esito: 'ok',
      praticheCancellate: c.pratiche_cancellate ?? 0,
      anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
      profiloEliminato: (c.profili_cancellati ?? 0) > 0,
      percorsiStaccati: percorsiStaccatiDa(c),
      ripiego: false,
    }
  }
  if (r.error.code === '23503') {
    logEvento('gdpr', 'warn', { operazione: op, esito: 'eliminazione-rifiutata-si-archivia', entita_id: utenteId }, r.error)
    return { esito: 'rifiutata' }
  }
  if (PERSONALE_ELIMINA_ASSENTE.has(r.error.code)) {
    // `info` (specifica §5): nel DB della CI la funzione non c'è ancora, ed è previsto. In
    // produzione questa riga non deve comparire mai (la cerca la misura «dopo»).
    logEvento('gdpr', 'info', { operazione: op, esito: 'rpc-eliminazione-assente-ripiego', entita_id: utenteId }, r.error)
    const vecchia = await supabase.rpc('personale_cancella_fascicolo', { p_utente_id: utenteId, p_pratica_id: praticaId })
    if (vecchia.error) {
      logEvento('gdpr', 'error', { operazione: op, esito: 'righe-fascicolo-non-cancellate', entita_id: utenteId }, vecchia.error)
      return { esito: 'guasto' }
    }
    const c = (vecchia.data ?? {}) as Conteggi
    return {
      esito: 'ok',
      praticheCancellate: c.pratiche_cancellate ?? 0,
      anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
      profiloEliminato: false,
      percorsiStaccati: [],
      ripiego: true,
    }
  }
  if (!codiceDalDatabase(r.error)) {
    // `warn` e non `error`: chi chiama rilegge il profilo e scrive lui l'esito vero
    // (`risposta-persa-dopo-commit` o `righe-dipendente-non-cancellate`).
    logEvento('gdpr', 'warn', { operazione: op, esito: 'righe-dipendente-esito-incerto', entita_id: utenteId }, r.error)
    return { esito: 'incerto' }
  }
  logEvento('gdpr', 'error', { operazione: op, esito: 'righe-dipendente-non-cancellate', entita_id: utenteId }, r.error)
  return { esito: 'guasto' }
}

const CESTINO_VUOTO: EsitoCestino = { nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }

/** Le scansioni nel cestino del bucket del personale. Mai i percorsi nei log. */
export async function spostaScansioniNelCestino(
  supabase: SupabaseClient,
  percorsi: string[],
  op: string,
): Promise<EsitoCestino> {
  if (percorsi.length === 0) return { ...CESTINO_VUOTO }
  return spostaNelCestino(supabase, BUCKET_DOCUMENTI_PERSONALE, percorsi, op)
}

export type EsitoFascicolo =
  | {
      ok: true
      /** Spostati nel cestino: recuperabili finché il giro notturno non li distrugge. */
      fileNelCestino: number
      /** Usciti dal loro posto: nel cestino più quelli cancellati subito. */
      fileRimossi: number
      fileGiaAssenti: number
      fileOrfani: number
      praticheCancellate: number
      anagraficheCancellate: number
    }
  | { ok: false; motivo: 'lettura-fallita' | 'righe-non-cancellate' }

/** Il solo fascicolo (il profilo resta): è il percorso di `riporta-a-genitore`. */
export async function cancellaFascicoloPersonale(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<EsitoFascicolo> {
  const letto = await leggiFascicoloPersonale(supabase, utenteId, op)
  if (!letto.ok) return { ok: false, motivo: 'lettura-fallita' }
  if (!letto.trovato) {
    return {
      ok: true,
      fileNelCestino: 0,
      fileRimossi: 0,
      fileGiaAssenti: 0,
      fileOrfani: 0,
      praticheCancellate: 0,
      anagraficheCancellate: 0,
    }
  }

  const r = await supabase.rpc('personale_cancella_fascicolo', {
    p_utente_id: utenteId,
    p_pratica_id: letto.praticaId,
  })
  if (r.error) {
    // Nessun file è stato toccato: lo stato è quello di prima, e si può riprovare.
    logEvento('gdpr', 'error', { operazione: op, esito: 'righe-fascicolo-non-cancellate', entita_id: utenteId }, r.error)
    return { ok: false, motivo: 'righe-non-cancellate' }
  }
  const c = (r.data ?? {}) as Conteggi
  const file = await spostaScansioniNelCestino(supabase, letto.percorsi, op)
  return {
    ok: true,
    fileNelCestino: file.nelCestino,
    fileRimossi: file.nelCestino + file.rimossiSenzaCestino,
    fileGiaAssenti: file.giaAssenti,
    fileOrfani: file.orfani,
    praticheCancellate: c.pratiche_cancellate ?? 0,
    anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
  }
}
