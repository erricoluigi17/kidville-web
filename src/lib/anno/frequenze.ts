import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { segnalaErroreAnnoGestito } from '@/lib/logging/context'
import { giornoDiRoma } from '@/lib/primaria/periodo'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceAnnoDa } from '@/lib/anno/tipi'
import { STATO_ISCRITTO, STATO_RITIRATO } from '@/lib/alunni/stato'

/**
 * LA DOPPIA SCRITTURA `alunni` ↔ `frequenze` (specifica §4.19, Compiti 3.7 e 4.3.5).
 *
 * Fase A (fino alla 4.3.4): la fonte di verità è `alunni`; il trigger `alunni_specchio_frequenza()` (migrazione M1) copia
 * 15 colonne nella frequenza dell'anno ATTIVO, e le route scrivono `alunni` e POI chiamano `scriviFrequenza`.
 * Fase B (da `anno_regole.specchio_frequenze_attivo`, migrazione M43): comanda la frequenza dell'anno attivo e `alunni`
 * ne è la copia (`frequenze_specchio_alunni`). Le route scrivono PRIMA la frequenza, e solo se è passata scrivono
 * `alunni`: l'ordine lo decide `scriviAlunnoEFrequenza` (`src/lib/anno/scrittura.ts`), l'unico posto che chiama
 * `scriviFrequenza` insieme a un `alunni`. Resta la scrittura esplicita l'unica strada per un anno che non è l'attivo (4.5).
 *
 * ⚠️ `campiFrequenzaDaAlunno` DEVE dare gli stessi valori del trigger: lo prova `__tests__/lib/anno-frequenze.test.ts`
 * (parità in PGlite contro la funzione SQL vera). Se cambi una regola qui, cambia anche lì il caso.
 *
 * ⚠️ Nei log: uuid e codici, mai un valore. `sospeso_motivo` è testo libero e un importo è un dato del genitore.
 */

export type CampiFrequenza = Partial<{
  /** Il POST di una scheda nuova e il PATCH che cambia `data_iscrizione` (la data d'ingresso scelta): NON è tra le colonne di `campiFrequenzaDaAlunno`, che resta pari al trigger. */
  data_ingresso: string
  section_id: string | null
  stato: typeof STATO_ISCRITTO | typeof STATO_RITIRATO
  data_uscita: string | null
  retta_mensile: number | null
  retta_a_carico_di: string | null
  retta_split_config: unknown
  intestatario_fatture: unknown
  giorno_scadenza_pagamenti: number | null
  gruppo_mensa_id: string | null
  sospeso: boolean
  sospeso_causa: string | null
  sospeso_motivo: string | null
  sospeso_il: string | null
  sospeso_da: string | null
  usa_pannolino: boolean
}>

const ha = (p: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined
const oNull = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v)

/**
 * Le colonne di `frequenze` che una patch di `alunni` tocca, tradotte come le traduce lo specchio:
 *  - `importo_retta_mensile` ≤ 0 (o non numerico) → `retta_mensile` NULL: lo zero non esiste più;
 *  - `giorno_scadenza_pagamenti` vale solo da 1 a 28, altrimenti NULL;
 *  - lo STATO viene da `archiviato_il`, non da `alunni.stato`: archiviato → `ritirato` con `data_uscita` = giorno di
 *    Roma dell'archiviazione; non archiviato → `iscritto`, senza uscita. Il riporto dentro [ingresso, fine] e la
 *    regola «solo se la frequenza è `recupero`» li applica `scriviFrequenza`, che ha la riga davanti;
 *  - `sospeso` e `usa_pannolino` NULL → false (come il `coalesce` dello specchio);
 *  - `scuola_id` NON è una colonna da copiare: la sede di una frequenza è quella del suo anno. Un cambio di sede è un
 *    trasferimento (la vecchia frequenza `trasferito`, una nuova nella sede nuova), e lo fa lo specchio.
 * Una patch senza colonne copiate dà `{}`.
 */
export function campiFrequenzaDaAlunno(patch: Record<string, unknown>): CampiFrequenza {
  const c: CampiFrequenza = {}

  if (ha(patch, 'section_id')) c.section_id = oNull(patch.section_id as string | null)

  if (ha(patch, 'archiviato_il')) {
    const a = patch.archiviato_il
    if (a === null) {
      c.stato = STATO_ISCRITTO
      c.data_uscita = null
    } else {
      const giorno = giornoDiRoma(typeof a === 'string' ? a : null)
      // un istante che non si legge non decide uno stato: meglio nessun campo che un'uscita inventata
      if (giorno) {
        c.stato = STATO_RITIRATO
        c.data_uscita = giorno
      }
    }
  }

  if (ha(patch, 'importo_retta_mensile')) {
    const v = patch.importo_retta_mensile
    const n = v === null ? Number.NaN : Math.round(Number(v) * 100) / 100
    c.retta_mensile = Number.isFinite(n) && n > 0 ? n : null
  }
  if (ha(patch, 'retta_a_carico_di')) c.retta_a_carico_di = oNull(patch.retta_a_carico_di as string | null)
  if (ha(patch, 'retta_split_config')) c.retta_split_config = oNull(patch.retta_split_config)
  if (ha(patch, 'intestatario_fatture')) c.intestatario_fatture = oNull(patch.intestatario_fatture)

  if (ha(patch, 'giorno_scadenza_pagamenti')) {
    const n = patch.giorno_scadenza_pagamenti === null ? Number.NaN : Number(patch.giorno_scadenza_pagamenti)
    c.giorno_scadenza_pagamenti = Number.isInteger(n) && n >= 1 && n <= 28 ? n : null
  }
  if (ha(patch, 'gruppo_mensa_id')) c.gruppo_mensa_id = oNull(patch.gruppo_mensa_id as string | null)

  if (ha(patch, 'sospeso')) c.sospeso = Boolean(patch.sospeso)
  if (ha(patch, 'sospeso_causa')) c.sospeso_causa = oNull(patch.sospeso_causa as string | null)
  if (ha(patch, 'sospeso_motivo')) c.sospeso_motivo = oNull(patch.sospeso_motivo as string | null)
  if (ha(patch, 'sospeso_il')) c.sospeso_il = oNull(patch.sospeso_il as string | null)
  if (ha(patch, 'sospeso_da')) c.sospeso_da = oNull(patch.sospeso_da as string | null)
  if (ha(patch, 'usa_pannolino')) c.usa_pannolino = Boolean(patch.usa_pannolino)

  return c
}

export type EsitoFrequenza =
  | { ok: true }
  | { ok: true; saltata: 'anno-non-attivo' | 'schema-indietro' | 'nessun-campo' | 'nessuna-riga' | 'nessuna-modifica' }
  | { ok: false; codice: string }

type ErrorePg = { code?: string | null; message?: string | null } | null | undefined

const OPERAZIONE = 'anno/frequenze:scriviFrequenza'

/** Un errore che ha fermato la scrittura: dell'anno → warn col codice; altro → logErrore col solo SQLSTATE. */
function esitoDaErrore(error: ErrorePg, passo: string): EsitoFrequenza {
  if (schemaAnnoIndietro(error)) return { ok: true, saltata: 'schema-indietro' }
  const codice = codiceAnnoDa(error?.message)
  if (codice) {
    // Il `passo` sta in `operazione`: una chiave `passo` non è nella lista bianca dei log e uscirebbe redatta.
    logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-non-scritta', error_code: codice, operazione: `${OPERAZIONE}:${passo}` })
    // Gestito qui, fail-open: la rete di `withRoute` non deve tradurlo se la route risponde 500 per altro (Minor 7).
    segnalaErroreAnnoGestito(codice)
    return { ok: false, codice }
  }
  // Solo il codice di Postgres: il messaggio di un CHECK riporta la riga intera (sospeso_motivo compreso).
  logErrore({ operazione: OPERAZIONE }, new Error(`frequenze:${passo}:${error?.code ?? 'senza-codice'}`))
  return { ok: false, codice: 'SCRITTURA_FALLITA' }
}

/** Gli stati dell'anno in cui la 4.5 può scrivere una frequenza anche se non è l'attivo (`annoNonAttivo`). */
const STATI_ANNO_SCRIVIBILI: readonly string[] = ['in_preparazione', 'iscrizioni_aperte', 'corrente']
/** Gli stati in cui una frequenza è finita: il ritiro non la cambia, la riapertura la riporta `in_attesa`. */
const STATI_CHIUSI: readonly string[] = ['ritirato', 'trasferito', 'uscito']

/** least(greatest(uscita, ingresso), fine): le date sono AAAA-MM-GG, si confrontano come testo. */
function portaInUscita(uscita: string, ingresso: string, fine: string): string {
  return uscita < ingresso ? ingresso : uscita > fine ? fine : uscita
}

/**
 * Scrive nella frequenza `(alunnoId, annoSedeId)` i `campi` tradotti. NON LANCIA MAI.
 *
 *  - nessun campo → `saltata: 'nessun-campo'`;
 *  - `annoSedeId` che non è l'anno attivo della sua sede (`anno_attivo(scuola_id)`) → `saltata: 'anno-non-attivo'`,
 *    nessuna scrittura. Con `annoNonAttivo: true` (la 4.5: conferme e iscrizioni dell'anno prossimo) il controllo
 *    sull'attivo si salta, MA si scrive solo se l'anno è `in_preparazione`, `iscrizioni_aperte` o `corrente`: un anno
 *    `in_chiusura`/`chiuso` resta `saltata: 'anno-non-attivo'` con un warn (`frequenza-anno-non-scrivibile`) e si corregge
 *    col gettone (PR 3-B);
 *  - la frequenza non c'è → `{ ok: true }` e niente: la crea lo specchio, qui non si crea;
 *  - STATO e USCITA, per ogni origine (4.5.1: dal 4.5.5 nascono frequenze `domanda`, `conferma`, `segreteria`, e il ritiro di
 *    un bambino deve chiuderle tutte, altrimenti lo specchio `frequenze → alunni` lo rimette fra gli iscritti):
 *      · `recupero`: come sempre, la patch scrive stato e uscita (l'uscita si porta dentro [data_ingresso, fine]);
 *      · altra origine, VIVA (`in_attesa`/`iscritto`): ritiro → `ritirato` con l'uscita portata in [ingresso, fine];
 *        riapertura → niente (resta com'è: lo decide il trigger);
 *      · altra origine, CHIUSA: ritiro → niente (è già chiusa, l'uscita non si cambia); riapertura → `in_attesa` e
 *        uscita NULL. MAI `iscritto` scritto a mano (lo ferma `frequenze_iscritto_a_posto`): se moduli e quota sono a posto
 *        il trigger la porta a `iscritto` da solo;
 *  - `PGRST205` & C. (schema dell'anno assente: la CI) → `saltata: 'schema-indietro'`;
 *  - un errore dell'anno (`SEZIONE_DI_ALTRO_ANNO`…) → `{ ok: false, codice }` e un warn; altro →
 *    `SCRITTURA_FALLITA` e un logErrore col solo SQLSTATE (anche il `23505` di una riapertura con un'altra frequenza viva
 *    dello stesso bambino e anno). Non decide cosa fare dell'errore: in fase A il chiamante ha già scritto `alunni`
 *    e non deve fallire per la frequenza; in fase B `scriviAlunnoEFrequenza` la chiama PRIMA e, se fallisce, non scrive `alunni`.
 */
export async function scriviFrequenza(
  supabase: SupabaseClient,
  {
    alunnoId, annoSedeId, campi, annoNonAttivo = false,
  }: { alunnoId: string; annoSedeId: string; campi: CampiFrequenza; annoNonAttivo?: boolean },
): Promise<EsitoFrequenza> {
  try {
    if (Object.keys(campi).length === 0) return { ok: true, saltata: 'nessun-campo' }

    const anno = await supabase.from('anni_sede').select('scuola_id, fine, stato').eq('id', annoSedeId).maybeSingle()
    if (anno.error) return esitoDaErrore(anno.error, 'anno')
    if (!anno.data) {
      // Un anno che non esiste non è un anno «non attivo»: chi chiama ha un uuid sbagliato (4.5.15, minore 4.5.1). Si dice, senza valori.
      logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-anno-inesistente', operazione: OPERAZIONE })
      return { ok: true, saltata: 'anno-non-attivo' }
    }
    const { scuola_id: scuolaId, fine, stato: statoAnno } = anno.data as { scuola_id: string; fine: string; stato: string }

    if (annoNonAttivo) {
      if (!STATI_ANNO_SCRIVIBILI.includes(statoAnno)) {
        // solo il tipo e l'operazione: nessun valore della patch
        logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-anno-non-scrivibile', operazione: OPERAZIONE })
        return { ok: true, saltata: 'anno-non-attivo' }
      }
    } else {
      const attivo = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
      if (attivo.error) return esitoDaErrore(attivo.error, 'anno-attivo')
      if (attivo.data !== annoSedeId) {
        // (giro 3, NB1/NB2) Nella finestra fra la conferma e l'inizio l'anno attivo è il nuovo, ma le schede seguono ancora il vecchio:
        // la frequenza dell'anno VISIBILE si scrive come quella dell'attivo (retta, giorno di scadenza, ritiro). Senza la funzione
        // (schema indietro) o con un altro anno resta `anno-non-attivo`, come prima.
        const visibile = await supabase.rpc('anno_visibile_oggi', { p_scuola: scuolaId })
        if (visibile.error || visibile.data !== annoSedeId) return { ok: true, saltata: 'anno-non-attivo' }
      }
    }

    const riga = await supabase
      .from('frequenze')
      .select('id, origine, data_ingresso, stato')
      .eq('alunno_id', alunnoId)
      .eq('anno_sede_id', annoSedeId)
      .maybeSingle()
    if (riga.error) return esitoDaErrore(riga.error, 'lettura')
    if (!riga.data) return { ok: true, saltata: 'nessuna-riga' } // la crea lo specchio: qui non si è scritto niente
    const f = riga.data as { id: string; origine: string; data_ingresso: string; stato: string }

    const set: Record<string, unknown> = { ...campi }
    if (f.origine === 'recupero') {
      if (typeof set.data_uscita === 'string') set.data_uscita = portaInUscita(set.data_uscita, f.data_ingresso, fine)
    } else {
      const chiusa = STATI_CHIUSI.includes(f.stato)
      const ritiro = set.stato === STATO_RITIRATO
      const riapertura = set.stato === STATO_ISCRITTO
      const uscita = set.data_uscita
      delete set.stato
      delete set.data_uscita
      if (ritiro && !chiusa && typeof uscita === 'string') {
        set.stato = STATO_RITIRATO
        set.data_uscita = portaInUscita(uscita, f.data_ingresso, fine)
      } else if (riapertura && chiusa) {
        // mai `iscritto` a mano: se moduli e quota sono a posto il trigger la porta a `iscritto`
        set.stato = 'in_attesa'
        set.data_uscita = null
      }
    }
    if (Object.keys(set).length === 0) return { ok: true, saltata: 'nessuna-modifica' }

    const scritta = await supabase.from('frequenze').update(set).eq('id', f.id).select('id')
    if (scritta.error) return esitoDaErrore(scritta.error, 'scrittura')
    return { ok: true }
  } catch (err) {
    // il client ha lanciato (rete, configurazione): la route non deve fallire per la frequenza
    logErrore({ operazione: OPERAZIONE }, err)
    return { ok: false, codice: 'SCRITTURA_FALLITA' }
  }
}

/**
 * L'anno ATTIVO di una sede (`anni_sede.id`), letto con `anno_attivo(p_scuola)`. NON LANCIA MAI.
 *
 * Serve alle route che scrivono `alunni` e la frequenza (`scriviAlunnoEFrequenza`): l'`annoSedeId` è quello della sede
 * dell'alunno (su un trasferimento, della sede NUOVA). `null` vuol dire «non chiamare `scriviFrequenza`»: sede senza
 * anno attivo, schema indietro (`PGRST202`/`PGRST205`, il DB della CI) oppure un guasto, che si logga col solo codice.
 * `cache` (una `Map` per richiesta) evita di rileggere la stessa sede quando la route scrive più alunni.
 */
/**
 * I client (uno per richiesta) per cui la lettura di `anno_attivo` è FALLITA (non: sede senza anno o schema indietro).
 * `null` da `annoAttivoDiSede` vale sia «niente anno attivo» (si scrive solo `alunni`) sia «guasto»: in fase B il secondo
 * caso non può scrivere `alunni` senza frequenza. Chi deve distinguere chiede `letturaAnnoFallita(supabase)`: è larga
 * (qualunque sede di quella richiesta), cioè sbaglia dalla parte che rifiuta.
 */
const LETTURE_ANNO_FALLITE = new WeakSet<object>()
export function letturaAnnoFallita(supabase: SupabaseClient): boolean {
  return LETTURE_ANNO_FALLITE.has(supabase)
}

export async function annoAttivoDiSede(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  if (!scuolaId) return null
  if (cache?.has(scuolaId)) return cache.get(scuolaId) ?? null
  let anno: string | null = null
  try {
    const r = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
    if (r.error) {
      if (!schemaAnnoIndietro(r.error)) {
        // solo il SQLSTATE: il messaggio non serve a niente e non deve portare dati
        logErrore({ operazione: 'anno/frequenze:annoAttivoDiSede' }, new Error(`anno_attivo:${r.error.code ?? 'senza-codice'}`))
        LETTURE_ANNO_FALLITE.add(supabase)
      }
    } else if (typeof r.data === 'string') {
      anno = r.data
    }
  } catch (err) {
    logErrore({ operazione: 'anno/frequenze:annoAttivoDiSede' }, err)
    LETTURE_ANNO_FALLITE.add(supabase)
  }
  cache?.set(scuolaId, anno)
  return anno
}

/**
 * (giro 3, NB1/NB2) L'anno VISIBILE di una sede oggi (`anno_visibile_oggi`): quello che le schede seguono. Fuori dalla finestra fra la
 * conferma del passaggio e l'inizio coincide con l'attivo; nella finestra è l'anno che finisce, mentre l'attivo è già il nuovo (non ancora
 * cominciato). Le route che SALVANO o ARCHIVIANO la scheda scrivono i campi per anno nella frequenza di questo anno, non dell'attivo.
 * Non lancia mai. Se la funzione non c'è (schema indietro) o fallisce, ripiega sull'attivo: il comportamento di prima, mai peggio.
 */
export async function annoVisibileDiSede(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  if (!scuolaId) return null
  if (cache?.has(scuolaId)) return cache.get(scuolaId) ?? null
  try {
    const r = await supabase.rpc('anno_visibile_oggi', { p_scuola: scuolaId })
    if (!r.error && typeof r.data === 'string') {
      cache?.set(scuolaId, r.data)
      return r.data
    }
    if (r.error && !schemaAnnoIndietro(r.error)) {
      logErrore({ operazione: 'anno/frequenze:annoVisibileDiSede' }, new Error(`anno_visibile_oggi:${r.error.code ?? 'senza-codice'}`))
    }
  } catch (err) {
    logErrore({ operazione: 'anno/frequenze:annoVisibileDiSede' }, err)
  }
  return annoAttivoDiSede(supabase, scuolaId, cache)
}

/**
 * (giro 3) LA FINESTRA fra la conferma del passaggio e l'inizio dell'anno nuovo: l'anno attivo è già il nuovo (non ancora cominciato),
 * il visibile è ancora il vecchio. `null` fuori dalla finestra, o se le due letture non riescono: in dubbio si resta nel comportamento
 * di prima. NON segna il client fra le letture fallite (`LETTURE_ANNO_FALLITE`): è una lettura di contorno, e se l'anno attivo non si
 * legge davvero lo scoprirà e lo segnerà la scrittura vera, che ne risponde.
 */
export async function finestraDiSede(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
): Promise<{ attivo: string; visibile: string } | null> {
  return (await leggiFinestraDiSede(supabase, scuolaId)).finestra
}

/**
 * (Riattiva, giro 9, O-a) Come `finestraDiSede`, ma dice anche se una lettura è CADUTA (`guasto`): «non so» non vale «fuori dalla finestra».
 * Chi scrive in base alla finestra (la chiusura delle iscrizioni all'archiviazione) deve poter distinguere i due casi. Lo schema indietro
 * (la CI, un ambiente a metà) non è un guasto.
 */
export async function leggiFinestraDiSede(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
): Promise<{ finestra: { attivo: string; visibile: string } | null; guasto: boolean }> {
  if (!scuolaId) return { finestra: null, guasto: false }
  try {
    const [att, vis] = await Promise.all([
      supabase.rpc('anno_attivo', { p_scuola: scuolaId }),
      supabase.rpc('anno_visibile_oggi', { p_scuola: scuolaId }),
    ])
    if (att.error || vis.error) {
      let guasto = false
      for (const e of [att.error, vis.error]) {
        if (e && !schemaAnnoIndietro(e)) {
          guasto = true
          logErrore({ operazione: 'anno/frequenze:finestraDiSede' }, new Error(`finestra:${e.code ?? 'senza-codice'}`))
        }
      }
      return { finestra: null, guasto }
    }
    if (typeof att.data === 'string' && typeof vis.data === 'string' && att.data !== vis.data) {
      return { finestra: { attivo: att.data, visibile: vis.data }, guasto: false }
    }
  } catch (err) {
    logErrore({ operazione: 'anno/frequenze:finestraDiSede' }, err)
    return { finestra: null, guasto: true }
  }
  return { finestra: null, guasto: false }
}

/**
 * I siti che scrivono `alunni` e NON passano dalla frequenza, ciascuno col suo motivo. Lo legge il lock del 3.9, rivisto
 * nel 4.3.5: un sito `.from('alunni')` con insert/update/upsert di una colonna copiata (o di `classe_sezione`, da cui il
 * trigger BEFORE ricava `section_id`) deve usare `scriviAlunnoEFrequenza` (`src/lib/anno/scrittura.ts`) o stare qui.
 * ⚠️ «Nessuna colonna copiata» deve restare VERO: dalla fase B una scrittura di una colonna copiata che non passa dalla
 * frequenza viene annullata alla prossima scrittura della frequenza.
 */
export const ESENTI: readonly { file: string; motivo: string }[] = [
  {
    file: 'src/lib/sidi/import-apply.ts',
    motivo:
      "Aggiorna solo numero_domanda_sidi e inserisce anagrafica + stato iscritto: nessuna colonna copiata, e la frequenza dell'anno attivo nasce dal trigger-specchio all'INSERT.",
  },
  {
    file: 'src/lib/alunni/libera-spazio.ts',
    motivo:
      "Scrive solo spazio_liberato_il, il segno che i file di un archiviato sono stati tolti: non è una colonna della frequenza e non cambia lo stato dell'alunno.",
  },
  {
    file: 'src/app/api/admin/import/anagrafiche/route.ts',
    motivo:
      "Solo INSERT: section_id lo calcola il trigger BEFORE trg_alunni_sync_section da classe_sezione, e la frequenza dell'anno attivo nasce dal trigger d'INSERT con quella sezione (nessun UPDATE: in fase B non c'è niente da far precedere).",
  },
  {
    file: 'src/lib/gdpr/esegui.ts',
    motivo:
      "Oblio: patchAlunno azzera intestatario_fatture, retta_split_config e sospeso_motivo, ma non chiama scriviFrequenza (scrive un anno solo e non passa la guardia dell'anno chiuso): le frequenze di TUTTI gli anni le pulisce l'oblio con scriviOblio subito dopo (3.6-2).",
  },
]
