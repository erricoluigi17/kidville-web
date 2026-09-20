import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { percorsiDelDocumento, type ConDocumento } from './documento-righe'

/**
 * CANCELLARE UN FASCICOLO DEL PERSONALE RACCOLTO PER ERRORE — nell'ordine
 * **file → pratica → anagrafica**, e l'ordine è tutta la correttezza.
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
 * ─── PERCHÉ I FILE PER PRIMI ──────────────────────────────────────────────────
 *
 * Perché la DELETE della pratica cascata su `caricamenti_personale`
 * (`20260812194501`, FK `pratica_id` → `ON DELETE CASCADE`), cioè sull'UNICA riga
 * di registro che nomina quei file. Cancellando le righe per prime, l'oggetto
 * resterebbe nel bucket senza che nessuna riga al mondo possa più nominarlo:
 * invisibile, non cancellato, e non eliminabile nemmeno su richiesta
 * dell'interessata. `spazzaCaricamentiSospesi` non lo troverebbe, perché cerca
 * righe con `pratica_id is null` — non righe inesistenti.
 *
 * E se la rimozione fallisce, non è uscito niente e non c'è niente da
 * verificare: toccare le righe adesso renderebbe le scansioni IRRAGGIUNGIBILI
 * invece che cancellate. È la stessa regola, con le stesse parole, di
 * `gdpr/retention-personale:POST`.
 *
 * ⚠️ IL PRECEDENTE OPPOSTO — `protocollo_elimina`, che cancella la riga e poi fa
 * rimuovere i file — NON va seguito qui. Là la riga è un protocollo
 * amministrativo; qui è l'unico puntatore alla fotografia di un documento
 * d'identità.
 *
 * ─── PERCHÉ UNA RPC PER LE DUE RIGHE ──────────────────────────────────────────
 *
 * PostgREST non rende atomiche due `.delete()`, e i due esiti parziali non si
 * somigliano: cancellata la sola anagrafica resta una pratica `approvata` e
 * slegata, che `retention-personale` non tocca MAI — le approvate le raggiunge
 * solo passando per `origine_pratica_id`, che non esiste più. Un codice fiscale
 * immortale. La compensazione non è un'alternativa: per ricreare la pratica
 * servirebbero i 32 campi appena cancellati.
 *
 * ─── IDEMPOTENTE ──────────────────────────────────────────────────────────────
 *
 * Al secondo giro i file risultano `giaAssenti` — esito raggiunto, non guasto — e
 * la RPC trova zero righe e lo dice. Lo stato intermedio possibile è UNO SOLO e
 * benigno: file fuori, righe ancora lì. Visibile a log `error`, riprovabile con
 * lo stesso comando, e senza oggetti orfani.
 */

/** Il bucket delle scansioni. Lo stesso di `retention-personale`. */
const BUCKET_DOCUMENTI = 'documenti_personale'

export type EsitoFascicolo =
  | {
      ok: true
      fileRimossi: number
      fileGiaAssenti: number
      praticheCancellate: number
      anagraficheCancellate: number
    }
  | { ok: false; motivo: 'lettura-fallita' | 'file-non-rimossi' | 'righe-non-cancellate' }

type RigaFascicolo = {
  utente_id: string
  origine_pratica_id?: string | null
  documento_fronte_path?: string | null
  documento_retro_path?: string | null
}

export async function cancellaFascicoloPersonale(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<EsitoFascicolo> {
  // 1. Il fascicolo, con il legame alla pratica e i percorsi.
  const { data: anagrafica, error: errAnagrafica } = await supabase
    .from('anagrafica_personale')
    .select('utente_id, origine_pratica_id, documento_fronte_path, documento_retro_path')
    .eq('utente_id', utenteId)
    .maybeSingle()
  if (errAnagrafica) {
    logErrore({ operazione: op, evento: 'fascicolo_lettura_anagrafica' }, errAnagrafica)
    return { ok: false, motivo: 'lettura-fallita' }
  }
  // Nessun fascicolo: non c'è niente da cancellare, e non è un errore. È il caso
  // dei 13 docenti che al 2026-09-20 non hanno anagrafica, e del secondo giro.
  if (!anagrafica) {
    return { ok: true, fileRimossi: 0, fileGiaAssenti: 0, praticheCancellate: 0, anagraficheCancellate: 0 }
  }
  const riga = anagrafica as RigaFascicolo
  const praticaId = riga.origine_pratica_id ?? null

  // 2. La pratica, per i SUOI percorsi. All'approvazione le due colonne vengono
  //    svuotate e il fascicolo punta agli stessi oggetti («un oggetto, un
  //    proprietario»), ma se quel travaso era degradato la pratica può averli
  //    ancora — e sono gli stessi file.
  let percorsiPratica: string[] = []
  if (praticaId) {
    const { data: pratica, error: errPratica } = await supabase
      .from('pratiche_personale')
      .select('id, documento_fronte_path, documento_retro_path')
      .eq('id', praticaId)
      .maybeSingle()
    if (errPratica) {
      logErrore({ operazione: op, evento: 'fascicolo_lettura_pratica' }, errPratica)
      return { ok: false, motivo: 'lettura-fallita' }
    }
    // ⚠️ `ConDocumento` e non `RigaFascicolo`: la pratica ha `id`, non
    // `utente_id`. Forzarla nel tipo del fascicolo compilava solo con un doppio
    // cast, che è il modo di far tacere il controllo invece di ascoltarlo.
    if (pratica) percorsiPratica = percorsiDelDocumento(pratica as ConDocumento)
  }

  const percorsi = [...new Set([...percorsiDelDocumento(riga), ...percorsiPratica])]

  // 3. I FILE PER PRIMI. Mai i percorsi nei log: contengono l'uuid di chi ha
  //    caricato e il nome del file, che quasi sempre è il nome di una persona.
  let fileRimossi = 0
  let fileGiaAssenti = 0
  if (percorsi.length > 0) {
    const esito = await rimuoviEVerifica(supabase, BUCKET_DOCUMENTI, percorsi, op)
    const restano = bloccanti(esito)
    if (esito.erroreRimozione || restano.length > 0) {
      logEvento('gdpr', 'error', {
        operazione: op,
        esito: 'scansioni-non-rimosse',
        n_bloccanti: restano.length,
        errore_rimozione: esito.erroreRimozione,
      })
      return { ok: false, motivo: 'file-non-rimossi' }
    }
    fileRimossi = esito.rimossi.length
    fileGiaAssenti = esito.giaAssenti.length
  }

  // 4. Le due righe, in una transazione sola.
  const { data: conteggi, error: errRpc } = await supabase.rpc('personale_cancella_fascicolo', {
    p_utente_id: utenteId,
    p_pratica_id: praticaId,
  })
  if (errRpc) {
    // ⚠️ I FILE SONO GIÀ USCITI, e va detto: è lo stato che il giro dopo
    // troverà, e senza questa riga sembrerebbe che non sia successo niente.
    logEvento(
      'gdpr',
      'error',
      { operazione: op, esito: 'file-rimossi-righe-no', n_file_rimossi: fileRimossi },
      errRpc,
    )
    return { ok: false, motivo: 'righe-non-cancellate' }
  }

  const c = (conteggi ?? {}) as { pratiche_cancellate?: number; anagrafiche_cancellate?: number }
  return {
    ok: true,
    fileRimossi,
    fileGiaAssenti,
    praticheCancellate: c.pratiche_cancellate ?? 0,
    anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
  }
}
