import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { CODICI_ANNO } from '@/lib/anno/tipi'
import { normalizzaNomeSezione } from '@/lib/alunni/sezione'
import { letturaAnnoFallita, scriviFrequenza, type CampiFrequenza, type EsitoFrequenza } from '@/lib/anno/frequenze'

/**
 * L'ORDINE DELLE DUE SCRITTURE `alunni` ↔ `frequenze` (Compito 4.3.5).
 *
 * Dalla fase B (migrazione M43, interruttore `anno_regole.specchio_frequenze_attivo`) la verità di classe, stato,
 * retta e sospensione è la frequenza dell'anno ATTIVO; `alunni` ne è la copia, e un trigger la ricopia a ogni scrittura
 * della frequenza. Una scrittura di `alunni` che non è passata dalla frequenza viene ANNULLATA alla prossima scrittura
 * della frequenza (lo specchio inverso riporta indietro il vecchio valore). Per questo ogni sito che scrive le colonne
 * copiate passa da `scriviAlunnoEFrequenza`, e SOLO da lì si decide l'ordine:
 *
 *  - fase A (DB senza la colonna dell'interruttore: la CI): come prima. `alunni` e poi la frequenza, fail-open;
 *  - fase B: PRIMA la frequenza. Se non si scrive, `alunni` NON si tocca e il chiamante riceve il codice (fail-closed:
 *    una scheda che dice una classe e una frequenza che ne dice un'altra è peggio di una richiesta respinta).
 *    La frequenza che non c'è ancora (un alunno nuovo: la fa nascere il trigger d'INSERT) o un anno non attivo
 *    (`saltata`) non sono un errore: `alunni` si scrive come in fase A.
 *
 * Un INSERT di `alunni` è l'eccezione che la chiave esterna impone (la frequenza non può nascere prima della scheda):
 * dopo l'INSERT si usa `scriviFrequenzaDopoAlunni`. Il lock `anno-scrittura-coverage` vieta a chiunque, fuori da qui,
 * di chiamare `scriviFrequenza` da solo.
 */

// ───────────────────────── l'interruttore ─────────────────────────

/** Una lettura per richiesta: la cache sta sul client (che si crea per richiesta), non in un modulo globale. */
const CACHE_FASE_B = new WeakMap<object, Promise<boolean>>()

async function leggiFaseB(supabase: SupabaseClient): Promise<boolean> {
  try {
    const r = await supabase.from('anno_regole').select('specchio_frequenze_attivo').limit(1).maybeSingle()
    if (r.error) {
      // La colonna o la tabella non ci sono (il DB della CI): è la fase A, e non è un guasto.
      if (schemaAnnoIndietro(r.error)) return false
      // Un guasto vero (il database non risponde) NON è la fase A: dalla migrazione `trg_alunni_specchio_frequenza`
      // non c'è più, quindi scrivere `alunni` per primo lascerebbe una scrittura di sola classe senza frequenza, e la
      // scrittura successiva della frequenza la annullerebbe in silenzio. Nel dubbio si va in fase B: la frequenza si
      // scrive PER PRIMA e, se il database è giù, la risposta è un errore onesto.
      logErrore({ operazione: 'anno/fase-b:interruttore' }, new Error(`anno_regole:${r.error.code ?? 'senza-codice'}`))
      return true
    }
    return (r.data as { specchio_frequenze_attivo?: unknown } | null)?.specchio_frequenze_attivo === true
  } catch (err) {
    // il client ha lanciato (rete, configurazione): stesso ragionamento di un guasto, si va in fase B
    logErrore({ operazione: 'anno/fase-b:interruttore' }, err)
    return true
  }
}

/**
 * `true` se la fase B è accesa (`anno_regole.specchio_frequenze_attivo`). NON LANCIA MAI. L'interruttore è globale
 * (`anno_regole` ha una riga sola). Colonna o tabella assenti → `false` senza errore (la CI); un altro guasto → `true`
 * (la frequenza si scrive per prima: un database giù dà un errore onesto) e un `logErrore` col solo codice.
 *
 * ⚠️ L'interruttore SPENTO (`specchio_frequenze_attivo = false`) NON riporta alla fase A di prima: la migrazione ha
 * tolto `trg_alunni_specchio_frequenza`, quindi il ramo «`alunni` e poi la frequenza» scrive la frequenza solo per i
 * `campi` che il chiamante conosce, e una scrittura di sola classe resta su `alunni`. Tornare indietro davvero vuol dire
 * ricreare `trg_alunni_specchio_frequenza` e togliere `trg_frequenze_specchio_alunni` e `trg_alunni_specchio_frequenza_sede`,
 * dall'editor SQL (il freno nega le istruzioni distruttive): vedi il PRD, voce «Sezioni e docenti per anno, fase B».
 */
export function conFaseB(supabase: SupabaseClient): Promise<boolean> {
  let p = CACHE_FASE_B.get(supabase)
  if (!p) {
    p = leggiFaseB(supabase)
    CACHE_FASE_B.set(supabase, p)
  }
  return p
}

// ───────────────────────── la sezione dal nome ─────────────────────────


/**
 * L'uuid della sezione che il trigger BEFORE `sync_alunno_section_id` ricaverebbe da `classe_sezione`: dentro la sede
 * e l'anno di `annoSedeId`, per nome normalizzato. `id: null` se nessuna sezione combacia (il trigger lascerebbe
 * `section_id` a NULL). `ok: false` se la lettura è fallita: chi chiama non scrive.
 * `cache` (una `Map` per richiesta) tiene le sezioni di un anno, per i lotti.
 */
async function sezioneDelNome(
  supabase: SupabaseClient,
  annoSedeId: string,
  nome: string,
  cache?: Map<string, { id: string; name: string }[]>,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  try {
    let sezioni = cache?.get(annoSedeId)
    if (!sezioni) {
      const anno = await supabase.from('anni_sede').select('scuola_id, anno_id').eq('id', annoSedeId).maybeSingle()
      if (anno.error || !anno.data) {
        logErrore(
          { operazione: 'anno/fase-b:sezione' },
          new Error(`anni_sede:${anno.error?.code ?? 'senza-riga'}`),
        )
        return { ok: false }
      }
      const { scuola_id: scuolaId, anno_id: annoId } = anno.data as { scuola_id: string; anno_id: string }
      const lette = await supabase.from('sections').select('id, name').eq('scuola_id', scuolaId).eq('anno_id', annoId)
      if (lette.error) {
        logErrore({ operazione: 'anno/fase-b:sezione' }, new Error(`sections:${lette.error.code ?? 'senza-codice'}`))
        return { ok: false }
      }
      sezioni = (lette.data ?? []) as { id: string; name: string }[]
      cache?.set(annoSedeId, sezioni)
    }
    const cercata = normalizzaNomeSezione(nome)
    return { ok: true, id: sezioni.find((s) => normalizzaNomeSezione(s.name) === cercata)?.id ?? null }
  } catch (err) {
    logErrore({ operazione: 'anno/fase-b:sezione' }, err)
    return { ok: false }
  }
}

// ───────────────────────── l'ordine ─────────────────────────

export type EsitoScritturaAlunno<T> =
  /**
   * `frequenzaGiaScritta`: in fase B la frequenza è stata scritta e poi `scrivi` (la scheda `alunni`) è fallita. Non c'è
   * transazione: la frequenza e la sua copia in `alunni` sono già applicate, e il chiamante deve DIRLO (non «la scheda
   * è rimasta com'era») e riprovare in modo che completi il lavoro. La PR 5 toglie la doppia scrittura e chiude la finestra.
   */
  | { scritto: true; risultato: T; frequenzaGiaScritta?: true }
  | { scritto: false; codice: string }

export type ArgomentiScritturaAlunno = {
  alunnoId: string
  /** `anni_sede.id` dell'anno attivo della sede dell'alunno (su un trasferimento, della sede NUOVA). `null` = niente frequenza. */
  annoSedeId: string | null
  /** I campi della frequenza, da `campiFrequenzaDaAlunno(patch)`. */
  campi: CampiFrequenza
  /**
   * Il nome che la scrittura di `alunni` mette in `classe_sezione`. Il trigger BEFORE ne ricava `section_id`; in fase B la
   * frequenza deve avere la stessa sezione, e il nome si risolve PRIMA. Il nome comanda su un `section_id` esplicito.
   */
  classeSezione?: string | null
  /** Le sezioni già lette per anno (un lotto non rilegge lo stesso anno per ogni alunno). */
  cacheSezioni?: Map<string, { id: string; name: string }[]>
}

const riuscitaDi = (r: unknown) => !(r as { error?: unknown } | null | undefined)?.error

/**
 * Scrive `alunni` (la callback `scrivi`) e la frequenza nell'ordine della fase in corso. NON LANCIA per la frequenza.
 *
 * `scrivi` fa la scrittura di `alunni` e ne restituisce il risultato com'è (`{ data, error }` di PostgREST): la fase A
 * chiama la frequenza solo se `riuscita(risultato)` (di default, senza `error`). La callback può non partire mai (fase B
 * con la frequenza fallita): chi chiama controlla `scritto`.
 */
export async function scriviAlunnoEFrequenza<T>(
  supabase: SupabaseClient,
  args: ArgomentiScritturaAlunno,
  scrivi: () => PromiseLike<T>,
  riuscita: (risultato: T) => boolean = riuscitaDi,
): Promise<EsitoScritturaAlunno<T>> {
  const { alunnoId, annoSedeId } = args
  // `annoSedeId` null = sede senza anno attivo o schema indietro (si scrive solo `alunni`), MA anche una lettura di
  // `anno_attivo` fallita: in fase B quest'ultima non può scrivere `alunni` senza frequenza (fail-closed).
  if (!annoSedeId && letturaAnnoFallita(supabase) && (await conFaseB(supabase))) {
    logErrore(
      { operazione: 'anno/fase-b:frequenza-non-scritta' },
      new Error(`frequenza-non-scritta:ANNO_ATTIVO_NON_LETTO:alunno=${alunnoId}`),
    )
    return { scritto: false, codice: 'SCRITTURA_FALLITA' }
  }
  const faseB = annoSedeId ? await conFaseB(supabase) : false

  if (!faseB || !annoSedeId) {
    // Fase A: come oggi. `alunni`, poi la frequenza (fail-open: l'esito non cambia la risposta).
    const risultato = await scrivi()
    if (annoSedeId && riuscita(risultato) && Object.keys(args.campi).length > 0) {
      await scriviFrequenza(supabase, { alunnoId, annoSedeId, campi: args.campi })
    }
    return { scritto: true, risultato }
  }

  // Fase B: prima la frequenza.
  const campi: CampiFrequenza = { ...args.campi }
  const classe = typeof args.classeSezione === 'string' ? args.classeSezione.trim() : ''
  if (classe !== '') {
    const s = await sezioneDelNome(supabase, annoSedeId, classe, args.cacheSezioni)
    if (!s.ok) return { scritto: false, codice: 'SCRITTURA_FALLITA' }
    campi.section_id = s.id
  }
  // `true` solo se la frequenza è stata davvero toccata: una scrittura saltata (anno non attivo, schema indietro) non
  // ha lasciato niente da raccontare.
  let frequenzaScritta = false
  if (Object.keys(campi).length > 0) {
    const esito = await scriviFrequenza(supabase, { alunnoId, annoSedeId, campi })
    if (!esito.ok) {
      // Un codice dell'anno l'ha già loggato `scriviFrequenza` (warn) e lo tradurrà `erroreAnno`; il resto è un guasto.
      if (!(CODICI_ANNO as readonly string[]).includes(esito.codice)) {
        logErrore(
          { operazione: 'anno/fase-b:frequenza-non-scritta' },
          new Error(`frequenza-non-scritta:${esito.codice}:alunno=${alunnoId}:anno_sede=${annoSedeId}`),
        )
      }
      return { scritto: false, codice: esito.codice }
    }
    frequenzaScritta = !('saltata' in esito)
  }
  const risultato = await scrivi()
  if (frequenzaScritta && !riuscita(risultato)) {
    // La frequenza è applicata (con la sua copia in `alunni`) e la scheda no: la finestra senza transazione. Solo uuid e
    // il codice di Postgres, mai il messaggio (può riportare la riga).
    const codice = (risultato as { error?: { code?: unknown } } | null | undefined)?.error?.code
    logErrore(
      { operazione: 'anno/fase-b:alunni-non-scritto' },
      new Error(
        `alunni-non-scritto-dopo-frequenza:${typeof codice === 'string' && /^[A-Za-z0-9]{3,10}$/.test(codice) ? codice : 'senza-codice'}`
        + `:alunno=${alunnoId}:anno_sede=${annoSedeId}`,
      ),
    )
    return { scritto: true, risultato, frequenzaGiaScritta: true }
  }
  return { scritto: true, risultato }
}

/**
 * La frequenza DOPO una scrittura di `alunni` già fatta, in fail-open: l'alunno esiste e non deve fallire per la frequenza.
 * Si usa solo dove la fase B non può passare dalla frequenza per prima:
 *  - dopo un INSERT (la FK obbliga a scrivere prima la scheda; la frequenza nasce dal trigger d'INSERT e qui si
 *    completano i campi che il trigger non conosce, come la data d'ingresso);
 *  - nel ramo di fase A di un lotto (un solo UPDATE per tutte le righe).
 * Restituisce l'esito, per chi vuole dirne di più. Senza anno o senza campi non scrive niente.
 */
export async function scriviFrequenzaDopoAlunni(
  supabase: SupabaseClient,
  { alunnoId, annoSedeId, campi }: { alunnoId: string; annoSedeId: string | null; campi: CampiFrequenza },
): Promise<EsitoFrequenza> {
  if (!annoSedeId || Object.keys(campi).length === 0) return { ok: true, saltata: 'nessun-campo' }
  return scriviFrequenza(supabase, { alunnoId, annoSedeId, campi })
}

/**
 * Un lotto in fase B: `n` righe NON scritte perché la frequenza è fallita (le altre sono andate avanti). Un evento solo
 * per lotto, coi soli numeri e codici; l'elenco degli uuid lo porta la risposta di chi chiama.
 */
export function segnalaRigheNonScritte(operazione: string, n: number): void {
  if (n > 0) logEvento('anno-scolastico', 'warn', { tipo: 'frequenza-non-scritta', n, operazione })
}
