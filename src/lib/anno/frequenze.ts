import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { giornoDiRoma } from '@/lib/primaria/periodo'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { codiceAnnoDa } from '@/lib/anno/tipi'
import { STATO_ISCRITTO, STATO_RITIRATO } from '@/lib/alunni/stato'

/**
 * LA DOPPIA SCRITTURA `alunni` → `frequenze` (fase A, specifica §4.19, Compito 3.7).
 *
 * In fase A la fonte di verità è ancora `alunni`: il trigger `alunni_specchio_frequenza()` (migrazione M1) copia 15
 * colonne nella frequenza dell'anno ATTIVO. Le route continuano a scrivere `alunni` e POI chiamano `scriviFrequenza`
 * con i campi tradotti da `campiFrequenzaDaAlunno`. Il valore non è ridondare il trigger: è che dalla 4.3 (fase B)
 * la fonte si capovolge e le route sono già pronte, e che la scrittura esplicita è l'unica strada per un anno
 * che non è l'attivo (4.5).
 *
 * ⚠️ `campiFrequenzaDaAlunno` DEVE dare gli stessi valori del trigger: lo prova `__tests__/lib/anno-frequenze.test.ts`
 * (parità in PGlite contro la funzione SQL vera). Se cambi una regola qui, cambia anche lì il caso.
 *
 * ⚠️ Nei log: uuid e codici, mai un valore. `sospeso_motivo` è testo libero e un importo è un dato del genitore.
 */

export type CampiFrequenza = Partial<{
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
  | { ok: true; saltata: 'anno-non-attivo' | 'schema-indietro' | 'nessun-campo' }
  | { ok: false; codice: string }

type ErrorePg = { code?: string | null; message?: string | null } | null | undefined

const OPERAZIONE = 'anno/frequenze:scriviFrequenza'

/** Un errore che ha fermato la scrittura: dell'anno → warn col codice; altro → logErrore col solo SQLSTATE. */
function esitoDaErrore(error: ErrorePg, passo: string): EsitoFrequenza {
  if (schemaAnnoIndietro(error)) return { ok: true, saltata: 'schema-indietro' }
  const codice = codiceAnnoDa(error?.message)
  if (codice) {
    logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-non-scritta', error_code: codice, operazione: OPERAZIONE, passo })
    return { ok: false, codice }
  }
  // Solo il codice di Postgres: il messaggio di un CHECK riporta la riga intera (sospeso_motivo compreso).
  logErrore({ operazione: OPERAZIONE }, new Error(`frequenze:${passo}:${error?.code ?? 'senza-codice'}`))
  return { ok: false, codice: 'SCRITTURA_FALLITA' }
}

/**
 * Scrive nella frequenza `(alunnoId, annoSedeId)` i `campi` tradotti. NON LANCIA MAI.
 *
 *  - nessun campo → `saltata: 'nessun-campo'`;
 *  - `annoSedeId` che non è l'anno attivo della sua sede (`anno_attivo(scuola_id)`) → `saltata: 'anno-non-attivo'`,
 *    nessuna scrittura (in PR 3 solo l'attivo; la 4.5 abiliterà gli altri);
 *  - la frequenza non c'è → `{ ok: true }` e niente: la crea lo specchio, qui non si crea;
 *  - `stato` e `data_uscita` cambiano solo se la frequenza è `origine = 'recupero'` (una frequenza nata da una
 *    domanda ha un suo ciclo di vita), e l'uscita si porta dentro [data_ingresso, fine dell'anno];
 *  - `PGRST205` & C. (schema dell'anno assente: la CI) → `saltata: 'schema-indietro'`;
 *  - un errore dell'anno (`SEZIONE_DI_ALTRO_ANNO`…) → `{ ok: false, codice }` e un warn; altro →
 *    `SCRITTURA_FALLITA` e un logErrore. Il chiamante ha già scritto `alunni` e non deve fallire per la frequenza.
 */
export async function scriviFrequenza(
  supabase: SupabaseClient,
  { alunnoId, annoSedeId, campi }: { alunnoId: string; annoSedeId: string; campi: CampiFrequenza },
): Promise<EsitoFrequenza> {
  try {
    if (Object.keys(campi).length === 0) return { ok: true, saltata: 'nessun-campo' }

    const anno = await supabase.from('anni_sede').select('scuola_id, fine').eq('id', annoSedeId).maybeSingle()
    if (anno.error) return esitoDaErrore(anno.error, 'anno')
    if (!anno.data) return { ok: true, saltata: 'anno-non-attivo' }
    const { scuola_id: scuolaId, fine } = anno.data as { scuola_id: string; fine: string }

    const attivo = await supabase.rpc('anno_attivo', { p_scuola: scuolaId })
    if (attivo.error) return esitoDaErrore(attivo.error, 'anno-attivo')
    if (attivo.data !== annoSedeId) return { ok: true, saltata: 'anno-non-attivo' }

    const riga = await supabase
      .from('frequenze')
      .select('id, origine, data_ingresso')
      .eq('alunno_id', alunnoId)
      .eq('anno_sede_id', annoSedeId)
      .maybeSingle()
    if (riga.error) return esitoDaErrore(riga.error, 'lettura')
    if (!riga.data) return { ok: true } // la crea lo specchio
    const f = riga.data as { id: string; origine: string; data_ingresso: string }

    const set: Record<string, unknown> = { ...campi }
    if (f.origine !== 'recupero') {
      delete set.stato
      delete set.data_uscita
    } else if (typeof set.data_uscita === 'string') {
      // least(greatest(uscita, ingresso), fine): le date sono AAAA-MM-GG, si confrontano come testo
      const u = set.data_uscita
      set.data_uscita = u < f.data_ingresso ? f.data_ingresso : u > fine ? fine : u
    }
    if (Object.keys(set).length === 0) return { ok: true }

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
 * Serve alle route che, dopo aver scritto `alunni`, chiamano `scriviFrequenza`: l'`annoSedeId` è quello della sede
 * dell'alunno (su un trasferimento, della sede NUOVA). `null` vuol dire «non chiamare `scriviFrequenza`»: sede senza
 * anno attivo, schema indietro (`PGRST202`/`PGRST205`, il DB della CI) oppure un guasto, che si logga col solo codice.
 * `cache` (una `Map` per richiesta) evita di rileggere la stessa sede quando la route scrive più alunni.
 */
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
      }
    } else if (typeof r.data === 'string') {
      anno = r.data
    }
  } catch (err) {
    logErrore({ operazione: 'anno/frequenze:annoAttivoDiSede' }, err)
  }
  cache?.set(scuolaId, anno)
  return anno
}

/**
 * I siti che scrivono `alunni` e NON si collegano a `scriviFrequenza`, ciascuno col suo motivo. Lo legge il lock del
 * 3.9: un sito `.from('alunni')` con insert/update/upsert che non chiama `scriviFrequenza` deve stare qui.
 */
export const ESENTI: readonly { file: string; motivo: string }[] = [
  {
    file: 'src/lib/forms/persist-submission.ts',
    motivo:
      'Scrive solo le colonne anagrafiche mappate dai moduli (db_mapping alunni.*: nome, cognome, codice fiscale, nascita, residenza, allergie, note mediche, documento): nessuna delle 15 colonne copiate nella frequenza.',
  },
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
      "INSERT senza colonne copiate; section_id lo calcola il trigger BEFORE trg_alunni_sync_section da classe_sezione, e lo specchio lo copia nella frequenza.",
  },
  {
    file: 'src/lib/gdpr/esegui.ts',
    motivo:
      "Oblio: patchAlunno azzera intestatario_fatture e retta_split_config. Lo specchio le copia nella frequenza dell'anno attivo. Le frequenze degli altri anni le pulisce l'oblio con scriviOblio (compito 3.6-2).",
  },
]
