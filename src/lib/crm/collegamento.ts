import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formaConfronto } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { logEvento } from '@/lib/logging/logger'
import { agganciaAlunno, alunnoDaDomandaImportata } from './aggancio-alunno'
import { contattiNormalizzati } from './contatti'
import { rispostaErroreDb } from './errori'
import { registraEvento } from './eventi'
import { nomiSiSomigliano } from './nomi'
import type { BambinoRow } from './tipi'

/**
 * CRM DELLA SEGRETERIA · IL COLLEGAMENTO CON LE DOMANDE DI ISCRIZIONE.
 *
 * Quando una famiglia che la segreteria ha già in scheda compila la domanda vera (`enrollment_submissions`),
 * il CRM deve accorgersene da solo: il bambino diventa «iscritto» e la scheda ricorda QUALE domanda lo
 * ha iscritto. Questo file è l'unico punto che lo fa, per tre strade: la domanda che arriva (automatico),
 * la segreteria che sceglie a mano (`collegaAMano`, `scollega`) e le domande che cambiano vita (respinte,
 * cancellate).
 *
 * ─── TRE REGOLE CHE NON SI DEROGANO ─────────────────────────────────────────────────────────────────
 *
 * 1. **`enrollment_submissions` contiene dati VERI di minori** (codici fiscali, allergie, note mediche).
 *    Da una domanda si legge SOLO ciò che serve ad abbinare: i recapiti degli adulti (email e telefoni,
 *    normalizzati con `contatti.ts`), nome, cognome e data di nascita dei figli. Niente di tutto questo
 *    entra in un log: nei log passano gli uuid, i conteggi e i codici d'esito, e basta.
 *
 * 2. **Il modulo pubblico non si rompe MAI per colpa del CRM.** Le tre funzioni che i percorsi delle domande
 *    chiamano (`collegaDomandaAlCrm`, `segnalaDomandaRespinta`, `segnalaDomandeCancellate`) non lanciano
 *    mai: ogni guasto — tabella assente, errore del database, client che lancia — diventa una riga di log
 *    e un esito, mai un'eccezione. Se le tabelle `crm_*` non esistono (il database E2E della CI non è
 *    migrato) fanno `non_installato` e non toccano niente.
 *
 * 3. **Una domanda si collega solo a schede della SUA sede.** Vale in tutte le strade: la ricerca delle
 *    schede, ogni `update` e ogni lettura portano `scuola_id` nella STESSA istruzione, e le righe tornate
 *    vengono ricontrollate in codice. La coincidenza di un telefono con una scheda di un'altra sede NON
 *    collega niente: lascia una riga di log senza dati (`coincidenza-altra-sede`) e basta.
 *
 * ─── E DOPO IL COLLEGAMENTO: L'ALUNNO ────────────────────────────────────────────────────────────────
 * Se la domanda collegata era GIÀ stata importata, l'alunno esiste già e l'import non ripasserà di qui:
 * `agganciaSeImportata` lo ritrova fra quelli che l'import ha creato per quella domanda e collega il bambino
 * (è l'aggancio che fa passare la quota in contabilità). Vale per il collegamento automatico e per quello a
 * mano. È un di più rispetto al collegamento: non ne cambia mai l'esito, e un guasto qui è una riga di log.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tipi
// ─────────────────────────────────────────────────────────────────────────────

export interface FiglioDomanda {
  /** La posizione del figlio dentro `data.children` della domanda (da 0). È ciò che si salva in `domanda_figlio`. */
  indice: number
  nome: string | null
  cognome: string | null
  /** `yyyy-mm-dd`, già normalizzata; `null` se la domanda non ce l'ha o non è leggibile. */
  dataNascita: string | null
}

export type EsitoCollegamento =
  | { esito: 'nessuna_scheda' | 'errore' | 'non_installato' }
  | { esito: 'collegato'; schedaId: string; bambini: number }
  | { esito: 'da_associare'; schedaIds: string[] }
  /**
   * ⚠️ Aggiunta rispetto al piano (che nominava solo i tre esiti sopra): il bambino che la domanda
   * indicherebbe ha già un'ALTRA domanda. Non è «da associare» (niente da scegliere) e non è «collegato»
   * (niente è stato collegato): la segreteria lo vede come nota sul bambino e come riga di storico.
   */
  | { esito: 'altra_domanda'; schedaId: string }

type Estratto = {
  figli: FiglioDomanda[]
  /** Le stringhe come sono scritte nella domanda: le normalizza chi le usa. */
  telefoni: string[]
  email: string[]
  /** Nome e cognome del primo adulto che li ha scritti, per mostrarlo nell'elenco delle domande. */
  genitore: string | null
}

const TABELLA_ASSENTE = new Set(['PGRST205', '42P01'])
const MESI_VALIDITA_SCHEDA = 12
const ESITI_APERTI = ['aperto', 'ci_pensa', 'lista_attesa']
/** Quanti id per volta in un `.in()`: l'URL di PostgREST ha un tetto, e una conservazione può cancellare molte domande. */
const BLOCCO_ID = 100

const OP_AUTO = 'crm/collegamento:collegaDomandaAlCrm'
const OP_RESPINTA = 'crm/collegamento:segnalaDomandaRespinta'
const OP_CANCELLATE = 'crm/collegamento:segnalaDomandeCancellate'
const OP_MANO = 'crm/collegamento:collegaAMano'
const OP_SCOLLEGA = 'crm/collegamento:scollega'

// ─────────────────────────────────────────────────────────────────────────────
// Funzioni pure: leggere una domanda e abbinare i figli
// ─────────────────────────────────────────────────────────────────────────────

function oggetto(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function testo(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** `yyyy-mm-dd` (anche con l'ora in coda) oppure `gg/mm/aaaa`, `gg-mm-aaaa`, `gg.mm.aaaa` → `yyyy-mm-dd`; il resto `null`. */
export function dataIso(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  let anno: number
  let mese: number
  let giorno: number
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(s)
  const it = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (iso) {
    anno = Number(iso[1])
    mese = Number(iso[2])
    giorno = Number(iso[3])
  } else if (it) {
    giorno = Number(it[1])
    mese = Number(it[2])
    anno = Number(it[3])
  } else {
    return null
  }
  const d = new Date(Date.UTC(anno, mese - 1, giorno))
  if (d.getUTCFullYear() !== anno || d.getUTCMonth() !== mese - 1 || d.getUTCDate() !== giorno) return null
  return `${String(anno).padStart(4, '0')}-${String(mese).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`
}

/**
 * Da `enrollment_submissions.data` prende SOLO ciò che serve al collegamento. Un jsonb malformato non
 * lancia: dà liste vuote (la funzione gira dentro il modulo pubblico).
 */
export function estraiDaDomanda(data: unknown): Estratto {
  const radice = oggetto(data)
  const figli: FiglioDomanda[] = []
  const telefoni: string[] = []
  const email: string[] = []
  let genitore: string | null = null

  const bambini = radice && Array.isArray(radice.children) ? radice.children : []
  bambini.forEach((c, indice) => {
    const f = oggetto(c)
    if (!f) return
    figli.push({
      indice,
      nome: testo(f.nome),
      cognome: testo(f.cognome),
      dataNascita: dataIso(f.data_nascita),
    })
  })

  const adulti = radice && Array.isArray(radice.adults) ? radice.adults : []
  for (const a of adulti) {
    const adulto = oggetto(a)
    if (!adulto) continue
    if (typeof adulto.phone === 'string' && adulto.phone.trim() !== '') telefoni.push(adulto.phone)
    if (typeof adulto.email === 'string' && adulto.email.trim() !== '') email.push(adulto.email)
    if (genitore === null) {
      const nome = [testo(adulto.first_name), testo(adulto.last_name)].filter(Boolean).join(' ')
      if (nome !== '') genitore = nome
    }
  }
  return { figli, telefoni, email, genitore }
}

type BambinoPerAbbinare = Pick<BambinoRow, 'id' | 'nome' | 'data_nascita' | 'domanda_id'>

function siAbbinano(b: BambinoPerAbbinare, f: FiglioDomanda): boolean {
  const dataB = dataIso(b.data_nascita)
  const dataF = dataIso(f.dataNascita)
  // Con le due date, decidono loro: due fratelli hanno lo stesso cognome e a volte lo stesso nome di battesimo.
  if (dataB && dataF) return dataB === dataF
  // Senza una delle due, basta una parola di tre lettere in comune nel NOME del figlio. Mai il cognome:
  // lo condividono i fratelli, e «Bimba Prova» non deve prendersi «Bimbo Prova».
  return nomiSiSomigliano(b.nome, f.nome)
}

/**
 * Quali bambini della scheda sono quali figli della domanda. Abbina solo se è CERTO, cioè uno-a-uno:
 * se un bambino somiglia a due figli, o un figlio a due bambini, l'intera domanda è `ambiguo` e non si
 * abbina nessuno — meglio una scelta della segreteria che un bambino iscritto con la domanda del
 * fratello. Un bambino della scheda che nella domanda non c'è resta semplicemente fuori. I bambini già
 * collegati a una domanda non partecipano.
 */
export function abbinaFigli(
  bambini: BambinoPerAbbinare[],
  figli: FiglioDomanda[],
): { coppie: { bambinoId: string; figlio: number }[]; ambiguo: boolean } {
  const perBambino = new Map<string, number[]>()
  const perFiglio = new Map<number, string[]>()
  for (const b of bambini) {
    if (b.domanda_id != null) continue
    for (const f of figli) {
      if (!siAbbinano(b, f)) continue
      perBambino.set(b.id, [...(perBambino.get(b.id) ?? []), f.indice])
      perFiglio.set(f.indice, [...(perFiglio.get(f.indice) ?? []), b.id])
    }
  }
  const conflitto =
    [...perBambino.values()].some((l) => l.length > 1) || [...perFiglio.values()].some((l) => l.length > 1)
  if (conflitto) return { coppie: [], ambiguo: true }
  const coppie = [...perBambino].map(([bambinoId, [figlio]]) => ({ bambinoId, figlio }))
  return { coppie, ambiguo: coppie.length === 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Piccoli attrezzi
// ─────────────────────────────────────────────────────────────────────────────

function codiceDi(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

function stessaSede(a: unknown, b: string): boolean {
  return typeof a === 'string' && formaConfronto(a) === formaConfronto(b)
}

/** Il battito del collegamento: UNA riga per ogni esito, con l'id della domanda e basta. */
function battito(esito: string, domandaId: string, extra: Record<string, string | number | boolean> = {}): void {
  logEvento('crm', 'info', { esito, entita_id: domandaId, ...extra })
}

/** Dall'eccezione all'esito: tabella assente = `non_installato` (warn), qualunque altra cosa = `errore` (error). */
function esitoDaEccezione(err: unknown, domandaId: string, operazione: string): EsitoCollegamento {
  if (TABELLA_ASSENTE.has(codiceDi(err))) {
    logEvento('crm', 'warn', { operazione, esito: 'schema-crm-assente', entita_id: domandaId }, err)
    return { esito: 'non_installato' }
  }
  logEvento('crm', 'error', { operazione, esito: 'errore', entita_id: domandaId }, err)
  return { esito: 'errore' }
}

/**
 * Dopo un collegamento riuscito: se la domanda era già stata importata, il bambino si aggancia all'alunno che
 * l'import ha creato per lei (`eseguitoDa`: chi ha collegato; `null` nel collegamento automatico). Cerca e
 * aggancia solo se l'alunno è UNO: nessuno o più d'uno resta da collegare a mano dalla scheda.
 *
 * **Non lancia MAI** e non cambia l'esito del collegamento: le due funzioni che chiama non lanciano, ma questa
 * è anche l'ultima difesa del modulo pubblico (un `catch` che logga, mai che inghiotte).
 */
async function agganciaSeImportata(
  supabase: SupabaseClient,
  p: { domandaId: string; sede: string; bambino: Pick<BambinoRow, 'id' | 'nome' | 'data_nascita'>; eseguitoDa: string | null; operazione: string },
): Promise<void> {
  try {
    const alunnoId = await alunnoDaDomandaImportata(supabase, {
      domandaId: p.domandaId,
      scuolaId: p.sede,
      nome: p.bambino.nome ?? null,
      dataNascita: p.bambino.data_nascita ?? null,
    })
    if (alunnoId) await agganciaAlunno(supabase, p.bambino.id, alunnoId, p.eseguitoDa)
  } catch (err) {
    logEvento('crm', 'error', { operazione: p.operazione, esito: 'aggancio-dopo-collegamento-non-riuscito', entita_id: p.domandaId }, err)
  }
}

// ⚠️ Il `codice` di ogni risposta è un LETTERALE nel punto in cui la risposta nasce: il lock
// `errori-con-codice` lo legge dal sorgente per verificare che sia in `CODICI_ERRORE` e tradotto nelle due lingue.
const schedaNonTrovata = () =>
  NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
const domandaNonApribile = (stato: number, messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: 'DOMANDA_NON_APRIBILE' }, { status: stato })
const statoNonAmmesso = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: 'STATO_NON_AMMESSO' }, { status: 409 })

type BambinoLetto = Pick<
  BambinoRow,
  'id' | 'scheda_id' | 'scuola_id' | 'nome' | 'data_nascita' | 'esito' | 'domanda_id'
>
const COLONNE_BAMBINO = 'id, scheda_id, scuola_id, nome, data_nascita, esito, domanda_id'

async function bambiniDelleSchede(supabase: SupabaseClient, sede: string, schedaIds: string[]): Promise<BambinoLetto[]> {
  const { data, error } = await supabase
    .from('crm_bambini')
    .select(COLONNE_BAMBINO)
    .eq('scuola_id', sede)
    .in('scheda_id', schedaIds)
  if (error) throw error
  // Doppio controllo in codice: una riga di un'altra sede non entra mai nell'abbinamento.
  return ((data ?? []) as BambinoLetto[]).filter((b) => stessaSede(b.scuola_id, sede))
}

// ─────────────────────────────────────────────────────────────────────────────
// Il collegamento automatico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una domanda è appena arrivata: se la famiglia è già in scheda, il bambino diventa iscritto.
 * **Non lancia MAI.** Vedi la testata per le regole; gli esiti sono nel tipo `EsitoCollegamento`.
 */
export async function collegaDomandaAlCrm(supabase: SupabaseClient, domandaId: string): Promise<EsitoCollegamento> {
  try {
    return await eseguiCollegamento(supabase, domandaId)
  } catch (err) {
    return esitoDaEccezione(err, domandaId, OP_AUTO)
  }
}

async function eseguiCollegamento(supabase: SupabaseClient, domandaId: string): Promise<EsitoCollegamento> {
  const { data: dom, error: eDom } = await supabase
    .from('enrollment_submissions')
    .select('id, scuola_id, status, data')
    .eq('id', domandaId)
    .maybeSingle()
  if (eDom) throw eDom
  if (!dom) {
    logEvento('crm', 'error', { operazione: OP_AUTO, esito: 'domanda-non-trovata', entita_id: domandaId })
    return { esito: 'errore' }
  }

  const sede = typeof dom.scuola_id === 'string' && dom.scuola_id !== '' ? dom.scuola_id : null
  if (!sede) {
    battito('domanda-senza-sede', domandaId)
    return { esito: 'nessuna_scheda' }
  }
  const rifiutata = dom.status === 'rejected'

  const { figli, telefoni, email } = estraiDaDomanda(dom.data)
  const norm = contattiNormalizzati({ telefoni, email })
  if (norm.telefoni_norm.length === 0 && norm.email_norm.length === 0) {
    battito('senza-contatti', domandaId, { scuola_id: sede })
    return { esito: 'nessuna_scheda' }
  }

  // Idempotenza: la stessa domanda lanciata due volte (un riprova, una corsa) non duplica niente.
  const { data: gia, error: eGia } = await supabase
    .from('crm_bambini')
    .select('id, scheda_id, scuola_id, domanda_id')
    .eq('domanda_id', domandaId)
    .eq('scuola_id', sede)
  if (eGia) throw eGia
  const giaCollegati = (gia ?? []).filter((r) => r.domanda_id === domandaId && stessaSede(r.scuola_id, sede))
  if (giaCollegati.length > 0) {
    battito('gia-collegata', domandaId, { scuola_id: sede, n_bambini: giaCollegati.length })
    return { esito: 'collegato', schedaId: giaCollegati[0].scheda_id as string, bambini: giaCollegati.length }
  }

  const candidate = await schedeDellaSedeConContatto(supabase, sede, norm)
  if (candidate.length === 0) {
    if (await esisteInAltraSede(supabase, sede, norm, domandaId)) {
      // Nessun dato: né il telefono, né la scheda, né la sede dell'altra famiglia.
      logEvento('crm', 'info', { esito: 'coincidenza-altra-sede', entita_id: domandaId })
    } else {
      battito('nessuna-scheda', domandaId, { scuola_id: sede })
    }
    return { esito: 'nessuna_scheda' }
  }

  const bambini = await bambiniDelleSchede(supabase, sede, candidate.map((s) => s.id))
  const limite = new Date()
  limite.setMonth(limite.getMonth() - MESI_VALIDITA_SCHEDA)
  const eleggibili = candidate.filter(
    (s) =>
      new Date(s.creata_il) >= limite ||
      bambini.some((b) => b.scheda_id === s.id && ESITI_APERTI.includes(b.esito)),
  )
  if (eleggibili.length === 0) {
    battito('nessuna-scheda', domandaId, { scuola_id: sede })
    return { esito: 'nessuna_scheda' }
  }

  // Più di una scheda con quel contatto: non si indovina, sceglie la segreteria.
  if (eleggibili.length > 1) {
    const schedaIds = eleggibili.map((s) => s.id)
    await segnalaDaAssociare(supabase, sede, domandaId, schedaIds)
    battito('da-associare', domandaId, { scuola_id: sede, n_schede: schedaIds.length })
    return { esito: 'da_associare', schedaIds }
  }

  const schedaId = eleggibili[0].id
  const dellaScheda = bambini.filter((b) => b.scheda_id === schedaId)
  const abbinamento = abbinaFigli(dellaScheda, figli)

  if (!abbinamento.ambiguo) {
    const { collegati, conflitti } = await collegaCoppie(supabase, {
      domandaId,
      sede,
      schedaId,
      rifiutata,
      bambini: dellaScheda,
      coppie: abbinamento.coppie,
    })
    if (collegati > 0) {
      battito('collegato', domandaId, { scuola_id: sede, n_bambini: collegati })
      return { esito: 'collegato', schedaId, bambini: collegati }
    }
    if (conflitti.length > 0) {
      await segnalaAltraDomanda(supabase, { sede, schedaId, domandaId, bambiniIds: conflitti })
      battito('altra-domanda', domandaId, { scuola_id: sede, n_bambini: conflitti.length })
      return { esito: 'altra_domanda', schedaId }
    }
    // Zero righe toccate e nessun conflitto: qualcuno ha collegato quel bambino un attimo fa. Si chiede alla segreteria.
  } else {
    // Nessun bambino libero si abbina con certezza. Se la domanda parla di un bambino che ha già un'ALTRA
    // domanda, non c'è niente da scegliere: si annota e basta.
    const conTutti = abbinaFigli(
      dellaScheda.map((b) => ({ ...b, domanda_id: null })),
      figli,
    )
    const giaConAltra = conTutti.ambiguo
      ? []
      : conTutti.coppie
          .map((c) => dellaScheda.find((b) => b.id === c.bambinoId))
          .filter((b): b is BambinoLetto => !!b && b.domanda_id != null && b.domanda_id !== domandaId)
    if (giaConAltra.length > 0) {
      await segnalaAltraDomanda(supabase, { sede, schedaId, domandaId, bambiniIds: giaConAltra.map((b) => b.id) })
      battito('altra-domanda', domandaId, { scuola_id: sede, n_bambini: giaConAltra.length })
      return { esito: 'altra_domanda', schedaId }
    }
  }

  await segnalaDaAssociare(supabase, sede, domandaId, [schedaId])
  battito('da-associare', domandaId, { scuola_id: sede, n_schede: 1 })
  return { esito: 'da_associare', schedaIds: [schedaId] }
}

async function schedeDellaSedeConContatto(
  supabase: SupabaseClient,
  sede: string,
  norm: { telefoni_norm: string[]; email_norm: string[] },
): Promise<{ id: string; creata_il: string }[]> {
  const trovate = new Map<string, { id: string; creata_il: string }>()
  for (const [colonna, valori] of [
    ['telefoni_norm', norm.telefoni_norm],
    ['email_norm', norm.email_norm],
  ] as const) {
    if (valori.length === 0) continue
    const { data, error } = await supabase
      .from('crm_schede')
      .select('id, scuola_id, creata_il')
      .eq('scuola_id', sede)
      .is('anonimizzata_il', null)
      .overlaps(colonna, [...valori])
    if (error) throw error
    for (const r of data ?? []) {
      if (stessaSede(r.scuola_id, sede)) trovate.set(r.id as string, { id: r.id as string, creata_il: r.creata_il as string })
    }
  }
  return [...trovate.values()]
}

/**
 * La stessa ricerca, ma sulle ALTRE sedi: serve soltanto a lasciare la riga di log «coincidenza-altra-sede».
 * Non restituisce né tiene niente di quelle schede, e un guasto qui non cambia l'esito.
 */
async function esisteInAltraSede(
  supabase: SupabaseClient,
  sede: string,
  norm: { telefoni_norm: string[]; email_norm: string[] },
  domandaId: string,
): Promise<boolean> {
  try {
    for (const [colonna, valori] of [
      ['telefoni_norm', norm.telefoni_norm],
      ['email_norm', norm.email_norm],
    ] as const) {
      if (valori.length === 0) continue
      const { data, error } = await supabase
        .from('crm_schede')
        .select('id')
        .neq('scuola_id', sede)
        .is('anonimizzata_il', null)
        .overlaps(colonna, [...valori])
        .limit(1)
      if (error) throw error
      if ((data ?? []).length > 0) return true
    }
    return false
  } catch (err) {
    logEvento('crm', 'info', { operazione: OP_AUTO, esito: 'coincidenza-non-verificata', entita_id: domandaId }, err)
    return false
  }
}

async function collegaCoppie(
  supabase: SupabaseClient,
  p: {
    domandaId: string
    sede: string
    schedaId: string
    rifiutata: boolean
    bambini: BambinoLetto[]
    coppie: { bambinoId: string; figlio: number }[]
  },
): Promise<{ collegati: number; conflitti: string[] }> {
  let collegati = 0
  const conflitti: string[] = []
  for (const c of p.coppie) {
    const b = p.bambini.find((x) => x.id === c.bambinoId)
    if (!b) continue
    const ora = new Date().toISOString()
    // Un bambino già «iscritto» (a mano, o da un'altra via) conserva chi e quando l'ha segnato: prende
    // soltanto il collegamento. Gli altri diventano iscritti per mano del sistema.
    const esito =
      b.esito === 'iscritto'
        ? {}
        : {
            esito: 'iscritto',
            esito_origine: 'automatico',
            esito_da: null,
            esito_il: ora,
            // Una famiglia «persa» che poi si iscrive non ha più un motivo di perdita (resta nello storico).
            ...(b.esito === 'perso' ? { motivo_perdita: null, motivo_nota: null } : {}),
          }
    const { data, error } = await supabase
      .from('crm_bambini')
      .update({
        ...esito,
        domanda_id: p.domandaId,
        domanda_figlio: c.figlio,
        domanda_collegata_il: ora,
        da_verificare: p.rifiutata,
        nota_collegamento: p.rifiutata ? 'domanda_respinta' : null,
        aggiornata_il: ora,
      })
      .eq('id', b.id)
      .eq('scuola_id', p.sede)
      .eq('scheda_id', p.schedaId)
      .is('domanda_id', null)
      .select('id')
    if (error) {
      // 23505: quel figlio di quella domanda è già collegato a un altro bambino (la UNIQUE).
      if (codiceDi(error) === '23505') {
        conflitti.push(b.id)
        continue
      }
      throw error
    }
    if (!data || data.length === 0) continue
    collegati += 1
    await registraEvento(supabase, {
      schedaId: p.schedaId,
      scuolaId: p.sede,
      tipo: 'domanda_collegata_auto',
      autore: null,
      autoreVia: 'sistema',
      dati: { bambino_id: b.id, figlio: c.figlio, domanda_id: p.domandaId },
    })
    // La domanda poteva essere già stata importata: l'alunno c'è, e il bambino va agganciato.
    await agganciaSeImportata(supabase, { domandaId: p.domandaId, sede: p.sede, bambino: b, eseguitoDa: null, operazione: OP_AUTO })
  }
  return { collegati, conflitti }
}

/** «È arrivata una domanda: associa il bambino» su ciascuna scheda, più la riga di storico. L'ultima domanda arrivata vince. */
async function segnalaDaAssociare(
  supabase: SupabaseClient,
  sede: string,
  domandaId: string,
  schedaIds: string[],
): Promise<void> {
  for (const schedaId of schedaIds) {
    const { error } = await supabase
      .from('crm_schede')
      .update({ domanda_da_associare: domandaId, aggiornata_il: new Date().toISOString() })
      .eq('id', schedaId)
      .eq('scuola_id', sede)
    if (error) throw error
    await registraEvento(supabase, {
      schedaId,
      scuolaId: sede,
      tipo: 'domanda_da_associare',
      autore: null,
      autoreVia: 'sistema',
      dati: { domanda_id: domandaId },
    })
  }
}

/** La domanda parla di un bambino che ha già un'altra domanda: nota sul bambino (se libera) e riga di storico. */
async function segnalaAltraDomanda(
  supabase: SupabaseClient,
  p: { sede: string; schedaId: string; domandaId: string; bambiniIds: string[] },
): Promise<void> {
  for (const bambinoId of p.bambiniIds) {
    // La nota è un di più: se non si scrive, lo storico la racconta lo stesso. E non si sovrascrive una
    // nota già presente (una «domanda respinta» pesa di più).
    const { error } = await supabase
      .from('crm_bambini')
      .update({ nota_collegamento: 'altra_domanda', aggiornata_il: new Date().toISOString() })
      .eq('id', bambinoId)
      .eq('scuola_id', p.sede)
      .is('nota_collegamento', null)
    if (error) {
      logEvento('crm', 'error', { operazione: OP_AUTO, esito: 'nota-non-scritta', entita_id: p.domandaId }, error)
    }
    await registraEvento(supabase, {
      schedaId: p.schedaId,
      scuolaId: p.sede,
      tipo: 'altra_domanda',
      autore: null,
      autoreVia: 'sistema',
      dati: { bambino_id: bambinoId, domanda_id: p.domandaId },
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Domande respinte e domande cancellate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La domanda è stata respinta: i bambini che ci sono collegati restano iscritti sulla scheda ma vanno
 * verificati (`da_verificare`, nota `domanda_respinta`). **Non lancia MAI.**
 */
export async function segnalaDomandaRespinta(supabase: SupabaseClient, domandaId: string): Promise<void> {
  try {
    const { data: dom, error: eDom } = await supabase
      .from('enrollment_submissions')
      .select('id, scuola_id')
      .eq('id', domandaId)
      .maybeSingle()
    if (eDom) throw eDom
    const sede = typeof dom?.scuola_id === 'string' && dom.scuola_id !== '' ? dom.scuola_id : null
    if (!sede) {
      battito('respinta-senza-sede', domandaId)
      return
    }

    const { data, error } = await supabase
      .from('crm_bambini')
      .select('id, scheda_id, scuola_id')
      .eq('domanda_id', domandaId)
      .eq('scuola_id', sede)
    if (error) throw error
    const bambini = (data ?? []).filter((b) => stessaSede(b.scuola_id, sede))
    if (bambini.length === 0) {
      battito('respinta-nessun-bambino', domandaId, { scuola_id: sede })
      return
    }

    const { error: eUp } = await supabase
      .from('crm_bambini')
      .update({ da_verificare: true, nota_collegamento: 'domanda_respinta', aggiornata_il: new Date().toISOString() })
      .in(
        'id',
        bambini.map((b) => b.id as string),
      )
      .eq('scuola_id', sede)
      .eq('domanda_id', domandaId)
    if (eUp) throw eUp

    for (const b of bambini) {
      await registraEvento(supabase, {
        schedaId: b.scheda_id as string,
        scuolaId: sede,
        tipo: 'domanda_respinta',
        autore: null,
        autoreVia: 'sistema',
        dati: { bambino_id: b.id as string, domanda_id: domandaId },
      })
    }
    battito('respinta-segnalata', domandaId, { scuola_id: sede, n_bambini: bambini.length })
  } catch (err) {
    esitoDaEccezione(err, domandaId, OP_RESPINTA)
  }
}

/**
 * Da chiamare **prima** di cancellare delle domande (conservazione, oblio): lascia nello storico di ogni
 * scheda interessata la riga «collegamento tolto, domanda cancellata». Poi sarà il database ad azzerare
 * `domanda_id` (`ON DELETE SET NULL`); `domanda_collegata_il` resta a dire che una domanda c'era.
 * **Non lancia MAI**: chi cancella non deve fermarsi per lo storico del CRM.
 */
export async function segnalaDomandeCancellate(supabase: SupabaseClient, domandaIds: string[]): Promise<void> {
  if (domandaIds.length === 0) return
  try {
    let segnalati = 0
    for (let i = 0; i < domandaIds.length; i += BLOCCO_ID) {
      const blocco = domandaIds.slice(i, i + BLOCCO_ID)
      // Gli id sono di domande scelte dal chiamante (mai dal client); la sede dell'evento è quella della
      // scheda del bambino, che la riga porta con sé.
      const { data, error } = await supabase
        .from('crm_bambini')
        .select('id, scheda_id, scuola_id')
        .in('domanda_id', blocco)
      if (error) throw error
      for (const b of data ?? []) {
        if (typeof b.scuola_id !== 'string') continue
        await registraEvento(supabase, {
          schedaId: b.scheda_id as string,
          scuolaId: b.scuola_id,
          tipo: 'collegamento_tolto',
          autore: null,
          autoreVia: 'sistema',
          dati: { bambino_id: b.id as string, motivo: 'domanda_cancellata' },
        })
        segnalati += 1
      }
    }
    logEvento('crm', 'info', { esito: 'cancellate-segnalate', operazione: OP_CANCELLATE, n_domande: domandaIds.length, n_bambini: segnalati })
  } catch (err) {
    if (TABELLA_ASSENTE.has(codiceDi(err))) {
      logEvento('crm', 'warn', { operazione: OP_CANCELLATE, esito: 'schema-crm-assente' }, err)
      return
    }
    logEvento('crm', 'error', { operazione: OP_CANCELLATE, esito: 'errore', n_domande: domandaIds.length }, err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// La segreteria collega e scollega a mano
// ─────────────────────────────────────────────────────────────────────────────

/** Lo spegnimento dell'avviso «è arrivata una domanda» se riguardava QUELLA domanda. Un guasto qui si registra e basta. */
async function spegniAvviso(supabase: SupabaseClient, schedaId: string, sede: string, domandaId: string, operazione: string): Promise<void> {
  const { error } = await supabase
    .from('crm_schede')
    .update({ domanda_da_associare: null, aggiornata_il: new Date().toISOString() })
    .eq('id', schedaId)
    .eq('scuola_id', sede)
    .eq('domanda_da_associare', domandaId)
  if (error) logEvento('crm', 'error', { operazione, esito: 'avviso-non-spento', entita_id: schedaId }, error)
}

/**
 * La segreteria sceglie «questo figlio di questa domanda è questo bambino». Torna `null` se è fatto,
 * altrimenti la risposta d'errore già pronta. Si verificano TUTTI e tre: il bambino (della scheda e della
 * sede), la domanda (della stessa sede) e il figlio (c'è nella domanda).
 */
export async function collegaAMano(
  supabase: SupabaseClient,
  a: { schedaId: string; scuolaId: string; bambinoId: string; domandaId: string; figlio: number; autore: string },
): Promise<NextResponse | null> {
  const { data: b, error: eB } = await supabase
    .from('crm_bambini')
    .select('id, scheda_id, scuola_id, esito, domanda_id, nome, data_nascita')
    .eq('id', a.bambinoId)
    .eq('scheda_id', a.schedaId)
    .eq('scuola_id', a.scuolaId)
    .maybeSingle()
  if (eB) return rispostaErroreDb(eB, OP_MANO)
  if (!b) return schedaNonTrovata()
  if (b.domanda_id != null) {
    return statoNonAmmesso('Questo bambino ha già una domanda collegata: scollegala prima di sceglierne un’altra.')
  }

  const { data: dom, error: eD } = await supabase
    .from('enrollment_submissions')
    .select('id, scuola_id, status, data')
    .eq('id', a.domandaId)
    .maybeSingle()
  if (eD) return rispostaErroreDb(eD, OP_MANO)
  if (!dom) return domandaNonApribile(404, 'Domanda non trovata.')
  if (!stessaSede(dom.scuola_id, a.scuolaId)) {
    logEvento('multi_sede', 'warn', {
      operazione: OP_MANO,
      esito: 'domanda-fuori-sede',
      entita_id: a.domandaId,
      sede_id: a.scuolaId,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }
  if (!estraiDaDomanda(dom.data).figli.some((f) => f.indice === a.figlio)) {
    return domandaNonApribile(400, 'Il figlio indicato non fa parte di questa domanda.')
  }

  const rifiutata = dom.status === 'rejected'
  const ora = new Date().toISOString()
  const esito =
    b.esito === 'iscritto'
      ? {}
      : {
          esito: 'iscritto',
          esito_origine: 'manuale',
          esito_da: a.autore,
          esito_il: ora,
          ...(b.esito === 'perso' ? { motivo_perdita: null, motivo_nota: null } : {}),
        }
  const { data: aggiornati, error: eUp } = await supabase
    .from('crm_bambini')
    .update({
      ...esito,
      domanda_id: a.domandaId,
      domanda_figlio: a.figlio,
      domanda_collegata_il: ora,
      da_verificare: rifiutata,
      nota_collegamento: rifiutata ? 'domanda_respinta' : null,
      aggiornata_il: ora,
    })
    .eq('id', a.bambinoId)
    .eq('scheda_id', a.schedaId)
    .eq('scuola_id', a.scuolaId)
    .is('domanda_id', null)
    .select('id')
  // 23505 → 409 GIA_COLLEGATO (quel figlio è già di un altro bambino); il resto lo spiega rispostaErroreDb.
  if (eUp) return rispostaErroreDb(eUp, OP_MANO)
  // Nessuna riga toccata: nel frattempo un'altra segretaria ha collegato questo bambino.
  if (!aggiornati || aggiornati.length === 0) {
    return statoNonAmmesso('Nel frattempo questo bambino è stato collegato a una domanda. Aggiorna la pagina.')
  }

  await registraEvento(supabase, {
    schedaId: a.schedaId,
    scuolaId: a.scuolaId,
    tipo: 'domanda_collegata_mano',
    autore: a.autore,
    autoreVia: 'segreteria',
    dati: { bambino_id: a.bambinoId, figlio: a.figlio, domanda_id: a.domandaId },
  })
  await spegniAvviso(supabase, a.schedaId, a.scuolaId, a.domandaId, OP_MANO)
  logEvento('crm', 'info', { esito: 'collegata-a-mano', entita_id: a.domandaId, scuola_id: a.scuolaId })
  // La domanda poteva essere già stata importata: l'alunno c'è, e il bambino va agganciato (a nome di chi ha collegato).
  await agganciaSeImportata(supabase, {
    domandaId: a.domandaId,
    sede: a.scuolaId,
    bambino: { id: a.bambinoId, nome: typeof b.nome === 'string' ? b.nome : null, data_nascita: typeof b.data_nascita === 'string' ? b.data_nascita : null },
    eseguitoDa: a.autore,
    operazione: OP_MANO,
  })
  return null
}

/**
 * Toglie il collegamento fra un bambino e la sua domanda. L'esito del bambino NON cambia: se era iscritto
 * resta iscritto (lo decide la segreteria, da un'altra parte). Torna `null` se è fatto.
 */
export async function scollega(
  supabase: SupabaseClient,
  a: { schedaId: string; scuolaId: string; bambinoId: string; autore: string },
): Promise<NextResponse | null> {
  const { data: b, error: eB } = await supabase
    .from('crm_bambini')
    .select('id, scheda_id, scuola_id, domanda_id, domanda_collegata_il')
    .eq('id', a.bambinoId)
    .eq('scheda_id', a.schedaId)
    .eq('scuola_id', a.scuolaId)
    .maybeSingle()
  if (eB) return rispostaErroreDb(eB, OP_SCOLLEGA)
  if (!b) return schedaNonTrovata()
  if (b.domanda_id == null && b.domanda_collegata_il == null) {
    return statoNonAmmesso('Questo bambino non ha nessuna domanda collegata.')
  }

  const { error: eUp } = await supabase
    .from('crm_bambini')
    .update({
      domanda_id: null,
      domanda_figlio: null,
      domanda_collegata_il: null,
      da_verificare: false,
      nota_collegamento: null,
      aggiornata_il: new Date().toISOString(),
    })
    .eq('id', a.bambinoId)
    .eq('scheda_id', a.schedaId)
    .eq('scuola_id', a.scuolaId)
  if (eUp) return rispostaErroreDb(eUp, OP_SCOLLEGA)

  const domandaPrima = typeof b.domanda_id === 'string' ? b.domanda_id : null
  await registraEvento(supabase, {
    schedaId: a.schedaId,
    scuolaId: a.scuolaId,
    tipo: 'collegamento_tolto',
    autore: a.autore,
    autoreVia: 'segreteria',
    dati: { bambino_id: a.bambinoId, motivo: 'scollegata_a_mano', domanda_id: domandaPrima },
  })
  if (domandaPrima) await spegniAvviso(supabase, a.schedaId, a.scuolaId, domandaPrima, OP_SCOLLEGA)
  logEvento('crm', 'info', { esito: 'scollegata', entita_id: a.bambinoId, scuola_id: a.scuolaId })
  return null
}
