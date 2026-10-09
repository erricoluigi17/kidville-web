import type { SupabaseClient } from '@supabase/supabase-js'
import { contaCosaDistrugge, type ConteggiOblio } from '@/lib/gdpr/cosa-distrugge'
import {
  BUCKET_ISCRIZIONI,
  obliaAllegatiChat,
  obliaCertificatiMediciAlunno,
  obliaFascicoloAlunno,
  obliaFotoAlunno,
  obliaIntentiVideoAlunno,
} from '@/lib/gdpr/esegui'
import { obliaFotoNewsAlunno } from '@/lib/news/permanenza-consenso'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { leggiRegistroPrimaria } from '@/lib/alunni/registro-primaria'
import { eAncoraIscritto } from '@/lib/alunni/stato'
import { normalizzaCodiceFiscale } from '@/lib/fiscale/validazione'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// ELIMINAZIONE DEFINITIVA — il motore della route `admin/students/elimina`.
//
// Tre pezzi, ognuno con un compito solo:
//  · `contaPerEliminazione` — SOLE `SELECT`: che cosa è collegato alla scheda.
//    Dove non riesce a leggere risponde `ok: false`, mai uno zero: davanti a
//    un'operazione senza annulla «non lo so» non può travestirsi da «niente».
//  · `scelteDisponibili` — pura: dai numeri alle scelte offerte, con il motivo.
//    È la tabella delle decisioni del titolare (2026-10-08), in un posto solo.
//  · `rimuoviFileAlunno` — i FILE, prima del database, con le stesse funzioni
//    dell'oblio (nessuna copia: `gdpr-erase-canale-unico`). Le pagelle non ci
//    sono perché il registro della primaria blocca l'eliminazione a monte.
// =============================================================================

export type SceltaEliminazione = 'elimina' | 'elimina_con_pagamenti' | 'anonimizza'

export type MotivoBloccoEliminazione =
  | 'REGISTRO_PRIMARIA_DA_CONSERVARE'
  | 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI'
  | 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI'
  | 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI'
  | 'ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA'

/**
 * I conteggi dell'oblio quando sono stati TUTTI misurati. In `ConteggiOblio`
 * `null` vuol dire «non l'ho potuto leggere»; qui quel caso è già uscito come
 * `ok: false`, quindi chi legge (la finestra) non deve più gestire `null`.
 */
export type ConteggiOblioMisurati = { [K in keyof ConteggiOblio]: number }

function tuttiMisurati(c: ConteggiOblio): c is ConteggiOblioMisurati {
  return Object.values(c).every((v) => typeof v === 'number')
}

export interface ConteggiEliminazione extends ConteggiOblioMisurati {
  presenze: number
  diario: number
  /**
   * I genitori DISTINTI legati alla scheda, nelle DUE tabelle che la funzione SQL
   * cancella: `student_parents` (anagrafica) e `legame_genitori_alunni` (account).
   * Una persona presente in tutte e due conta una volta (ponte: `parents.auth_user_id`).
   */
  legami_genitori: number
  pagamenti: number
  /**
   * I pagamenti BLOCCATI (ricevuta, fattura, voce viva in `fatture_coda`,
   * bonifico abbinato, incasso o quote di un altro alunno appese) PIÙ le
   * ricevute dell'alunno che non sono appese a un suo pagamento.
   */
  pagamenti_bloccati: number
  registro_primaria: boolean
  /**
   * Il codice fiscale della scheda è anche di un bambino che FREQUENTA nelle sedi
   * dell'operatore — come nella linguetta «Alunni»: non anonimizzato, con una
   * sezione, stato non «non più iscritto»? Allora questa è quasi certamente un
   * doppione, e presenze, diario e foto registrati qui appartengono al bambino
   * vero. Non blocca niente: è un avviso, detto PRIMA.
   */
  cf_condiviso_con_frequentante: boolean
}

export type EsitoMisura = { ok: true; conteggi: ConteggiEliminazione } | { ok: false }

/**
 * ⚠️ LE FOTO NON RIMOVIBILI tolgono le due eliminazioni, non l'anonimizzazione.
 * Sono foto in cui il bambino è l'unico ritratto ma il cui indirizzo non è
 * riconoscibile in questo archivio: `rimuoviFileAlunno` non le toglie, quindi
 * «elimina» finirebbe SEMPRE in `ALUNNO_ELIMINAZIONE_FILE_RESTANTI`, e riprovare
 * non servirebbe a niente. Offrirla sarebbe un comando che non funziona mai.
 * L'oblio invece le tollera (le lascia e lo dice): «anonimizza» resta come da
 * regole sui pagamenti. Il motivo: il registro vince su tutto; i pagamenti
 * bloccati vengono prima delle foto. Il motivo è UNO, ma la finestra le foto
 * non rimovibili le dice comunque, dal conteggio. ⚠️ Non c'è uno sblocco da
 * promettere: cancellarle dalla galleria le sposta nel cestino, che conteggio
 * ed esecuzione contano lo stesso. Il caso va all'assistenza.
 *
 * ⚠️ «ANONIMIZZA» SOLO PER UNA SCHEDA RITIRATA (`ritirato` = `eNonPiuIscritto`).
 * Un iscritto senza sezione non è uscito dalla scuola: anonimizzarlo lascerebbe
 * un bambino che frequenta senza nome né codice fiscale. Prima si ritira, poi si
 * anonimizza. Quando, tolta l'anonimizzazione, non resta nessuna scelta, il
 * motivo è `ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA`: è l'unico passo che la sblocca.
 */
export function scelteDisponibili(
  c: {
    pagamenti: number
    pagamenti_bloccati: number
    registro_primaria: boolean
    foto_non_rimovibili: number
  },
  ritirato: boolean,
): { scelte: Record<SceltaEliminazione, boolean>; motivo: MotivoBloccoEliminazione | null } {
  if (c.registro_primaria) {
    return {
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    }
  }
  const fotoBloccano = c.foto_non_rimovibili > 0
  if (c.pagamenti > 0 || c.pagamenti_bloccati > 0) {
    const bloccati = c.pagamenti_bloccati > 0
    const scelte = { elimina: false, elimina_con_pagamenti: !bloccati && !fotoBloccano, anonimizza: ritirato }
    if (!scelte.elimina_con_pagamenti && !scelte.anonimizza) {
      return { scelte, motivo: 'ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA' }
    }
    return {
      scelte,
      motivo: bloccati
        ? 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI'
        : fotoBloccano
          ? 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI'
          : 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    }
  }
  if (fotoBloccano) {
    return {
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI',
    }
  }
  return { scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false }, motivo: null }
}

async function conta(
  supabase: SupabaseClient,
  tabella: string,
  colonna: string,
  id: string,
  op: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from(tabella)
    .select(colonna, { count: 'exact', head: true })
    .eq(colonna, id)
  // ⚠️ Con `head: true` una richiesta HEAD non ha corpo: un 404 (tabella assente,
  // gateway) torna come `error: null, count: null`, e gli altri errori arrivano
  // senza `code`. `count === null` è quindi un GUASTO, mai uno zero
  // (postgrest-js 2.112, `dist/index.cjs:488-503`; misurato in revisione).
  if (error || count === null) {
    logErrore({ operazione: op, evento: `elimina_conta_${tabella}` }, error ?? { message: 'conteggio assente' })
    return null
  }
  return count
}

async function idsDove(
  supabase: SupabaseClient,
  tabella: string,
  colonnaId: string,
  colonnaFiltro: string,
  valori: string[],
  op: string,
): Promise<Set<string> | null> {
  // Nessun valore ⇒ nessuna query: un `in` con lista vuota su PostgREST è un
  // filtro che non filtra.
  if (valori.length === 0) return new Set()
  const { data, error } = await supabase.from(tabella).select(colonnaId).in(colonnaFiltro, valori)
  if (error) {
    logErrore({ operazione: op, evento: `elimina_blocchi_${tabella}` }, error)
    return null
  }
  return new Set(
    ((data ?? []) as unknown as Record<string, unknown>[])
      .map((r) => r[colonnaId])
      .filter((v): v is string => typeof v === 'string'),
  )
}

/**
 * Le tabelle in cui UNA riga qualunque rende un pagamento CONTABILITÀ VERA, cioè
 * non cancellabile. Non sono le sole condizioni: `contaPerEliminazione` aggiunge
 * la voce di `fatture_coda` in qualunque stato tranne `tolta` e le quote di un
 * altro alunno appese (`parent_payment_id`). Stessa regola della funzione SQL
 * `elimina_alunno_definitivo`, che la ricontrolla da sé dentro la transazione:
 * questa è l'anteprima, quella è la porta.
 */
const TABELLE_CHE_BLOCCANO_UN_PAGAMENTO = [
  'ricevute_emesse',
  'fatture_emesse',
  'riconciliazione_movimenti',
  'incassi',
] as const

/**
 * `sediOperatore` = le sedi di chi sta guardando (`scuoleDiUtente` nella route):
 * l'avviso doppione cerca SOLO lì, così non rivela niente di un'altra sede.
 * Obbligatorio di proposito: un chiamante che lo dimenticasse non deve compilare.
 */
export async function contaPerEliminazione(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
  sediOperatore: readonly string[],
): Promise<EsitoMisura> {
  const oblio = await contaCosaDistrugge(supabase, alunnoId, op)
  if (!tuttiMisurati(oblio)) return { ok: false }

  const presenze = await conta(supabase, 'presenze', 'alunno_id', alunnoId, op)
  const diario = await conta(supabase, 'eventi_diario', 'alunno_id', alunnoId, op)
  const legami = await genitoriDistinti(supabase, alunnoId, op)
  if (presenze === null || diario === null || legami === null) return { ok: false }

  const { data: pag, error: pagErr } = await supabase
    .from('pagamenti')
    .select('id')
    .eq('alunno_id', alunnoId)
  if (pagErr) {
    logErrore({ operazione: op, evento: 'elimina_conta_pagamenti' }, pagErr)
    return { ok: false }
  }
  const pagIds = ((pag ?? []) as { id: string }[]).map((p) => p.id)

  // Quali pagamenti sono contabilità vera: stessa regola della funzione SQL.
  const bloccati = new Set<string>()
  for (const tabella of TABELLE_CHE_BLOCCANO_UN_PAGAMENTO) {
    const ids = await idsDove(supabase, tabella, 'pagamento_id', 'pagamento_id', pagIds, op)
    if (ids === null) return { ok: false }
    ids.forEach((id) => bloccati.add(id))
  }
  // Una voce di `fatture_coda` ancora VIVA (ogni stato tranne `tolta`): `in_invio`
  // vuol dire che il file può essere già partito verso Aruba/SDI, `errore` è un
  // esito ambiguo, e la FK è in CASCADE — col pagamento la voce sparirebbe senza
  // traccia. Una voce `tolta` è già fuori dalla coda (`stato` è NOT NULL).
  if (pagIds.length > 0) {
    const { data: coda, error: codaErr } = await supabase
      .from('fatture_coda')
      .select('pagamento_id')
      .in('pagamento_id', pagIds)
      .neq('stato', 'tolta')
    if (codaErr) {
      logErrore({ operazione: op, evento: 'elimina_blocchi_fatture_coda' }, codaErr)
      return { ok: false }
    }
    for (const q of (coda ?? []) as { pagamento_id: string | null }[]) {
      if (q.pagamento_id) bloccati.add(q.pagamento_id)
    }
  }
  // Le quote di un ALTRO alunno appese a un suo pagamento: la cascata su
  // `parent_payment_id` le porterebbe via. `alunno_id` nullo conta come «altro»,
  // come `is distinct from` in SQL.
  if (pagIds.length > 0) {
    const { data: figli, error: figliErr } = await supabase
      .from('pagamenti')
      .select('parent_payment_id, alunno_id')
      .in('parent_payment_id', pagIds)
    if (figliErr) {
      logErrore({ operazione: op, evento: 'elimina_blocchi_quote' }, figliErr)
      return { ok: false }
    }
    for (const f of (figli ?? []) as { parent_payment_id: string | null; alunno_id: string | null }[]) {
      if (f.parent_payment_id && f.alunno_id !== alunnoId) bloccati.add(f.parent_payment_id)
    }
  }
  // Le ricevute dell'alunno che non stanno su un suo pagamento: in SQL ogni
  // ricevuta dell'alunno blocca, e quelle su un suo pagamento sono già contate
  // qui sopra come pagamento bloccato.
  const ricevuteSenzaPagamento = await supabase
    .from('ricevute_emesse')
    .select('id, pagamento_id')
    .eq('alunno_id', alunnoId)
  if (ricevuteSenzaPagamento.error) {
    logErrore({ operazione: op, evento: 'elimina_conta_ricevute' }, ricevuteSenzaPagamento.error)
    return { ok: false }
  }
  const orfane = ((ricevuteSenzaPagamento.data ?? []) as { pagamento_id: string | null }[]).filter(
    (r) => r.pagamento_id === null || !pagIds.includes(r.pagamento_id),
  ).length

  const registro = await leggiRegistroPrimaria(supabase, alunnoId)
  if (!registro.ok) {
    logErrore({ operazione: op, evento: 'elimina_registro_primaria' }, registro.errore)
    return { ok: false }
  }

  const doppione = await cfCondivisoConFrequentante(supabase, alunnoId, sediOperatore, op)
  if (doppione === null) return { ok: false }

  return {
    ok: true,
    conteggi: {
      ...oblio,
      presenze,
      diario,
      legami_genitori: legami,
      pagamenti: pagIds.length,
      pagamenti_bloccati: bloccati.size + orfane,
      registro_primaria: registro.presente,
      cf_condiviso_con_frequentante: doppione,
    },
  }
}

/** Solo lettere e cifre: il codice entra in un filtro `ilike`, dove `%` e `_` sono jolly. */
const CODICE_FISCALE_FILTRABILE = /^[A-Z0-9]+$/

type RigaDoppione = {
  id?: unknown
  codice_fiscale?: unknown
  fiscal_code?: unknown
  stato?: unknown
  section_id?: unknown
  anonimizzato_il?: unknown
}

/**
 * I genitori DISTINTI legati alla scheda. La funzione SQL cancella i legami in
 * DUE tabelle — `student_parents` (l'anagrafica: `parent_id` → `parents.id`) e
 * `legame_genitori_alunni` (gli account: `genitore_id` → `utenti.id`) — e
 * l'anteprima deve dire quanti genitori perdono il legame, non quante righe.
 * I due spazi di id si incontrano su `parents.auth_user_id`, che è l'id
 * dell'account: un genitore con l'account conta una volta, chi ha solo la
 * scheda anagrafica o solo l'account conta per sé.
 * `null` = una lettura non è riuscita: la misura diventa `ok: false`.
 */
async function genitoriDistinti(supabase: SupabaseClient, alunnoId: string, op: string): Promise<number | null> {
  const anagrafica = await supabase.from('student_parents').select('parent_id').eq('student_id', alunnoId)
  if (anagrafica.error) {
    logErrore({ operazione: op, evento: 'elimina_conta_student_parents' }, anagrafica.error)
    return null
  }
  const account = await supabase.from('legame_genitori_alunni').select('genitore_id').eq('alunno_id', alunnoId)
  if (account.error) {
    logErrore({ operazione: op, evento: 'elimina_conta_legame_genitori_alunni' }, account.error)
    return null
  }
  const idParents = [
    ...new Set(
      ((anagrafica.data ?? []) as { parent_id?: unknown }[])
        .map((r) => r.parent_id)
        .filter((v): v is string => typeof v === 'string'),
    ),
  ]
  const persone = new Set<string>()
  if (idParents.length > 0) {
    const schede = await supabase.from('parents').select('id, auth_user_id').in('id', idParents)
    if (schede.error) {
      logErrore({ operazione: op, evento: 'elimina_conta_parents' }, schede.error)
      return null
    }
    const accountDi = new Map(
      ((schede.data ?? []) as { id?: unknown; auth_user_id?: unknown }[])
        .filter((r): r is { id: string; auth_user_id?: unknown } => typeof r.id === 'string')
        .map((r) => [r.id, typeof r.auth_user_id === 'string' ? r.auth_user_id : null] as const),
    )
    for (const id of idParents) persone.add(accountDi.get(id) ?? `scheda:${id}`)
  }
  for (const r of (account.data ?? []) as { genitore_id?: unknown }[]) {
    if (typeof r.genitore_id === 'string') persone.add(r.genitore_id)
  }
  return persone.size
}

/**
 * L'AVVISO DOPPIONE. Misurato in produzione: fra i non iscritti c'è una scheda
 * con lo stesso codice fiscale di un bambino che frequenta. Eliminarla porta via
 * presenze e diario registrati per sbaglio su di lei — cioè del bambino vero.
 *
 * Stesso schema della verifica delle chiavi dell'oblio (`codiceFiscaleDiAltri`):
 * si cerca per sottostringa (`ilike '%CF%'`, la colonna è `character(16)` e
 * torna impaginata) e si decide in TS confrontando il codice normalizzato.
 * «Frequenta» è `eAncoraIscritto`: iscritto, sospeso o stato vuoto.
 *
 * `null` = non si è potuto sapere: la misura diventa `ok: false`, come ogni
 * altra lettura fallita. Un avviso taciuto per un guasto sarebbe un «no» falso.
 */
async function cfCondivisoConFrequentante(
  supabase: SupabaseClient,
  alunnoId: string,
  sediOperatore: readonly string[],
  op: string,
): Promise<boolean | null> {
  // Nessuna sede: nessun confronto possibile. E niente `in` con lista vuota, che
  // su PostgREST è un filtro che non filtra.
  if (sediOperatore.length === 0) return false
  const { data: scheda, error } = await supabase
    .from('alunni')
    .select('codice_fiscale, fiscal_code')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) {
    logErrore({ operazione: op, evento: 'elimina_doppione_scheda' }, error)
    return null
  }
  const riga = (scheda ?? {}) as RigaDoppione
  const codici = [...new Set([normalizzaCodiceFiscale(riga.codice_fiscale), normalizzaCodiceFiscale(riga.fiscal_code)])]
    .filter((cf) => cf !== '')
  for (const cf of codici) {
    if (!CODICE_FISCALE_FILTRABILE.test(cf)) {
      // Un valore con caratteri che non sono lettere o cifre non è un codice
      // fiscale: non identifica un doppione, e dentro un filtro cambierebbe la
      // query. Si salta, e lo si dice.
      logEvento('gdpr', 'info', {
        operazione: op,
        esito: 'elimina-doppione-cf-non-filtrabile',
        entita_tipo: 'alunni',
        entita_id: alunnoId,
      })
      continue
    }
    for (const colonna of ['codice_fiscale', 'fiscal_code'] as const) {
      const { data, error: altriErr } = await supabase
        .from('alunni')
        .select('id, codice_fiscale, fiscal_code, stato, section_id, anonimizzato_il')
        .in('scuola_id', [...sediOperatore])
        .is('anonimizzato_il', null)
        .ilike(colonna, `%${cf}%`)
      if (altriErr) {
        logErrore({ operazione: op, evento: 'elimina_doppione_altri' }, altriErr)
        return null
      }
      const frequentante = ((data ?? []) as RigaDoppione[]).some(
        (r) =>
          r.id !== alunnoId &&
          r.anonimizzato_il == null &&
          // «Frequenta» come nella linguetta Alunni: una sezione E uno stato non
          // ritirato. Due schede senza sezione sono due «non iscritti».
          r.section_id != null &&
          eAncoraIscritto(typeof r.stato === 'string' ? r.stato : null) &&
          (normalizzaCodiceFiscale(r.codice_fiscale) === cf || normalizzaCodiceFiscale(r.fiscal_code) === cf),
      )
      if (frequentante) return true
    }
  }
  return false
}

export interface EsitoFileAlunno {
  ok: boolean
  numeri: {
    foto_rimosse: number
    foto_sganciate: number
    news_ritirate: number
    /** File del blog che RESTANO perché un altro articolo, che non dichiara il bambino, li usa ancora. */
    news_trattenuti: number
    certificati: number
    fascicolo: number
    allegati_chat: number
    /**
     * Quanti documenti d'identità sono usciti dal bucket (0 o 1).
     *
     * ⚠️ NON si chiama `documento`: questi numeri finiscono in `valoreDopo` del
     * registro delle scritture, e `riduciValoreAudit` (`src/lib/audit/riassunto.ts`)
     * riduce la chiave `documento` a `[non registrato]` a QUALUNQUE profondità —
     * perché altrove sotto quel nome viaggia il documento stesso. Col nome corto,
     * la traccia dell'eliminazione perdeva in silenzio il solo numero che dice se
     * il documento è stato tolto.
     */
    documenti_rimossi: number
    /** 1 se il documento d'identità lo nomina anche un'altra scheda o una domanda d'iscrizione: allora non si toglie. */
    documento_condiviso: number
    restanti: number
  }
}

const NUMERI_ZERO: EsitoFileAlunno['numeri'] = {
  foto_rimosse: 0,
  foto_sganciate: 0,
  news_ritirate: 0,
  news_trattenuti: 0,
  certificati: 0,
  fascicolo: 0,
  allegati_chat: 0,
  documenti_rimossi: 0,
  documento_condiviso: 0,
  restanti: 0,
}

/**
 * Qualcun ALTRO nomina lo stesso documento d'identità? Un altro alunno, un
 * genitore o una domanda d'iscrizione. `null` = non si è potuto sapere.
 *
 * Un file che non è solo suo non è suo da togliere. Due casi:
 *  · il DOPPIONE: la scheda nata da un refuso copia il `documento_path` del
 *    bambino vero, e togliere il file eliminando il doppione lascerebbe la scheda
 *    vera senza documento;
 *  · la DOMANDA D'ISCRIZIONE, che per decisione del titolare resta in Iscrizioni
 *    con il suo allegato. Misurato in produzione il 2026-10-09: 243 alunni su 243
 *    con `documento_path` hanno lo STESSO file allegato alla loro domanda. In
 *    pratica, quindi, il documento resta con la domanda e se ne va col ciclo di
 *    vita della domanda (la retention delle iscrizioni, o l'oblio) — non con
 *    l'eliminazione della scheda.
 *
 * Le domande si cercano con lo stesso filtro dell'oblio (`obliaIscrizioni`,
 * `src/lib/gdpr/esegui.ts`): contenimento JSONB per ramo, `children` e `adults`.
 *
 * ⚠️ NESSUNA TOLLERANZA PER LO SCHEMA ASSENTE, a differenza dell'oblio.
 * `enrollment_submissions` è nella baseline: esiste in produzione e sul DB della
 * CI. Se risponde «tabella assente» (`42P01`/`PGRST205`) è un guasto, e
 * trattarlo come «nessuna domanda» porterebbe a togliere il file che la domanda
 * conserva. Ogni errore, qui come su `alunni` e `parents`, vale «non lo so».
 */
async function documentoCondiviso(
  supabase: SupabaseClient,
  alunnoId: string,
  percorso: string,
  op: string,
): Promise<boolean | null> {
  const altriAlunni = await supabase
    .from('alunni')
    .select('id')
    .eq('documento_path', percorso)
    .neq('id', alunnoId)
    .limit(1)
  if (altriAlunni.error || !Array.isArray(altriAlunni.data)) {
    logErrore(
      { operazione: op, evento: 'elimina_documento_condiviso_alunni' },
      altriAlunni.error ?? { message: 'risposta senza righe' },
    )
    return null
  }
  if (altriAlunni.data.length > 0) return true

  const genitori = await supabase.from('parents').select('id').eq('documento_path', percorso).limit(1)
  if (genitori.error || !Array.isArray(genitori.data)) {
    logErrore(
      { operazione: op, evento: 'elimina_documento_condiviso_genitori' },
      genitori.error ?? { message: 'risposta senza righe' },
    )
    return null
  }
  if (genitori.data.length > 0) return true

  for (const ramo of ['children', 'adults'] as const) {
    const domande = await supabase
      .from('enrollment_submissions')
      .select('id')
      .contains('data', { [ramo]: [{ documento_path: percorso }] })
      .limit(1)
    if (domande.error || !Array.isArray(domande.data)) {
      logErrore(
        { operazione: op, evento: 'elimina_documento_condiviso_domande' },
        domande.error ?? { message: 'risposta senza righe' },
      )
      return null
    }
    if (domande.data.length > 0) return true
  }
  return false
}

/**
 * Toglie i FILE del bambino, PRIMA del database. `ok: false` se anche un solo
 * file non è uscito o un inventario non si è potuto leggere: allora la route si
 * ferma e la scheda resta intatta.
 *
 * PRIMA LE LETTURE, POI I GESTI. I thread della chat e il controllo sul
 * documento condiviso si leggono in cima: se una di queste letture fallisce si
 * risponde `ok: false` senza aver tolto nessun file — una rimozione a metà su
 * una scheda che poi resta in piedi è il peggiore dei due mondi.
 *
 * Dal blog pubblico contano `fileNonRimossi` e non `fileTrattenuti`, come
 * nell'oblio (`anonimizzaAlunno`): un file «trattenuto» resta perché un ALTRO
 * articolo, che questo bambino non lo dichiara, lo nomina ancora — nessun nuovo
 * tentativo lo toglierebbe, e `obliaFotoNewsAlunno` lo logga già a livello
 * `error`. Si restituisce in `news_trattenuti`, perché la route possa dirlo.
 */
export async function rimuoviFileAlunno(
  supabase: SupabaseClient,
  alunno: { id: string; documento_path?: string | null },
  op: string,
): Promise<EsitoFileAlunno> {
  // ── LE LETTURE ──
  const { data: thread, error: threadErr } = await supabase
    .from('chat_threads')
    .select('id')
    .eq('student_id', alunno.id)
  if (threadErr) {
    logErrore({ operazione: op, evento: 'elimina_thread_chat' }, threadErr)
    return { ok: false, numeri: { ...NUMERI_ZERO } }
  }
  const threadIds = ((thread ?? []) as { id: string }[]).map((t) => t.id)

  const percorsoDocumento = (alunno.documento_path ?? '').trim()
  let condiviso = false
  if (percorsoDocumento) {
    const esito = await documentoCondiviso(supabase, alunno.id, percorsoDocumento, op)
    if (esito === null) return { ok: false, numeri: { ...NUMERI_ZERO } }
    condiviso = esito
    if (condiviso) {
      logEvento('gdpr', 'warn', {
        operazione: op,
        esito: 'elimina-documento-condiviso',
        entita_tipo: 'alunni',
        entita_id: alunno.id,
        msg: `${op}: il documento d'identità è nominato anche da un'altra scheda o da una domanda d'iscrizione, quindi resta nell'archivio`,
      })
    }
  }

  // ── I GESTI ──
  const foto = await obliaFotoAlunno(supabase, alunno.id, op)
  const news = await obliaFotoNewsAlunno(supabase, alunno.id, op)
  const video = await obliaIntentiVideoAlunno(supabase, alunno.id, op)
  const certificati = await obliaCertificatiMediciAlunno(supabase, alunno.id, op)
  const fascicolo = await obliaFascicoloAlunno(supabase, alunno.id, op)
  const chat = await obliaAllegatiChat(supabase, threadIds, op)

  const documento = await rimuoviEVerifica(
    supabase,
    BUCKET_ISCRIZIONI,
    percorsoDocumento && !condiviso ? [percorsoDocumento] : [],
    op,
  )
  const documentoRestanti = bloccanti(documento).length + (documento.erroreRimozione ? 1 : 0)

  const restanti =
    foto.fileNonRimossi +
    news.fileNonRimossi +
    certificati.nonRimossi +
    fascicolo.nonRimossi +
    chat.nonRimossi +
    documentoRestanti
  const tuttoLetto = foto.letto && news.letto && video.letto && certificati.letto && fascicolo.letto && chat.letto

  return {
    ok: tuttoLetto && restanti === 0,
    numeri: {
      foto_rimosse: foto.fotoRimosse,
      foto_sganciate: foto.fotoSganciate,
      news_ritirate: news.ritirati,
      news_trattenuti: news.fileTrattenuti,
      certificati: certificati.rimossi,
      fascicolo: fascicolo.rimossi,
      allegati_chat: chat.rimossi,
      documenti_rimossi: documento.rimossi.length,
      documento_condiviso: condiviso ? 1 : 0,
      restanti,
    },
  }
}
